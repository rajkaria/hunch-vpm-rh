/**
 * vpm_claimable — everything a wallet can pull right now.
 *
 * The venue is pull-based: a settled payout, a refused remainder and a voided market's
 * refund all sit in escrow until someone sends a transaction for them. So the response
 * is not just a number — it carries the exact call to make for each item, and says
 * plainly that the agent signs those calls itself.
 */

import type { ClaimableItem, ClaimKind, VestingEarned } from "../domain.js";
import { ToolError } from "../errors.js";
import { isAddress, money, normalizeAddress, renderTable, shortAddress, type MoneyView } from "../format.js";
import { defineTool, type ToolDeps, type ToolPayload } from "../tool.js";

interface ClaimableInput {
  readonly wallet: string;
  readonly explainVesting?: boolean;
}

/**
 * Every paying call on the settler takes one uint256.
 *
 * The argument is the settler's own numeric index, NOT the index's composite id, and the
 * source is expected to hand it over with the item. The alias below is only the fallback
 * for a source that names a kind without naming the call.
 */
const SIGNATURES: Record<string, string> = {
  claim: "claim(uint256)",
  withdrawRefund: "withdrawRefund(uint256)",
  claimResidue: "claimResidue(uint256)",
};

/**
 * Which settler function pays each kind of claim. `claim` also pays out any refused
 * remainder still outstanding, so a position with both only needs the one call.
 */
const CALL_FOR: Record<ClaimKind, { method: string; argument: "positionId" | "marketId" } | undefined> = {
  payout: { method: "claim", argument: "positionId" },
  void_refund: { method: "claim", argument: "positionId" },
  refund: { method: "withdrawRefund", argument: "positionId" },
  residue: { method: "claimResidue", argument: "marketId" },
  unknown: undefined,
};

const KIND_LABEL: Record<ClaimKind, string> = {
  payout: "settled payout",
  refund: "refused remainder",
  void_refund: "void refund",
  residue: "residue",
  unknown: "claimable",
};

export const claimableTool = defineTool<ClaimableInput>({
  name: "vpm_claimable",
  title: "Everything a wallet can pull right now",
  description: [
    "List everything one wallet can withdraw from the Hunch VPM venue right now: settled payouts on resolved markets, refunds of stake that was refused for want of headroom, refunds from voided markets, and residue if the wallet is a market's residue owner. Each item comes with the exact contract call that pays it.",
    "Reach for this after a market you hold resolves, after an entry was only partially accepted (the refused part is refundable immediately, without waiting for resolution), or as a periodic sweep. The venue never pushes funds: nothing reaches the wallet until one of these calls is signed and sent.",
    "This tool is read-only. It reports the calls; it does not make them, and it never has access to a key.",
  ].join("\n\n"),
  inputSchema: {
    type: "object",
    title: "vpm_claimable input",
    properties: {
      wallet: {
        type: "string",
        pattern: "^0x[0-9a-fA-F]{40}$",
        description: "The wallet to check, 20 bytes of hex. Case does not matter.",
        examples: ["0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"],
      },
      explainVesting: {
        type: "boolean",
        default: true,
        description:
          "Annotate each claimable position with how much of it is vesting earned from stake that arrived later, rather than the principal originally staked. Costs one extra read per position, capped by HUNCH_VPM_MAX_POSITION_LOOKUPS. Set false when you only need the totals.",
      },
    },
    required: ["wallet"],
    additionalProperties: false,
  },
  async run(input, deps): Promise<ToolPayload> {
    const wallet = normalizeAddress(String(input.wallet ?? ""));
    if (!isAddress(wallet)) {
      throw new ToolError("invalid_input", `"${input.wallet}" is not a 20-byte hex address.`, {
        hint: "Pass a full address, e.g. 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.",
        detail: { field: "wallet" },
      });
    }

    const summary = await deps.venue.claimable(wallet);
    const notes: string[] = [];
    const vesting =
      input.explainVesting === false ? new Map<string, VestingEarned>() : await readVesting(summary.items, deps, notes);

    const items = summary.items.map((item) => describeItem(item, deps, vesting));

    return {
      summary: renderSummary(wallet, summary.total, items, notes),
      data: {
        wallet,
        chain: { id: deps.config.chainId, name: deps.config.chainName, stakeAsset: deps.config.usdcAddress },
        total: money(summary.total),
        count: items.length,
        items,
        howToPull:
          "Each item names the contract, the function and the argument. Build and sign those transactions with your own wallet; gas on Arc is paid in USDC, the same asset as the stake.",
        notes,
      },
    };
  },
});

interface DescribedItem {
  readonly kind: ClaimKind;
  readonly kindLabel: string;
  readonly amount: MoneyView;
  readonly marketId: string | undefined;
  readonly positionId: string | undefined;
  readonly outcome: number | undefined;
  readonly call: { contract: string | undefined; method: string; signature: string; argument: string } | null;
  readonly vesting: { earned: MoneyView; ofWhichPrincipal: MoneyView } | undefined;
}

function describeItem(item: ClaimableItem, deps: ToolDeps, vesting: Map<string, VestingEarned>): DescribedItem {
  const earned = item.positionId === undefined ? undefined : vesting.get(item.positionId);

  return {
    kind: item.kind,
    kindLabel: KIND_LABEL[item.kind],
    amount: money(item.amount),
    marketId: item.marketId,
    positionId: item.positionId,
    outcome: item.outcome,
    call: buildCall(item, deps),
    vesting:
      earned === undefined || earned.vested === undefined
        ? undefined
        : { earned: money(earned.vested), ofWhichPrincipal: money(earned.accepted) },
  };
}

/**
 * The transaction that pays this item.
 *
 * When the source names the call and its argument, both are used verbatim: the argument
 * is the settler's numeric index, which is not recoverable from the composite id the
 * reads are addressed by. Only a source that names neither falls back to the kind, and
 * then the id has to stand in for the index — which is why an item whose kind is unknown
 * gets no call at all rather than a plausible-looking wrong one.
 */
function buildCall(item: ClaimableItem, deps: ToolDeps): DescribedItem["call"] {
  const contract = item.settler ?? deps.config.settlerAddress;
  const named = item.call;
  if (named !== undefined && item.argument !== undefined) {
    const signature = SIGNATURES[named];
    if (signature !== undefined) {
      return { contract, method: named, signature, argument: item.argument };
    }
  }

  const template = CALL_FOR[item.kind];
  if (template === undefined) return null;
  const argumentValue = item.argument ?? (template.argument === "marketId" ? item.marketId : item.positionId);
  if (argumentValue === undefined) return null;
  const signature = SIGNATURES[template.method];
  if (signature === undefined) return null;
  return { contract, method: template.method, signature, argument: argumentValue };
}

/**
 * Vesting lookups are per position and independent, so they run together rather than in
 * series; the cap keeps a wallet with a hundred settled positions from turning one tool
 * call into a hundred round trips.
 */
async function readVesting(
  items: readonly ClaimableItem[],
  deps: ToolDeps,
  notes: string[],
): Promise<Map<string, VestingEarned>> {
  const ids = [...new Set(items.map((item) => item.positionId).filter((id): id is string => id !== undefined))];
  const limit = deps.config.maxPositionLookups;
  const selected = ids.slice(0, limit);
  if (ids.length > selected.length) {
    notes.push(
      `Vesting was annotated for ${selected.length} of ${ids.length} positions (HUNCH_VPM_MAX_POSITION_LOOKUPS=${limit}).`,
    );
  }

  const results = await Promise.all(
    selected.map(async (id): Promise<[string, VestingEarned] | undefined> => {
      try {
        return [id, await deps.venue.vestingEarned(id)];
      } catch {
        // An annotation, not the answer. A position with no vesting read still claims.
        return undefined;
      }
    }),
  );

  const map = new Map<string, VestingEarned>();
  let pending = 0;
  for (const entry of results) {
    if (entry === undefined) continue;
    map.set(entry[0], entry[1]);
    // `vested` is undefined until the entry's vintage finalizes, because what was
    // accepted is not fixed before then. Reporting 0 would be a different claim.
    if (entry[1].vested === undefined) pending += 1;
  }
  if (selected.length > 0 && map.size === 0) {
    notes.push("Vesting annotations were requested but none could be read; the amounts below are unaffected.");
  } else if (pending > 0) {
    notes.push(
      `${pending} position(s) are in a vintage that has not finalized, so what has vested to them is not fixed yet and is left out.`,
    );
  }
  return map;
}

function renderSummary(wallet: string, total: bigint, items: readonly DescribedItem[], notes: readonly string[]): string {
  const lines: string[] = [];
  if (items.length === 0 || total === 0n) {
    lines.push(`${shortAddress(wallet)} has nothing to claim right now.`);
    lines.push(
      "Stake that is still in an open market is not claimable — it settles at the freeze. A refused remainder, though, is refundable as soon as its vintage finalizes, so check again after entering.",
    );
    if (notes.length > 0) {
      lines.push("");
      for (const note of notes) lines.push(`Note: ${note}`);
    }
    return lines.join("\n");
  }

  lines.push(`${shortAddress(wallet)} can pull ${money(total).display} right now, across ${items.length} item(s).`);
  lines.push("");
  lines.push(
    renderTable(
      ["amount", "kind", "market", "position", "call"],
      items.map((item) => [
        item.amount.display,
        item.kindLabel,
        item.marketId ?? "-",
        item.positionId ?? "-",
        item.call === null ? "-" : `${item.call.signature} with ${item.call.argument}`,
      ]),
    ),
  );

  const annotated = items.filter((item) => item.vesting !== undefined);
  if (annotated.length > 0) {
    lines.push("");
    for (const item of annotated) {
      const vesting = item.vesting;
      if (vesting === undefined) continue;
      lines.push(
        `Position ${item.positionId}: ${vesting.ofWhichPrincipal.display} of accepted principal plus ${vesting.earned.display} vested from stake that arrived later.`,
      );
    }
  }

  lines.push("");
  lines.push(
    "Send these yourself: the venue holds no keys and pushes no funds. Each call is made from the wallet that owns the position, against the settler named in `call.contract`.",
  );

  if (notes.length > 0) {
    lines.push("");
    for (const note of notes) lines.push(`Note: ${note}`);
  }

  return lines.join("\n");
}
