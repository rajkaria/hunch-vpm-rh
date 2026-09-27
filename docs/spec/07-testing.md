# 07 · Testing and verification

One gate: `pnpm verify` = `forge build` → `forge test` → `slither` (triaged) →
`tsc --noEmit` → `vitest run` → `next build`. CI runs the same script. Tests exist to
keep the golden path from breaking and to prove the contract claims on the README; the
README does not advertise test counts.

## Contracts (Foundry)

| Id | Suite | What it proves |
|---|---|---|
| T1 | `Vectors.t.sol` (vendored) | The reference replays all 118 published vectors (suite 1.2.0) within the P8 bound. |
| T2 | `HunchVPM.t.sol` (+ `SameBlockSettlement.t.sol`, `VintageStuffing.t.sol` for D8/D9) | Each diff D1–D9: fee = floor(gain·bps/1e4) on winners only; 0 on void/loss/refund; `sweepFees` → treasury only; `claimFor`/`withdrawRefundFor` pay the owner, never the caller; min/max entry bounds; `enterWithAuthorization` against a mock EIP-3009 token (owner = `from`, a changed market/side/amount/salt reverts, replay reverts, relayer ≠ owner); `accrued` equals claim payout at resolution; `marketPositions` pagination. **T2.9:** with entries paused, every non-entry function succeeds. |
| T2w | `WorkedExample.t.sol` | Pins the `02-mechanism.md` table to the cent (6-dec USDG) and writes `fixtures/worked-example.json`, which the website imports. |
| T3 | `Differential.t.sol` | HunchVPM (fee 0, no bounds) ≡ reference on all 118 vectors and on 10,000 fuzzed sequences (random outcomes, amounts, block gaps, resolve/void): identical `accepted`, payouts, refunds, residue. |
| T4 | `Invariants.t.sol` (handler-based) | INV-1 … INV-7 from `03-contracts.md`, 256 runs × depth 128 in CI profile. |
| T5 | `StockRoundResolver.t.sol` | MockAggregator with phases + MockStockToken: only the unique "last round ≤ T" pair resolves; off-by-one rounds revert `BadProof`; a missing next round is accepted only when the round is the latest; phase boundary reverts; same round or equal answers → FLAT void; stale strike or final → `resolve` reverts `Stale` and only `voidStale` succeeds; `voidStale` with fresh rounds reverts `NotStale`; `oraclePaused` blocks `resolve`, `voidPaused` only after 24 h; garbage answers (≤ 0, out of band) revert; `register` rejects a market whose resolver or freeze doesn't match; double settle reverts. Property test: for random round series and random times, the accepted pair equals a brute-force scan. |
| T5f | `ResolverFork.t.sol` (fork of chain 4663 at a pinned block after a completed session; keyed archive RPC required) | With a `MockSettler`, register a spec over that real session for each allow-listed feed, resolve with round ids from the TS finder, and assert the outcome equals the independently computed one (prices recorded in the test with their round ids and explorer links). |
| T6 | `HunchMarketFactory.t.sol` | Allow-list and opener gates; bounds on times and seed; seed legs handed to the opener; allowance zeroed; factory ends every call with zero balance; two-step ownership. |
| T7 | `ForkE2E.t.sol` (fork of chain 4663) | Deploy all three contracts against **real USDG** (balances via `deal`) and a mock feed registered as allowed; open a market; 4 bettors enter across L1 block numbers (`vm.roll`) incl. a same-vintage pair and a partial fill, one of them through `enterWithAuthorization` signed against USDG's real domain separator; warp to the bell; resolve; `claimFor` everyone; assert INV-1/2 and exact balances. |
| T7g | `Gas.t.sol` | Measures the calls in `03-contracts.md` §Gas on the fork, writes `contracts/GAS.md`. |

## TypeScript

| Id | Suite | What it proves |
|---|---|---|
| T8 | `packages/client/test/mechanics.test.ts` | TS `accrued`, quote (incl. open-vintage demand) and classic counterfactual equal the contract's numbers on the worked example and on 20 vectors (fixtures exported by Foundry). |
| T8r | `packages/client/test/rounds.test.ts` | Round finder against **captured** round series from chain 4663 (`scripts/capture-rounds.ts` writes fixtures from the live feed; never hand-written), incl. a phase boundary fixture if one exists. |
| T9 | `packages/keeper/test/*.test.ts` | Relay endpoint validation (wrong domain, expired, wrong amount, rate limit). Pure decisions: which markets to open for a given ET date (holiday, early close, DST boundary Nov 1, corporate action skip); resolve vs void vs page; deliver batching; idempotency (second run does nothing). |
| T10 | `apps/web/test/*.test.tsx` | `<EarlyVsLate>` renders the fixture and never drops the "Illustration" label on fallback; `<StakePanel>` state machine (connect → switch → sign → relayed → confirmed; and the pay-gas path connect → switch → approve → enter → confirmed); geo gate; copy snapshot of the landing hero for `first-screen.sh`. |

## On the real network (humans)

**G4 golden path (operator, mainnet, before the first public market):**

| # | Step | Pass when |
|---|---|---|
| 1 | Open `rh.playhunch.xyz` on a wallet set to another chain | Button reads "Switch to Robinhood Chain"; one click adds + switches |
| 2 | Bet 2 USDG UP on a live daily market **with a wallet holding no ETH** (signed, relayed) | Receipt; position shows accepted 2.00 |
| 3 | **Hard refresh** | Same position, same numbers |
| 4 | Second wallet bets 3 USDG DOWN | First wallet's "accrued" rises by the vested amount |
| 5 | After the bell | Resolve tx appears (keeper or the "Resolve it yourself" button) with both round ids |
| 6 | Within 10 min | Payout tx to the winner; `/portfolio` shows it; fee swept later |
| 7 | Repeat step 2 from a phone via WalletConnect | Works |
| 8 | Robinhood Wallet | Connects and bets, or `/start` states it can't |

Wallet matrix recorded in the internal judge log with date, wallet, device, result.

**Liveness:** `/api/health` green for a full trading day before the draft submission.

## Claims audit (before freeze)

Every sentence on the landing page, README, `/proof`, the video and the submission form
maps to a row in `docs/FACTS.md` with its receipt (tx hash, contract call, Blockscout
URL). Anything without a receipt is removed or moved to "Roadmap". Run
`hackathon/arsenal/submission-check/` with `--strict`.
