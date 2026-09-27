# Security review: HunchVPM, StockRoundResolver, HunchMarketFactory

Scope: the three contracts that will be deployed on Robinhood Chain (4663) and the interfaces
they declare: `src/HunchVPM.sol`, `src/StockRoundResolver.sol`, `src/HunchMarketFactory.sol`,
`src/interfaces/*`. Out of scope: the vendored reference (`src/reference/`, a test oracle,
never deployed), `src/ClassicParimutuel.sol` (counterfactual maths only), mocks and tests.

This is the builders' own review, not an audit. It records what the automated and manual
passes found, what was fixed, and what is accepted and why.

## 1. Issues found and fixed during the build

| # | Severity | Issue | Fix | Proof |
|---|---|---|---|---|
| F1 | Critical | **Same-L1-block settlement drains other markets.** On Robinhood Chain `block.number` is the L1 block (~12 s) while `block.timestamp` is L2. The reference finalizes a vintage only once `block.number` advances, so a market resolved or voided one second after its bell can settle with its last vintage still pending. A claim then refunds the pending stake in full, and a later `finalizeVintage` vests the same stake into the winners again. One settler holds every market's escrow, so the excess is paid out of other markets. Anyone can create a market with themselves as resolver and do this deliberately. | D8: `resolve` and `voidMarket` finalize an open vintage unconditionally (one line each). Identical to the reference whenever `block.number` has advanced. | `test/SameBlockSettlement.t.sol`: +1,000 USDG drained from a victim market on the reference; the same sequence on HunchVPM leaves the victim's escrow intact. |
| F2 | High | **Vintage stuffing locks a market forever.** Finalizing costs about 34,000 gas per entry (cold) and every way out of a market finalizes first. About 1,000 minimum entries in one L1 block push finalization past the 32M per-transaction gas limit; nothing can then finalize, resolve or void the market. | D9: at most `MAX_VINTAGE_ENTRIES` = 200 entries per vintage (`VintageFull`); a full vintage settles in about 6.9M gas. | `test/VintageStuffing.t.sol`: 1,100 one-unit entries lock a reference market (finalize and timeout void both fail under 32M); a full HunchVPM vintage settles. |
| F3 | High | **Spec front-running.** A permissionless, first-come `register` would let anyone register the spec (feed, bells, bounds) of a market created outside the factory before its creator does, and resolve it from a feed they control. | `register` accepts only the market's creator, one spec per (settler, market), binary open markets only. The factory creates and registers in one transaction. | `test_RegisterRejectsBadSpecs`, `test_NobodyCanChangeAListedMarket` |
| F4 | Medium | **Same-second resolution race.** Resolving at `block.timestamp == finalTime` could use "x is the latest round" as proof while a later transaction in the same second writes a round with `updatedAt == finalTime`. | `resolve` / `voidStale` require `block.timestamp > finalTime`. | `test_NobodyCanResolveAtOrBeforeTheBell` |
| F5 | Medium | **Phase switch after the bell.** The literal proof rule could not prove the old phase's last round when a new aggregator starts after the bell, so such a market could only refund at the 72 h timeout. | x+1 absent, x not the latest, and the next phase's first round after T proves x; at or before T is `PhaseBoundary`. | `test_APhaseStartedAfterTheBellDoesNotBlock`, `test_APhaseBoundaryBeforeTheBellReverts`, the brute-force property and INV-7 |
| F6 | Low | **Unreadable corporate-action flag.** A reverting `oraclePaused()` must not let a market settle. | Unreadable counts as paused (blocks `resolve`, enables `voidPaused` after 24 h). | `test_AnUnreadablePauseFlagCountsAsPaused` |

F1 and F2 are reference behaviours that only become reachable on an Arbitrum-style chain. They
are the two diffs beyond the spec's D1 to D7; `DIFF.md` explains both and
`scripts/diff-reference.sh` checks that `resolve` / `voidMarket` differ from the reference by
exactly the D8 line.

## 2. Slither

Ran locally: Slither 0.11.6 (`uvx --from slither-analyzer slither`), solc 0.8.28, on the
commit that adds this file:

```
cd contracts && slither . --config-file slither.config.json --fail-high
```

`slither.config.json` filters `src/reference`, `src/mocks`, `src/ClassicParimutuel`, `test`
and `lib`. The first run reported 24 findings including one High (fixed below); the final run
reports 23, **none High**, exit code 0. `scripts/verify.sh` does not run Slither yet; the
command above is the one to add to CI (it fails on any new High finding).

| Detector (impact) | Where | Verdict |
|---|---|---|
| reentrancy-balance (High) | `HunchMarketFactory._handOver` | **Fixed**: flagged a balance read used in the same condition as the transfer; restructured (the value read is the value sent). |
| uninitialized-local (Medium) ×4 | `HunchVPM._claim` `payout`, `refund`, `fee`; `HunchVPM._seedClamp` `converged` | Accepted: zero-initialisation is intended. `payout`, `refund` and `converged` are reference lines kept verbatim; `fee` (D1) follows the same style. |
| unused-return (Medium) | `StockRoundResolver.register` destructures `getMarket` | Accepted: the unused fields are not needed; the used ones are all checked. |
| missing-zero-check (Low) | `HunchMarketFactory.transferOwnership` | Accepted: passing zero cancels a pending transfer, documented and tested (`test_APendingTransferCanBeCancelled`). Ownership only moves on `acceptOwnership` by the named address. |
| reentrancy-benign (Low) | `HunchMarketFactory.openUpDown` writes the listing after external calls | Accepted: the listing needs the market and spec ids those calls return. The callees are the immutable HunchVPM, StockRoundResolver and USDG; none calls back into the factory, and a re-entrant `openUpDown` would still require an opener. |
| reentrancy-events (Low) | `MarketOpened` after external calls | Accepted: same reasoning. |
| timestamp (Low) ×8 | bells, freeze, void timeout, pause grace | Accepted: time is the specification (see section 4, sequencer trust). |
| cyclomatic-complexity (Info) ×3 | `_seedClamp`, `_finalizeVintage` (reference), `_enter` (reference body + D3/D4/D9 checks) | Accepted: reference code kept verbatim. |
| low-level-calls (Info) ×3 | `StockRoundResolver._round`, `_latestRoundId`, `_oraclePaused` | Intended: every feed and token read is a `staticcall` so reverting, short or zero-returning feeds read as "absent" and `preview` never reverts. |
| missing-inheritance (Info) | HunchVPM could inherit IHunchSettler | Accepted: HunchVPM stays line-for-line comparable to the reference; `test_TheResolversSettlerInterfaceMatchesHunchVPM` pins the selectors. |

## 3. Manual review

| Area | What was checked | Status |
|---|---|---|
| Reentrancy | Every HunchVPM function that moves tokens (`create`, `enter`, `enterWithAuthorization`, `claim*`, `withdrawRefund*`, `claimResidue`, `sweepFees`) is `nonReentrant` and moves tokens last. The resolver sets `settled` and emits before calling the settler. USDG has no transfer hooks. | OK |
| Access control | HunchVPM: no owner; `guardian` can only `setEntriesPaused`; `treasury` only receives swept fees; the market's resolver resolves, anyone voids after the timeout. Resolver: no owner. Factory: owner manages feeds and openers only (two-step transfer), openers only list. Nobody can change a listed market (`test_NobodyCanChangeAListedMarket`). | OK |
| Funds only to owners | `claimFor` / `withdrawRefundFor` pay `positions[id].owner`, never the caller (T2, INV-3); `sweepFees` pays only the immutable treasury; residue only the residue owner. The relayer, the guardian and outsiders never receive a unit (INV-3). | OK |
| Signed entries (D5) | The EIP-3009 nonce binds chain id, HunchVPM, market, side, amount and salt; USDG binds `from`, `to`, `value` and the time window and marks the nonce used. A relayer cannot re-target, replay or redeem the signature elsewhere (`CallerMustBePayee`, different type hash for `transferWithAuthorization`). `from == 0` rejected. Checks run before the pull, so a refused entry leaves the authorization unused. INV-8 and T2. | OK |
| Arithmetic | Solidity 0.8 checked maths; amounts bounded by `uint128` (`AmountTooLarge`). `fee = floor(gain · bps / 1e4)` with bps ≤ 500 never exceeds the gain; `gain = payout − accepted ≥ 0` by P2. `paidOut` stays gross, so residue arithmetic is the reference's. Solvency is asserted as an equality (INV-1). | OK |
| Mechanism equivalence | `diff-reference.sh` proves every change is tagged and the mechanism functions are byte-identical; the differential suite proves identical accepted amounts, payouts, refunds and residue on 118 vectors and 10,000 fuzzed sequences (CI). | OK |
| Oracle proofs | "Last round at or before T" is proven from the feed: x exists and is in band, and x+1 is after T, or x is the latest, or the next phase starts after T. Off-by-one, missing, garbage and cross-phase rounds revert. Property test and INV-7 compare with a brute-force scan. | OK |
| Oracle trust | Chainlink's answer is trusted within the sanity band `0 < answer < 1e14`; a wrong but in-band report would settle a market wrongly. Staleness bounds turn a missed heartbeat into a refund. `oraclePaused()` blocks resolution. | Accepted |
| Proof assumptions | Within a phase, round ids are consecutive and `updatedAt` is non-decreasing and equals the time the round was written on 4663 (OCR transmission time). If a proxy ever skipped over an aggregator that never printed, or right after an aggregator switch before its first print, the proof waits (BadProof), and the 72 h void timeout is the backstop. | Accepted, tested |
| Token behaviour (USDG) | Transfer-exact, 6 decimals, no hooks. Paxos can **freeze** any address: a frozen winner's claim fails alone (`test_D2_AFrozenOwnerFailsAlone`), a frozen treasury blocks only `sweepFees`, never a claim (`test_D1_AFrozenTreasuryNeverBlocksAClaim`); if HunchVPM itself were frozen, every market would wait until unfrozen. Paxos can **pause** USDG: transfers revert, no state is lost (`test_D2_APausedTokenLosesNothing`). USDG is **upgradeable** (UUPS + facets): a change to transfer semantics (for example a transfer fee) would break the transfer-exact assumption. | Accepted (issuer risk, stated on /docs/risks) |
| Residue | A winning position that can never be paid (a frozen owner, or one transferred to the zero address) keeps `live > 0`, so that market's residue (floor dust, at most about one unit per winner) cannot be claimed. | Accepted (dust) |
| Denial of service | No unbounded loops over user-controlled data beyond the reference's per-vintage loop, now capped at 200 (D9). `marketPositions` and `listings` are paginated views. One market cannot block another's claims. | OK |
| Sequencer and time | Bells, the freeze and timeouts use `block.timestamp`, set by the Robinhood Chain sequencer within Arbitrum's bounds. A malicious sequencer could order or backdate transactions near the bell; the proofs themselves use `updatedAt`, also sequencer time. The venue trusts the chain's sequencer, as every contract on it does. | Accepted |
| Factory hygiene | The factory ends every call with zero USDG, zero allowance and no positions (asserted after every open, even after a donation). It pulls exactly 2 · seed and returns any leftover. | OK |
| Opener powers | An opener chooses times (8-day window max), entry caps (0 means no cap) and may only tighten age bounds. A compromised opener key can list odd markets but cannot touch existing ones or anyone's funds; the Safe removes it with `setOpener(opener, false)` and the guardian can pause new entries. | Accepted |
| Relayed signatures | A relayer holding a signed entry could submit it late within its validity window (a later entry accrues less). The web should sign with a short `validBefore` (minutes). | Accepted (web: short windows) |

## 4. Trust assumptions, stated once

- **Chainlink** reports the Stock Token's price honestly within its 0.5% deviation band, with
  consecutive round ids and on-chain `updatedAt`.
- **Robinhood** sets `oraclePaused()` during corporate actions and keeps it readable.
- **Paxos** does not freeze HunchVPM and keeps USDG transfer-exact.
- **The Robinhood Chain sequencer** produces honest timestamps within Arbitrum's bounds.
- **The Safe** (owner, guardian, treasury) allow-lists only genuine feeds and Stock Tokens.

## 5. Reproduce

```
forge build --root contracts --sizes
forge test --root contracts                      # 512 fuzz runs, 128 x 64 invariants
FOUNDRY_PROFILE=ci forge test --root contracts   # 10,000 differential runs, 256 x 128 invariants
bash scripts/diff-reference.sh --check
cd contracts && slither . --config-file slither.config.json --fail-high
```
