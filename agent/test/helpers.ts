import { KAPPA_UNBOUNDED } from "../src/domain/types.js";
import type { BookSnapshot, Hex, MarketSnapshot, OutcomeEstimate } from "../src/domain/types.js";
import { parseUsdc } from "../src/domain/units.js";

export const NOW = 1_800_000_000;
export const ZERO: Hex = "0x0000000000000000000000000000000000000000";
export const USDC: Hex = "0x3600000000000000000000000000000000000000";

export interface BookSpec {
  readonly label: string;
  readonly principal: string;
  readonly vested: string;
  readonly capacity?: string;
  readonly trust: number;
  readonly holders?: number;
}

export interface MarketSpec {
  readonly marketId?: string;
  /** Per-outcome opposing trust, as a live source supplies it. Omit to derive from book trust. */
  readonly opposingTrust?: readonly number[];
  readonly books: readonly BookSpec[];
  readonly kappa?: bigint;
  readonly openedSecondsAgo?: number;
  readonly freezeInSeconds?: number;
  readonly status?: "open" | "resolved" | "voided";
  readonly now?: number;
}

export function market(spec: MarketSpec): MarketSnapshot {
  const now = spec.now ?? NOW;
  const kappa = spec.kappa ?? 30n;
  const books: BookSnapshot[] = spec.books.map((b, outcome) => {
    const principal = parseUsdc(b.principal);
    const vested = parseUsdc(b.vested);
    const capacity =
      kappa === KAPPA_UNBOUNDED
        ? KAPPA_UNBOUNDED
        : b.capacity === undefined
          ? kappa * principal
          : parseUsdc(b.capacity);
    return {
      outcome,
      label: b.label,
      principal,
      capacity,
      vested,
      headroom: capacity === KAPPA_UNBOUNDED ? KAPPA_UNBOUNDED : capacity > vested ? capacity - vested : 0n,
      holders: b.holders ?? 1,
      trust: b.trust,
    };
  });
  let pool = 0n;
  for (const b of books) pool += b.principal;

  return {
    marketId: spec.marketId ?? "test-market",
    onChainMarketId: 0n,
    question: "a test question",
    settler: ZERO,
    token: USDC,
    status: spec.status ?? "open",
    kappa,
    openedAt: now - (spec.openedSecondsAgo ?? 3600),
    resolutionTime: now + (spec.freezeInSeconds ?? 86400),
    acceptedPool: pool,
    books,
    spec: { feedKey: "TESTUSD", strike8: 100_00000000n, direction: 0, maxStaleness: 3600 },
    winner: undefined,
    opposingTrust: spec.opposingTrust,
  };
}

export function estimate(...probabilities: readonly number[]): OutcomeEstimate {
  return { probabilities, basis: "test", observedAt: NOW };
}
