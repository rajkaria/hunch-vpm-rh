/**
 * vpm_market_book — the book, the headroom, the implied odds and the time left.
 *
 * The tool exists because in this venue "what are the odds" is not enough to decide
 * with. A stake is accepted only up to the room the opposing books have to cover it, so
 * the second question — "how much of my stake would actually land" — has to be answered
 * in the same call, and is, by `stake`.
 */

import {
  acceptanceOf,
  bestOutcomeToStake,
  capacityToAccept,
  oddsFromBooks,
  type BookState,
  type HeadroomPick,
  type MarketState,
  type OddsRow,
} from "../domain.js";
import { ToolError } from "../errors.js";
import {
  decimalOdds,
  formatPercent,
  formatRelative,
  isUnbounded,
  money,
  parseUsdc,
  renderTable,
  shortAddress,
  toIso,
} from "../format.js";
import { defineTool, type ToolDeps, type ToolPayload } from "../tool.js";

interface MarketBookInput {
  readonly marketId: string | number;
  readonly stake?: string;
  readonly includeCounterparties?: boolean;
}

export const marketBookTool = defineTool<MarketBookInput>({
  name: "vpm_market_book",
  title: "Market book, headroom and time to freeze",
  description: [
    "Read one Hunch VPM market on Arc: accepted principal per outcome (the book), the headroom each book still has to accept stake, implied probabilities derived from that principal rather than from a quoted price, and how long until the market freezes.",
    "Reach for this BEFORE staking anything. This venue is a vested parimutuel: a stake vests into the opposing books the moment it lands and is accepted only up to the capacity those books have to cover it, so part of an entry can be refused and refunded. 'What are the odds' is not enough to decide with here — pass `stake` and the tool reports how much of that amount each outcome would accept right now.",
    "Also use it to check whether a market is still open, how close the freeze is, and where the crowd's money actually sits. Read-only: it never signs or sends anything.",
  ].join("\n\n"),
  inputSchema: {
    type: "object",
    title: "vpm_market_book input",
    properties: {
      marketId: {
        type: ["string", "integer"],
        description:
          "The market's id on the settler (e.g. 7), or the subgraph's composite id (e.g. \"0x1f9…c2-7\"). Both are accepted.",
        examples: ["7", "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984-7"],
      },
      stake: {
        type: "string",
        pattern: "^\\d+(\\.\\d{1,6})?$",
        description:
          "Optional. A USDC amount you are considering staking, as a decimal string (\"250\", \"250.5\"). The response then reports, per outcome, how much of it would be accepted and how much refused. USDC has 6 decimals; more precision than that is rejected rather than rounded.",
        examples: ["250", "1000.5"],
      },
      includeCounterparties: {
        type: "boolean",
        default: false,
        description:
          "Optional. Include an ERC-8004 trust summary of the wallets already in the book. Costs an extra read; set it when you are sizing a position against a specific crowd rather than just checking the price.",
      },
    },
    required: ["marketId"],
    additionalProperties: false,
  },
  async run(input, deps): Promise<ToolPayload> {
    const marketId = String(input.marketId).trim();
    if (marketId === "") {
      throw new ToolError("invalid_input", "marketId is empty.", { hint: "Pass the market's numeric id, e.g. 7." });
    }

    const offered = input.stake === undefined ? undefined : parseStake(input.stake);
    const market = await deps.venue.marketState(marketId);
    const odds = await resolveOdds(deps, marketId, market);

    const now = deps.now();
    const secondsToFreeze = market.resolutionTime - now;
    const frozen = market.status !== "open" || secondsToFreeze <= 0;

    const notes: string[] = [];
    if (odds.source === "derived") notes.push(odds.note);

    const rows = market.books.map((book) => buildRow(book, odds, market));
    // A market that takes no stake has no "where is the room" answer worth a round trip.
    const bestFromClient = frozen ? undefined : await attemptBestHeadroom(deps, marketId, notes);
    const best = frozen ? undefined : bestFromClient ?? bestOutcomeToStake(market.books);

    const settlerKind = classifySettler(deps, market);
    if (settlerKind === "classic") {
      notes.push(
        "This market runs on ClassicParimutuel: every unit pays the same multiple whatever time it arrived, and nothing is refused for want of headroom.",
      );
    }

    const stakeCheck =
      offered === undefined ? undefined : buildStakeCheck(market.books, offered, frozen ? frozenReason(market, secondsToFreeze) : undefined);

    const counterparties = input.includeCounterparties === true ? await readCounterparties(deps, marketId, notes) : undefined;

    return {
      summary: renderSummary({ market, rows, best, frozen, secondsToFreeze, stakeCheck, counterparties, notes, settlerKind, deps }),
      data: {
        market: {
          id: market.id,
          question: market.question,
          settler: market.settler,
          settlerKind,
          chain: { id: deps.config.chainId, name: deps.config.chainName, stakeAsset: deps.config.usdcAddress },
          status: market.status,
          frozen,
          kappa: isUnbounded(market.kappa) ? "unbounded" : market.kappa.toString(),
          resolutionTime: {
            unix: market.resolutionTime,
            iso: toIso(market.resolutionTime),
            secondsAway: secondsToFreeze,
            relative: formatRelative(secondsToFreeze),
          },
          acceptedPool: money(market.acceptedPool),
          winner: market.winner,
        },
        outcomes: rows.map((row) => ({
          index: row.index,
          label: row.label,
          principal: money(row.book.principal),
          vested: money(row.book.vested),
          capacity: money(row.book.capacity),
          headroom: money(row.book.headroom),
          acceptsStakeUpTo: money(row.capacity),
          acceptsStakeLimitedBy: row.limitedBy,
          impliedProbability: row.probability,
          impliedProbabilityDisplay: formatPercent(row.probability),
          decimalOdds: decimalOdds(row.probability),
        })),
        bestHeadroom:
          best === undefined
            ? null
            : {
                index: best.index,
                label: best.label,
                acceptsStakeUpTo: money(best.acceptsUpTo),
                source: bestFromClient === undefined ? "derived" : "client",
              },
        stakeCheck:
          stakeCheck === undefined
            ? null
            : {
                offered: money(stakeCheck.offered),
                // False means `enter` reverts, not that a smaller amount would land.
                enterable: stakeCheck.blocked === undefined,
                notEnterableBecause: stakeCheck.blocked ?? null,
                perOutcome: stakeCheck.rows.map((row) => ({
                  index: row.outcome,
                  label: row.label,
                  accepted: money(row.accepted),
                  refused: money(row.refused),
                  fullyAccepted: row.refused === 0n,
                  limitedByOutcome: row.limitedBy,
                })),
                caveat:
                  stakeCheck.blocked === undefined
                    ? "Upper bound. Entries landing in the same block share the same headroom pro rata, and headroom moves as vintages finalize."
                    : "No acceptance is reported because none is possible: the settler reverts instead of accepting a smaller amount.",
              },
        counterparties: counterparties ?? null,
        notes,
      },
    };
  },
});

interface Row {
  readonly index: number;
  readonly label: string;
  readonly book: BookState;
  readonly probability: number;
  readonly capacity: bigint;
  readonly limitedBy: number | undefined;
}

function buildRow(book: BookState, odds: { rows: OddsRow[] }, market: MarketState): Row {
  const row = odds.rows.find((entry) => entry.index === book.index);
  const capacity = capacityToAccept(market.books, book.index);
  return {
    index: book.index,
    label: book.label ?? row?.label ?? `outcome ${book.index}`,
    book,
    probability: row?.impliedProbability ?? 0,
    capacity: capacity.amount,
    limitedBy: capacity.limitedBy,
  };
}

function parseStake(raw: string): bigint {
  let parsed: bigint;
  try {
    parsed = parseUsdc(raw);
  } catch (thrown) {
    throw new ToolError("invalid_input", thrown instanceof Error ? thrown.message : String(thrown), {
      hint: 'Pass USDC as a plain decimal string, e.g. "250" or "250.5".',
      detail: { field: "stake", value: raw },
    });
  }
  if (parsed <= 0n) {
    throw new ToolError("invalid_input", "stake must be greater than zero.", { detail: { field: "stake", value: raw } });
  }
  return parsed;
}

/**
 * The client's implied odds are preferred because the mapping derives them from the same
 * data the settler settles on. When that read fails the numbers are recomputed from the
 * book — the identical formula, p_w = P_w / Π — and the response says so rather than
 * quietly presenting a fallback as the source of truth.
 */
async function resolveOdds(
  deps: ToolDeps,
  marketId: string,
  market: MarketState,
): Promise<{ rows: OddsRow[]; source: "client" | "derived"; note: string }> {
  try {
    const rows = await deps.venue.odds(marketId);
    if (rows.length > 0) return { rows, source: "client", note: "" };
    return {
      rows: oddsFromBooks(market.books),
      source: "derived",
      note: "Implied odds were derived from accepted principal: the client returned none.",
    };
  } catch (thrown) {
    return {
      rows: oddsFromBooks(market.books),
      source: "derived",
      note: `Implied odds were derived from accepted principal: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    };
  }
}

/**
 * The client's answer is preferred because it also sees the stake queued against each
 * book in the current block. A failure is survivable — the same question is answerable
 * from the book we already hold — but it is not free: the two can disagree, so the
 * fallback is declared rather than swallowed.
 */
async function attemptBestHeadroom(deps: ToolDeps, marketId: string, notes: string[]): Promise<HeadroomPick | undefined> {
  try {
    return await deps.venue.bestHeadroom(marketId);
  } catch (thrown) {
    notes.push(
      `Which outcome has the most room was derived from the book: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
    return undefined;
  }
}

/** Why no entry can be accepted right now, in the words the response will use. */
function frozenReason(market: MarketState, secondsToFreeze: number): string {
  if (market.status === "resolved") return `the market is resolved (outcome ${market.winner ?? "?"} won)`;
  if (market.status === "voided") return "the market is voided";
  return `the market froze ${formatRelative(secondsToFreeze)}`;
}

/**
 * What the books would do with `offered`. When `blocked` is set the settler refuses the
 * entry outright — `enter` reverts with NotOpen or Frozen — so answering "2,000 of your
 * 2,500 would be accepted" would be answering a question about a transaction that cannot
 * be sent. Nothing is reported per outcome in that case.
 */
function buildStakeCheck(books: readonly BookState[], offered: bigint, blocked: string | undefined) {
  return {
    offered,
    blocked,
    rows: blocked === undefined ? books.map((book) => acceptanceOf(books, book.index, offered)) : [],
  };
}

async function readCounterparties(deps: ToolDeps, marketId: string, notes: string[]) {
  try {
    const trust = await deps.venue.counterpartyTrust(marketId);
    // Whatever the trust read could not answer belongs in the response, not in a silence
    // that reads as "nobody is on the other side".
    for (const note of trust.notes) notes.push(note);
    return {
      registeredShare: trust.registeredShare,
      humanBackedShare: trust.humanBackedShare,
      wallets: trust.counterparties.map((party) => ({
        wallet: party.wallet,
        outcome: party.outcome,
        stake: party.stake === undefined ? null : money(party.stake),
        share: party.share,
        agentId: party.agentId,
        humanBacked: party.humanBacked,
        feedbackCount: party.feedbackCount,
        score: party.score,
      })),
    };
  } catch (thrown) {
    notes.push(`Counterparty trust was requested but could not be read: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    return undefined;
  }
}

function classifySettler(deps: ToolDeps, market: MarketState): "vested" | "classic" | "unknown" {
  const settler = market.settler?.toLowerCase();
  if (settler === undefined) return "unknown";
  if (settler === deps.config.settlerAddress) return "vested";
  if (deps.config.classicSettlerAddress !== undefined && settler === deps.config.classicSettlerAddress) return "classic";
  return "unknown";
}

function renderSummary(context: {
  market: MarketState;
  rows: Row[];
  best: HeadroomPick | undefined;
  frozen: boolean;
  secondsToFreeze: number;
  stakeCheck: { offered: bigint; blocked: string | undefined; rows: ReturnType<typeof acceptanceOf>[] } | undefined;
  counterparties: { registeredShare: number | undefined; humanBackedShare: number | undefined; wallets: unknown[] } | undefined;
  notes: string[];
  settlerKind: string;
  deps: ToolDeps;
}): string {
  const { market, rows, best, frozen, secondsToFreeze, stakeCheck, counterparties, notes, deps } = context;
  const lines: string[] = [];

  const title = market.question === undefined ? `Market ${market.id}` : `Market ${market.id} — ${market.question}`;
  lines.push(`${title} (${deps.config.chainName}${market.settler === undefined ? "" : `, settler ${shortAddress(market.settler)}`}).`);

  if (market.status === "resolved") {
    lines.push(`Resolved; outcome ${market.winner ?? "?"} won. Nothing can be entered. Use vpm_claimable to pull what is owed.`);
  } else if (market.status === "voided") {
    lines.push("Voided. Every position refunds at its accepted principal — pull it with vpm_claimable.");
  } else if (frozen) {
    lines.push(`Frozen ${formatRelative(secondsToFreeze)} and awaiting resolution. Entries are refused from the freeze onward.`);
  } else {
    lines.push(`Open, freezes ${formatRelative(secondsToFreeze)} (${toIso(market.resolutionTime)}).`);
  }

  lines.push(
    `Accepted pool ${money(market.acceptedPool).display}, κ ${isUnbounded(market.kappa) ? "unbounded" : market.kappa.toString()}.`,
  );
  lines.push("");
  lines.push(
    renderTable(
      ["#", "outcome", "book", "implied", "headroom", "accepts up to"],
      rows.map((row) => [
        String(row.index),
        row.label,
        money(row.book.principal).display,
        formatPercent(row.probability),
        money(row.book.headroom).display,
        money(row.capacity).display,
      ]),
    ),
  );
  lines.push("");
  lines.push(
    "`headroom` is what that book can still take from the other side. `accepts up to` is what a stake ON that outcome can have accepted right now — the smallest opposing headroom — and anything above it is refused and refunded.",
  );

  if (best !== undefined) {
    lines.push(
      `Most room for new stake: ${best.label ?? `outcome ${best.index}`} — it can have ${money(best.acceptsUpTo).display} accepted right now.`,
    );
  }

  if (stakeCheck !== undefined) {
    lines.push("");
    if (stakeCheck.blocked !== undefined) {
      lines.push(
        `A ${money(stakeCheck.offered).display} stake cannot be entered at all: ${stakeCheck.blocked}. The settler reverts rather than accepting part of it.`,
      );
    } else {
      lines.push(`A ${money(stakeCheck.offered).display} stake right now:`);
      for (const row of stakeCheck.rows) {
        const label = row.label ?? `outcome ${row.outcome}`;
        if (row.refused === 0n) {
          lines.push(`  ${label}: accepted in full.`);
        } else if (row.accepted === 0n) {
          lines.push(`  ${label}: refused in full — outcome ${row.limitedBy ?? "?"} has no headroom left. The whole stake would be refunded.`);
        } else {
          lines.push(
            `  ${label}: ${money(row.accepted).display} accepted, ${money(row.refused).display} refused and refundable (capped by outcome ${row.limitedBy ?? "?"}).`,
          );
        }
      }
      lines.push("Upper bound: entries in the same block share headroom pro rata.");
    }
  }

  if (counterparties !== undefined) {
    const shares: string[] = [];
    if (counterparties.registeredShare !== undefined) {
      shares.push(`${formatPercent(counterparties.registeredShare)} of their stake held by ERC-8004 registered wallets`);
    }
    if (counterparties.humanBackedShare !== undefined) {
      shares.push(`${formatPercent(counterparties.humanBackedShare)} human-backed`);
    }
    lines.push("");
    lines.push(
      `Counterparties: ${counterparties.wallets.length} wallet(s) in the book${shares.length === 0 ? "" : `, ${shares.join(", ")}`}. Use vpm_agent_reputation for any one of them.`,
    );
  }

  if (notes.length > 0) {
    lines.push("");
    for (const note of notes) lines.push(`Note: ${note}`);
  }

  return lines.join("\n");
}
