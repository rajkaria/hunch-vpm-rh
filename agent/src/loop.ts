/**
 * research -> decide -> enter -> monitor -> claim.
 *
 * The loop holds no policy of its own except one: it does not average into a market it
 * already holds. Sizing happens once, on the information available at the time, and a
 * second entry in the same market would be a second decision dressed up as the first.
 * Everything else it does is `decide`'s answer, carried out.
 */

import type { NanopaymentChannel, NanopaymentSettlement } from "./circle/types.js";
import type { AgentWallet } from "./circle/types.js";
import type { ClaimablePosition, MarketSnapshot, OutcomeEstimate, PositionSnapshot } from "./domain/types.js";
import { estimateFromFeed } from "./intel/estimate.js";
import type { FeedQuote, IntelProvider } from "./intel/types.js";
import type { Logger } from "./log.js";
import type { PolicyConfig } from "./policy/config.js";
import { decide } from "./policy/decide.js";
import type { Decision } from "./policy/decide.js";
import type { Clock, ClaimReceipt, EnterReceipt, ResearchSource, Venue } from "./research/source.js";

export interface LoopDeps {
  readonly source: ResearchSource;
  readonly venue: Venue;
  readonly wallet: AgentWallet;
  readonly channel: NanopaymentChannel;
  readonly intel: IntelProvider;
  readonly policy: PolicyConfig;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface MarketResearch {
  readonly market: MarketSnapshot;
  readonly quote: FeedQuote | undefined;
  readonly estimate: OutcomeEstimate | undefined;
  /** Why there is no estimate, when there is none. */
  readonly note: string | undefined;
}

export interface ResearchReport {
  readonly at: number;
  readonly markets: readonly MarketResearch[];
  /** Paid calls made in this round. */
  readonly quotesBought: number;
  /** What those calls authorized, in micro-USDC. Not yet settled. */
  readonly authorizedMicroUsdc: bigint;
}

/**
 * One research round: read every market, buy one quote per distinct feed, and turn each
 * quote into the agent's own probability.
 *
 * Quotes are bought per feed, not per market, because two markets on the same feed are
 * two questions about one observation. That is a real saving even at nanopayment prices,
 * and more importantly it keeps the two markets' estimates consistent with each other.
 */
export async function research(deps: LoopDeps): Promise<ResearchReport> {
  const now = deps.clock.now();
  const markets = await deps.source.listMarkets();
  const quotes = new Map<string, FeedQuote>();
  const failures = new Map<string, string>();
  let bought = 0;
  const before = deps.channel.totalAuthorizedMicroUsdc();

  for (const market of markets) {
    // Do not pay for data the agent cannot act on: a settled market takes no stake.
    if (market.status !== "open") continue;
    const key = market.spec.feedKey;
    if (quotes.has(key) || failures.has(key)) continue;
    try {
      quotes.set(key, await deps.intel.quote(key));
      bought += 1;
    } catch (cause) {
      failures.set(key, String(cause));
      deps.logger.warn(`no quote for ${key}: ${String(cause)}`);
    }
  }

  const rows: MarketResearch[] = markets.map((market) => {
    // A settled market gets no estimate even when a quote for its feed happens to be in
    // hand because another market shares it. Pricing a question that is already answered
    // would put a number in the report that means nothing.
    if (market.status !== "open") {
      return { market, quote: undefined, estimate: undefined, note: `market is ${market.status}` };
    }
    const quote = quotes.get(market.spec.feedKey);
    if (quote === undefined) {
      return {
        market,
        quote: undefined,
        estimate: undefined,
        note: failures.get(market.spec.feedKey) ?? "no quote",
      };
    }
    const estimate = estimateFromFeed(market, quote, now);
    return {
      market,
      quote,
      estimate,
      note: estimate === undefined ? reasonForNoEstimate(market, quote, now) : undefined,
    };
  });

  return {
    at: now,
    markets: rows,
    quotesBought: bought,
    authorizedMicroUsdc: deps.channel.totalAuthorizedMicroUsdc() - before,
  };
}

function reasonForNoEstimate(market: MarketSnapshot, quote: FeedQuote, now: number): string {
  if (market.books.length !== 2) {
    return `${String(market.books.length)}-way market: the digital model prices one threshold`;
  }
  const age = Math.max(0, now - quote.observedAt);
  if (age > market.spec.maxStaleness) {
    return `reading is ${String(age)}s old, past this market's ${String(market.spec.maxStaleness)}s bound`;
  }
  return "no estimate";
}

/** Run the decision procedure over a research report. Pure, given the report. */
export function decideAll(
  report: ResearchReport,
  bankroll: bigint,
  policy: PolicyConfig,
  held: ReadonlySet<string> = new Set(),
): readonly Decision[] {
  return report.markets
    .filter((row) => !held.has(row.market.marketId))
    .map((row) =>
      decide({ market: row.market, estimate: row.estimate, bankroll, now: report.at, policy }),
    );
}

export interface RunOptions {
  readonly rounds: number;
  /** Simulated seconds to advance between rounds. Zero in live mode. */
  readonly advanceSeconds: number;
  /** Called after the clock advances, so a simulated venue can move too. */
  readonly onAdvance: ((seconds: number) => void) | undefined;
  /** Wait between rounds. Zero in the demo and in tests. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly intervalMs: number;
  /** Decide and report, but send nothing. */
  readonly readOnly: boolean;
}

export interface RoundResult {
  readonly round: number;
  readonly report: ResearchReport;
  readonly decisions: readonly Decision[];
  readonly entries: readonly EnterReceipt[];
  readonly positions: readonly PositionSnapshot[];
}

export interface LoopResult {
  readonly rounds: readonly RoundResult[];
  readonly claims: readonly ClaimReceipt[];
  readonly settlement: NanopaymentSettlement;
  readonly openingBalance: bigint;
  readonly closingBalance: bigint;
  readonly quotesBought: number;
}

export async function runLoop(deps: LoopDeps, options: RunOptions): Promise<LoopResult> {
  const openingBalance = await deps.wallet.balance();
  const held = new Set<string>();
  const positionIds: string[] = [];
  const rounds: RoundResult[] = [];
  let quotesBought = 0;

  for (let round = 1; round <= options.rounds; round += 1) {
    const report = await research(deps);
    quotesBought += report.quotesBought;
    const bankroll = await deps.wallet.balance();
    const decisions = decideAll(report, bankroll, deps.policy, held);

    const entries: EnterReceipt[] = [];
    if (!options.readOnly) {
      // Best edge first: if the bankroll runs out, it runs out on the weakest idea.
      const wanted = decisions
        .filter((d) => d.action === "enter" && d.stake !== undefined && d.outcome !== undefined)
        .sort((a, b) => bestEdge(b) - bestEdge(a));

      for (const decision of wanted) {
        const stake = decision.stake as bigint;
        const outcome = decision.outcome as number;
        if ((await deps.wallet.balance()) < stake) {
          deps.logger.warn(`${decision.marketId}: bankroll ran out before this entry`);
          continue;
        }
        const market = report.markets.find((r) => r.market.marketId === decision.marketId)?.market;
        if (market === undefined) continue;
        const receipt = await deps.venue.enter(market, outcome, stake);
        entries.push(receipt);
        held.add(decision.marketId);
        if (receipt.positionId !== undefined) positionIds.push(receipt.positionId);
      }
    }

    // Monitor: what the positions already held have accrued. In a classic pool this
    // number would not exist.
    const positions: PositionSnapshot[] = [];
    for (const id of positionIds) {
      const snapshot = await deps.source.position(id);
      if (snapshot !== undefined) positions.push(snapshot);
    }

    rounds.push({ round, report, decisions, entries, positions });

    if (round < options.rounds) {
      if (options.advanceSeconds > 0) {
        deps.clock.advance(options.advanceSeconds);
        options.onAdvance?.(options.advanceSeconds);
      }
      if (options.intervalMs > 0) await options.sleep(options.intervalMs);
    }
  }

  // One on-chain payment for every quote bought across every round.
  const settlement = await deps.channel.settle();
  const claims = options.readOnly ? [] : await claimAll(deps);
  const closingBalance = await deps.wallet.balance();

  return { rounds, claims, settlement, openingBalance, closingBalance, quotesBought };
}

/** Settle everything a resolved or voided market owes this wallet. */
export async function claimAll(deps: LoopDeps): Promise<readonly ClaimReceipt[]> {
  const wallet = await deps.wallet.address();
  const outstanding: readonly ClaimablePosition[] = await deps.source.claimable(wallet);
  const receipts: ClaimReceipt[] = [];
  for (const position of outstanding) {
    receipts.push(await deps.venue.claim(position));
  }
  return receipts;
}

function bestEdge(decision: Decision): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const c of decision.candidates) {
    if (c.rejection === undefined && c.effectiveEdge > best) best = c.effectiveEdge;
  }
  return best;
}
