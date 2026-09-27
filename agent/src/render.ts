/**
 * Turning results into lines.
 *
 * Kept apart from the loop so that what the agent decided and how it is printed are two
 * separate things, and so a test can assert on the decision without parsing a table.
 */

import type { NanopaymentSettlement } from "./circle/types.js";
import { KAPPA_UNBOUNDED } from "./domain/types.js";
import type { MarketSnapshot, PositionSnapshot } from "./domain/types.js";
import { describeMicroUsdc, formatUsdc, pct, ratio } from "./domain/units.js";
import { pad, padStart } from "./log.js";
import type { ResearchReport, RoundResult } from "./loop.js";
import type { Decision } from "./policy/decide.js";
import type { ClaimReceipt } from "./research/source.js";

export function renderResearch(report: ResearchReport): readonly string[] {
  const lines: string[] = [
    "",
    `research  ${new Date(report.at * 1000).toISOString()}  ${String(report.quotesBought)} paid quote(s), ` +
      `${describeMicroUsdc(report.authorizedMicroUsdc)} authorized`,
    `  ${pad("market", 18)}${padStart("pool", 12)}${padStart("headroom", 14)}  book odds -> own estimate`,
  ];
  for (const row of report.markets) {
    const m = row.market;
    const detail =
      row.estimate === undefined
        ? (row.note ?? "no estimate")
        : m.books
            .map(
              (b, i) =>
                `${b.label} ${pct(ratio(b.principal, m.acceptedPool))}->${pct(row.estimate?.probabilities[i] ?? 0)}`,
            )
            .join("   ");
    lines.push(
      `  ${pad(m.marketId, 18)}${padStart(formatUsdc(m.acceptedPool), 12)}${padStart(headroomText(m), 14)}  ${detail}`,
    );
  }
  return lines;
}

function headroomText(market: MarketSnapshot): string {
  let tightest: bigint | undefined;
  for (const b of market.books) {
    if (b.headroom === KAPPA_UNBOUNDED) continue;
    if (tightest === undefined || b.headroom < tightest) tightest = b.headroom;
  }
  return tightest === undefined ? "unbounded" : formatUsdc(tightest);
}

/** The audit table: every outcome the agent looked at and the number that settled it. */
export function renderDecision(decision: Decision, market: MarketSnapshot | undefined): readonly string[] {
  const head =
    decision.action === "enter"
      ? `decide    ${decision.marketId}  ENTER outcome ${String(decision.outcome)} for ${formatUsdc(decision.stake ?? 0n)} USDC`
      : `decide    ${decision.marketId}  abstain (${decision.reason})`;
  const lines = [
    "",
    head,
    `  ${String(decision.secondsToFreeze)}s to freeze, ${pct(decision.vestingOutlook)} of the arrival window still ahead`,
  ];
  if (market !== undefined) lines.push(`  ${market.question}`);
  if (decision.candidates.length === 0) return lines;

  lines.push(
    `  ${pad("outcome", 10)}${padStart("book", 9)}${padStart("own", 9)}${padStart("edge", 9)}` +
      `${padStart("trust", 8)}${padStart("eff.edge", 10)}${padStart("headroom", 14)}${padStart("stake", 12)}  verdict`,
  );
  for (const c of decision.candidates) {
    lines.push(
      `  ${pad(c.label, 10)}${padStart(pct(c.impliedProbability), 9)}${padStart(pct(c.ownProbability), 9)}` +
        `${padStart(pct(c.rawEdge), 9)}${padStart(c.counterpartyTrust.toFixed(2), 8)}` +
        `${padStart(pct(c.effectiveEdge), 10)}` +
        `${padStart(c.headroomUnbounded ? "unbounded" : formatUsdc(c.acceptanceHeadroom), 14)}` +
        `${padStart(formatUsdc(c.proposedStake), 12)}  ${c.rejection ?? (decision.outcome === c.outcome ? "chosen" : "viable")}`,
    );
  }
  return lines;
}

export function renderRound(round: RoundResult): readonly string[] {
  const lines: string[] = [];
  for (const entry of round.entries) {
    const accepted =
      entry.accepted === undefined
        ? "pending (the vintage has not closed yet)"
        : `${formatUsdc(entry.accepted)} accepted, ${formatUsdc(entry.offered - entry.accepted)} refused`;
    lines.push(
      `enter     ${entry.marketId} outcome ${String(entry.outcome)}: offered ${formatUsdc(entry.offered)}, ${accepted}`,
    );
    for (const tx of entry.txs) {
      lines.push(`          ${tx.status} ${tx.hash}${tx.explorerUrl === undefined ? "" : `  ${tx.explorerUrl}`}`);
    }
  }
  if (round.positions.length > 0) lines.push("", "monitor");
  for (const p of round.positions) lines.push(`  ${renderPosition(p)}`);
  return lines;
}

export function renderPosition(p: PositionSnapshot): string {
  const multiple = p.accepted === 0n ? 1 : 1 + ratio(p.vestingEarned, p.accepted);
  return (
    `${pad(p.positionId, 6)}${pad(p.marketId, 18)}outcome ${String(p.outcome)}  ` +
    `accepted ${formatUsdc(p.accepted)}  vested in ${formatUsdc(p.vestingEarned)}  ` +
    `= ${multiple.toFixed(4)}x if it wins`
  );
}

export function renderClaims(claims: readonly ClaimReceipt[]): readonly string[] {
  if (claims.length === 0) return ["", "claim     nothing outstanding"];
  const lines = ["", "claim"];
  for (const c of claims) {
    lines.push(
      `  ${pad(c.positionId, 6)}payout ${formatUsdc(c.payout)}  refund ${formatUsdc(c.refund)}  ` +
        `${c.txs.map((t) => t.status).join(",")}`,
    );
  }
  return lines;
}

export function renderSettlement(settlement: NanopaymentSettlement, quotesBought: number): readonly string[] {
  if (settlement.authorizations === 0) {
    return ["", "nanopayments  nothing to settle"];
  }
  return [
    "",
    `nanopayments  ${String(settlement.authorizations)} authorization(s) for ${String(quotesBought)} paid quote(s), ` +
      `${describeMicroUsdc(settlement.totalMicroUsdc)} total, settled in 1 on-chain payment` +
      `${settlement.txHash === undefined ? "" : ` (${settlement.txHash})`}`,
    "              per-call settlement would have been one transaction each; batching is what makes the loop affordable",
  ];
}
