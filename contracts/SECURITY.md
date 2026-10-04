# Security review: HunchVPM, StockRoundResolver, HunchMarketFactory

Scope: the three contracts that will be deployed on Robinhood Chain (4663) and the interfaces
they declare: `src/HunchVPM.sol`, `src/StockRoundResolver.sol`, `src/HunchMarketFactory.sol`,
`src/interfaces/*`. Out of scope: the vendored reference (`src/reference/`, a test oracle,
never deployed), `src/ClassicParimutuel.sol` (counterfactual maths only), mocks and tests.

Sections 1 to 4 are the builders' own review, not an audit: what the automated and manual
passes found, what was fixed, and what is accepted and why. Section 5 records the independent
review of 2026-09-28 and what became of each of its findings.

## 1. Issues found and fixed during the build

| # | Severity | Issue | Fix | Proof |
|---|---|---|---|---|
| F1 | Critical | **Same-L1-block settlement drains other markets.** On Robinhood Chain `block.number` is the L1 block (~12 s) while `block.timestamp` is L2. The reference finalizes a vintage only once `block.number` advances, so a market resolved or voided one second after its bell can settle with its last vintage still pending. A claim then refunds the pending stake in full, and a later `finalizeVintage` vests the same stake into the winners again. One settler holds every market's escrow, so the excess is paid out of other markets. Anyone can create a market with themselves as resolver and do this deliberately. | D8: `resolve` and `voidMarket` finalize an open vintage unconditionally (one line each). Identical to the reference whenever `block.number` has advanced. | `test/SameBlockSettlement.t.sol`: +1,000 USDG drained from a victim market on the reference; the same sequence on HunchVPM leaves the victim's escrow intact. |
| F2 | High | **Vintage stuffing locks a market forever.** Finalizing costs about 34,000 gas per entry (cold) and every way out of a market finalizes first. About 1,000 minimum entries in one L1 block push finalization past the 32M per-transaction gas limit; nothing can then finalize, resolve or void the market. | D9: at most `MAX_VINTAGE_ENTRIES` = 200 entries per vintage (`VintageFull`); a full binary vintage settles in a transaction of about 8.0M gas (section 7). Extended after the independent review (M-2, I-1, section 5): also at most `MAX_VINTAGE_WORK` = 12,800 entry-outcome pairs, and a finite κ at most `MAX_KAPPA` = 1e9. | `test/VintageStuffing.t.sol`: 1,100 one-unit entries lock a reference market (finalize and timeout void both fail under 32M); a full HunchVPM vintage settles. |
| F3 | High | **Spec front-running.** A permissionless, first-come `register` would let anyone register the spec (feed, bells, bounds) of a market created outside the factory before its creator does, and resolve it from a feed they control. | `register` accepts only the market's creator, one spec per (settler, market), binary open markets only. The factory creates and registers in one transaction. | `test_RegisterRejectsBadSpecs`, `test_NobodyCanChangeAListedMarket` |
| F4 | Medium | **Same-second resolution race.** Resolving at `block.timestamp == finalTime` could use "x is the latest round" as proof while a later transaction in the same second writes a round with `updatedAt == finalTime`. | `resolve` / `voidStale` require `block.timestamp > finalTime`. | `test_NobodyCanResolveAtOrBeforeTheBell` |
| F5 | Medium | **Phase switch after the bell.** The literal proof rule could not prove the old phase's last round when a new aggregator starts after the bell, so such a market could only refund at the 72 h timeout. | x+1 absent, x not the latest, and a later phase's first round after T proves x; at or before T is `PhaseBoundary`. (Generalised after the independent review, M-1: every later phase up to the current one is checked.) | `test_APhaseStartedAfterTheBellDoesNotBlock`, `test_APhaseBoundaryBeforeTheBellReverts`, `test_AnOldPhasesLastRoundProvesAcrossLaterPhasesThatPrintedAfterTheBell`, the brute-force properties and INV-7 |
| F6 | Low | **Unreadable corporate-action flag.** A reverting `oraclePaused()` must not let a market settle. | Unreadable counts as paused (blocks `resolve`, enables `voidPaused` after 24 h). | `test_AnUnreadablePauseFlagCountsAsPaused` |
| F7 | Critical | **Unpaid signed entries (used or cancelled EIP-3009 nonces).** Real USDG on chain 4663 does not revert `receiveWithAuthorization` on a used or cancelled nonce: it emits `AuthorizationAlreadyUsed` and returns without moving funds and without checking the signature or the value. Anyone could burn one of their own nonces for free (`cancelAuthorization`), or replay a relayed entry, and call `enterWithAuthorization` with any signature: the settler booked a stake nobody paid, whose refund or payout came out of other bettors' escrow. | D5: `enterWithAuthorization` refuses a nonce USDG already marks used (`AuthorizationUsed`) before anything is booked; and every pull (`create`, `enter`, `enterWithAuthorization`) must raise the settler's USDG balance by the amount (`NotPaid`, `_pullExact`), so any path that reports success without paying (this one, or a future USDG upgrade) reverts. MockUSDG now behaves like USDG (emit and return; `cancelAuthorization`). About 2,200 gas per entry locally, 3,000 to 7,500 on real USDG. | Found by the **fork suite** against real USDG (`test/fork/ForkE2E.t.sol`: `test_AUsedOrCancelledAuthorizationCannotBookAnEntry`, `test_ARelayedEntryCannotBeReplayed`), not by the local suite. Locally now: `test_D5_AUsedNonceWithAnySignatureIsRefused`, `test_D5_ACancelledNonceCannotBookAFreeEntry`, `test_D5_APullThatDoesNotPayIsRefused`, INV-8 (`freeEntry`). `bash scripts/rehearse-fork.sh` passes end to end. |

F1 and F2 are reference behaviours that only become reachable on an Arbitrum-style chain (F2's
many-outcome and huge-κ variants on any chain). They are the two diffs beyond the spec's D1 to
D7; `DIFF.md` explains both and `scripts/diff-reference.sh` checks that `resolve` /
`voidMarket` differ from the reference by exactly the D8 line. F7 is part of D5.

**The lesson of F7: a mock is an assumption.** MockUSDG reverted on a reused nonce, as
EIP-3009's reference implementation does; real USDG does not. The local unit tests, the
invariant campaign and the differential suite were all green against the mock, and the drain
was found only when the same flows ran against the real token on a fork. Since then every
external behaviour the settler depends on is either checked by the settler itself
(`authorizationState` before booking, the balance delta after every pull) or pinned against
the real contract on a fork (`test/fork/`), and MockUSDG copies USDG's measured behaviour rather
than the standard's.

## 2. Slither

Ran locally: Slither 0.11.6 (`uvx --from slither-analyzer slither`), solc 0.8.28, on the
commit that adds this file:

```
cd contracts && slither . --config-file slither.config.json --fail-high
```

`slither.config.json` filters `src/reference`, `src/mocks`, `src/ClassicParimutuel`, `test`
and `lib`. The first run reported 24 findings including one High (fixed below); the final run
reports 23, **none High**, exit code 0. Re-run after the independent review's fixes and F7
(2026-09-28): 23 findings, the same detectors and verdicts as below, **none High**, exit code
0, after one High on the new pull check was triaged as a false positive and suppressed inline
(`// slither-disable-next-line reentrancy-balance`, row below). Re-run after the second review's
D10 and resolver fixes (2026-09-28): 25 findings, **none High**, exit code 0; the two new ones are
the `pauser` missing-zero-check rows below. CI runs the command above in the verify gate and fails
on any High finding.

| Detector (impact) | Where | Verdict |
|---|---|---|
| reentrancy-balance (High) | `HunchMarketFactory._handOver` | **Fixed**: flagged a balance read used in the same condition as the transfer; restructured (the value read is the value sent). |
| reentrancy-balance (High) | `HunchVPM._pullExact`, `HunchVPM.enterWithAuthorization` (F7) | **False positive, suppressed inline**: the balance read before the pull is the point of the check (the settler's balance must rise by at least the amount). Every caller (`create`, `enter`, `enterWithAuthorization`) is `nonReentrant`, and a balance that rises during the call, whoever sends the tokens, can only mean the settler holds them: the check can make a pull fail, never make an unpaid one pass. |
| uninitialized-local (Medium) ×4 | `HunchVPM._claim` `payout`, `refund`, `fee`; `HunchVPM._seedClamp` `converged` | Accepted: zero-initialisation is intended. `payout`, `refund` and `converged` are reference lines kept verbatim; `fee` (D1) follows the same style. |
| unused-return (Medium) | `StockRoundResolver.register` destructures `getMarket` | Accepted: the unused fields are not needed; the used ones are all checked. |
| missing-zero-check (Low) ×2 | `HunchVPM` constructor `pauser_`, `HunchVPM.setPauser` (D10) | Accepted: zero means "no pauser", documented and tested (`test_Constructor_RejectsZeroAddresses`, `test_D10_OnlyTheGuardianNamesThePauser`); the guardian can always pause itself. |
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
| Access control | HunchVPM: no owner; `guardian` can only `setEntriesPaused` and `setPauser`; the `pauser` can only pause (D10); only the immutable `factory` creates markets (D10); `treasury` only receives swept fees; the market's resolver resolves, anyone voids after the timeout. Resolver: no owner. Factory: owner manages feeds and openers only (two-step transfer), openers only list. Nobody can change a listed market (`test_NobodyCanChangeAListedMarket`). | OK |
| Funds only to owners | `claimFor` / `withdrawRefundFor` pay `positions[id].owner`, never the caller (T2, INV-3); `sweepFees` pays only the immutable treasury; residue only the residue owner. The relayer, the guardian and outsiders never receive a unit (INV-3). | OK |
| Signed entries (D5) | The EIP-3009 nonce binds chain id, HunchVPM, market, side, amount and salt; USDG binds `from`, `to`, `value` and the time window and marks the nonce used. USDG does **not** revert on a used or cancelled nonce (F7), so HunchVPM refuses one itself (`AuthorizationUsed`) and requires the pull to raise its balance by the amount (`NotPaid`). A relayer cannot re-target, replay or redeem the signature elsewhere (`CallerMustBePayee`, different type hash for `transferWithAuthorization`). `from == 0` rejected. Checks run before the pull, so a refused entry leaves the authorization unused. INV-8 (tampered, replayed and cancelled-nonce entries), T2, and the fork suite on real USDG. | OK |
| Arithmetic | Solidity 0.8 checked maths; amounts bounded by `uint128` (`AmountTooLarge`). `fee = floor(gain · bps / 1e4)` with bps ≤ 500 never exceeds the gain; `gain = payout − accepted ≥ 0` by P2. `paidOut` stays gross, so residue arithmetic is the reference's. Solvency is asserted as an equality (INV-1). | OK |
| Mechanism equivalence | `diff-reference.sh` proves every change is tagged and the mechanism functions are byte-identical; the differential suite proves identical accepted amounts, payouts, refunds and residue on 118 vectors and 10,000 fuzzed sequences (CI). | OK |
| Oracle proofs | "The round in effect at T" is proven from the feed: the last round with updatedAt ≤ T of the highest phase that has one. x exists and is in band; no phase from x's phase + 1 to the proxy's current phase has a round at or before T (each first round is absent or after T); and x+1 is after T, or x is the latest, or x's phase has ended and a later phase has printed. Exactly one pair proves at any moment, whatever the tapes (section 5, M-1). Off-by-one, missing, garbage, cross-phase and older-phase rounds revert. Two brute-force properties (single and overlapping phases) and INV-7 (with overlapping aggregators) compare with a scan of the rule. | OK |
| Oracle trust | Chainlink's answer is trusted within the sanity band `0 < answer < 1e14`; a wrong but in-band report would settle a market wrongly. Staleness bounds turn a missed heartbeat into a refund. `oraclePaused()` blocks resolution. | Accepted |
| Proof assumptions | Within a phase, round ids are consecutive from 1 and `updatedAt` is non-decreasing and equals the time the round was written on 4663 (OCR transmission time). Right after an aggregator switch, before the new aggregator's first print, the proxy's latest round is unreadable and every proof waits (BadProof); a round more than `MAX_PHASE_SPAN` (8) phases below the current one is refused; the 72 h void timeout is the backstop for both. An aggregator confirmed after the bell that had already reported before it becomes, from its confirmation, the one in effect: the proven pair can change at that moment, and the first settlement is final (section 5, M-1 residual). | Accepted, tested |
| Token behaviour (USDG) | Transfer-exact, 6 decimals, no hooks. Paxos can **freeze** any address: a frozen winner's claim fails alone (`test_D2_AFrozenOwnerFailsAlone`), a frozen treasury blocks only `sweepFees`, never a claim (`test_D1_AFrozenTreasuryNeverBlocksAClaim`); if HunchVPM itself were frozen, every market would wait until unfrozen. Paxos can **pause** USDG: transfers revert, no state is lost (`test_D2_APausedTokenLosesNothing`). USDG is **upgradeable** (UUPS + facets): a change to transfer semantics (for example a transfer fee) would break the transfer-exact assumption; since F7 every pull checks the settler's balance delta, so a pull that pays less than the amount reverts instead of booking an unpaid stake (a fee on outgoing transfers would still make payouts arrive short). | Accepted (issuer risk, stated on /docs/risks) |
| Residue | A winning position that can never be paid (a frozen owner, or one transferred to the zero address) keeps `live > 0`, so that market's residue (floor dust, at most about one unit per winner) cannot be claimed. | Accepted (dust) |
| Denial of service | No unbounded loops over user-controlled data beyond the reference's per-vintage loop, now capped at 200 entries and 12,800 entry-outcome pairs (D9; the worst full vintage of any creatable market finalizes in a transaction of about 25.3M gas, section 7), and the resolver's phase walk (at most 8 reads). A finite κ is at most 1e9, so finalizing cannot overflow (D9). `marketPositions` and `listings` are paginated views. One market cannot block another's claims. | OK |
| Sequencer and time | Bells, the freeze and timeouts use `block.timestamp`, set by the Robinhood Chain sequencer within Arbitrum's bounds. A malicious sequencer could order or backdate transactions near the bell; the proofs themselves use `updatedAt`, also sequencer time. The venue trusts the chain's sequencer, as every contract on it does. | Accepted |
| Factory hygiene | The factory ends every call with zero USDG, zero allowance and no positions (asserted after every open, even after a donation). It pulls exactly 2 · seed and returns any leftover. | OK |
| Opener powers | An opener chooses times (8-day window max) and entry bounds (a floor of at least 1 USDG and a non-zero cap, both required since the independent review, I-3), and may only tighten age bounds. A compromised opener key can list odd markets but cannot touch existing ones or anyone's funds; the Safe removes it with `setOpener(opener, false)` and the guardian can pause new entries. | Accepted |
| Relayed signatures | A relayer holding a signed entry could submit it late within its validity window (a later entry accrues less). The web should sign with a short `validBefore` (minutes). | Accepted (web: short windows) |

## 4. Trust assumptions, stated once

- **Chainlink** reports the Stock Token's price honestly within its 0.5% deviation band, with
  consecutive round ids and on-chain `updatedAt`.
- **Robinhood** sets `oraclePaused()` during corporate actions and keeps it readable.
- **Paxos** does not freeze HunchVPM and keeps USDG transfer-exact (a pull that pays short now
  reverts, F7; the risk left is a fee on outgoing transfers).
- **The Robinhood Chain sequencer** produces honest timestamps within Arbitrum's bounds.
- **The Safe** (owner, guardian, treasury) allow-lists only genuine feeds and Stock Tokens.

## 5. Independent review (2026-09-28)

An independent reviewer read the three contracts and the client's round finder, with runnable
proofs of concept for M-1, M-2 and I-1. Every finding, and what became of it (F7 above was found
the same day by the fork suite, not by this review):

| # | Severity | Finding | Status | Fix, or why accepted | Proof |
|---|---|---|---|---|---|
| M-1 | Medium | **The resolver's proof was not unique across overlapping Chainlink phases.** When Chainlink moves a feed to a new aggregator, the new one reports before the proxy confirms it and the old one keeps its rounds (often printing on), so after the switch both phases had a provable "last round at or before T". Whoever called `resolve` or `voidStale` chose the pair: a loser could flip UP to DOWN, or void a good market as FLAT or stale. | **Fixed** | `_prove` accepts round x of phase p only if no phase from p + 1 to the proxy's current phase has a round at or before T (each first round absent or after T), so the accepted pair is the last round at or before T of the **highest** phase that has one: unique for any tapes. The reviewer's suggested patch checked phase p + 1 only; a middle aggregator that printed late, or never, would still have left two provable pairs, so the fix walks every later phase (bounded: a round more than `MAX_PHASE_SPAN` = 8 phases below the current one is refused). The latest round is read once for both proofs (resolve: 5 feed reads, about 164k gas locally). `preview` never reverts and reports BADPROOF. The TypeScript finder (`packages/client/src/rounds.ts`) returns the same round. **Residual:** an aggregator confirmed after the bell that had already reported before it becomes the one in effect from its confirmation, so the proven pair can change at that moment; the first settlement is final and the keeper resolves about a minute after the bell. | `test/PhaseOverlap.t.sol` (the reviewer's flip and FLAT-void pairs revert, exactly one pair proves, three phases, span bound, `preview` agrees with `resolve` on every pair); `testFuzz_OnlyTheCanonicalPairResolvesOnOverlappingPhases`; INV-7 with overlapping aggregators (`test_TheOverlapIsExercised`). All fail on the previous rule. |
| M-2 | Medium | **D9's 200-entry cap did not bound finalization on many-outcome markets.** Finalizing loops over every outcome for every entry and `create` allows up to 255 outcomes: one vintage of 200 one-unit entries locked a 110-outcome market (no exit fit in 32M gas). | **Fixed** | D9 also caps a vintage at `MAX_VINTAGE_WORK` = 12,800 entry-outcome pairs (`VintageFull`): 200 entries up to 64 outcomes, so binary markets are unchanged, and 50 at 255. The fullest vintage of every market that can be created inside 32M gas (up to 139 outcomes) finalizes in a transaction of at most about 25.3M gas (64 outcomes, every book rationed; section 7), leaving room for the exit that finalizes it. | `test_D9_EveryCreatableMarketsFullestVintageFinalizesUnder26MGas`, `test_D9_TheReviewersManyOutcomeLockIsImpossible`, `test_D9_TheWorkCapSetsHowManyEntriesAVintageTakes`; GAS.md row |
| L-1 | Low | **Vintage filling.** Anyone can fill a market's vintage (200 entries) and push other bettors' entries to the next L1 block (about 12 s), repeatedly. | **Accepted** | After I-3 every listed market has an entry floor of 1 USDG and a cap, so each block's filling takes 200 real entries of at least 1 USDG. (Corrected after the second review, L-6: a filler can split them between UP and DOWN, so little capital is at risk; the real cost is gas, about 35M gas per ~12 s block, roughly 0.0007 ETH at 0.02 gwei.) The effect is a delay of about 12 s, never a loss. The relayer retries `VintageFull` in the next block and the web says "busy, retrying". | `test_HunchVPMCapsAVintageSoItAlwaysFinalizes`, `test_EveryListedMarketHasAnEntryFloorAndACap` |
| L-2 | Low | **`oraclePaused()` is read at call time**, not at the bell: a pause set after the bell blocks resolution, and a pause during the session that has cleared by the call does not. | **Accepted** | The flag is Robinhood's corporate-action signal and the spec's rule is "blocks resolution while set". The keeper resolves within minutes of the bell; corporate actions are announced and the keeper skips listing across announced splits; a pause still set 24 h after the bell refunds through `voidPaused`. | `test_AnOraclePauseBlocksResolution`, `test_VoidPausedOnlyAfter24HoursAndOnlyWhilePaused` |
| I-1 | Info | **A huge finite κ locked a market.** Finalizing computes κ·a with checked arithmetic, so κ = 1e70 overflowed on a 20 USDG entry and reverted every exit. | **Fixed** | `create` accepts 1 ≤ κ ≤ `MAX_KAPPA` = 1e9 or `KAPPA_UNBOUNDED` (`InvalidKappa`), folded into D9. 1e9, not the suggested 1e6, because the paper's published vectors P9 and P12 use κ = 1e9 and the differential suite replays all 118 against the reference. At 1e9, κ·a stays below 2^158 for any amount a position can hold and the accumulator below 2^128. | `test_D9_CreateAcceptsKappaOnlyUpToTheBoundOrUnbounded`, `test_D9_TheReviewersHugeKappaLockIsImpossible`; the 118 vectors |
| I-2 | Info | **Relayed entries (forwarder note).** Anyone holding a signed entry can forward it, for example ahead of the venue's relayer. | **Accepted** | The nonce binds chain, contract, market, side, amount and salt, and the position always belongs to the signer, so a forwarder only chooses who pays the gas; any second submission reverts `AuthorizationUsed` (F7), and the venue's relayer reports a used authorization in plain words. Short `validBefore` windows (the web signs for minutes) bound how late a forwarder can submit. | T2 D5 tests, INV-8 |
| I-3 | Info | **The factory did not enforce entry bounds**: an opener could list a market with no floor (1-unit entries) or no cap. | **Fixed** | `openUpDown` requires `minEntry ≥ MIN_ENTRY` (1 USDG) and `0 < maxEntry`, `minEntry ≤ maxEntry` (`EntryBoundsTooLoose`, `InvalidEntryBounds`), before any transfer. | `test_EveryListedMarketHasAnEntryFloorAndACap`, `test_InvertedEntryBoundsRevertAtomically` |
| I-4 | Info | **A frozen owner can still `transferPosition`.** Paxos can freeze a USDG address; its owner can move a winning position to an unfrozen address, which is then paid. | **Accepted** | `transferPosition` is reference code kept byte for byte (the mechanism may not change); it moves no tokens, and the issuer can freeze the new address too. The venue's web does not offer transfers. | `diff-reference.sh` (untouched function) |
| I-5 | Info | **Deliveries to contract owners.** `claimFor` / `withdrawRefundFor` push USDG to the position's owner, which may be a contract (a smart wallet, the opener). | **Accepted** | USDG has no receive hooks, so a delivery can neither revert nor re-enter because of the recipient; an owner contract that cannot move USDG keeps it, which is that contract's own design. A frozen owner's delivery fails alone. | `test_D2_AFrozenOwnerFailsAlone`, `test_D5_ASmartWalletCanSign` |
| I-6 | Info | **Paginate `marketPositions`.** A caller that asks for every id of a very busy market in one call can hit RPC response limits. | **Accepted** | The view is paginated (`from`, `count`); the client reads it in pages (`packages/client/src/reads/venue.ts`, `reads/positions.ts`) and the keeper uses the client. | `test_D6_MarketPositionsPaginates` |

## 6. Second review, before the first deploy (2026-09-28)

A second review read the contracts, the keeper, the web app and the deploy kit, with two runnable
market-lock proofs of concept. It found no Critical or High issue. The contract findings, and what
became of them (D10 in `DIFF.md` is the settler's part):

| # | Severity | Finding | Status | Fix, or why accepted | Proof |
|---|---|---|---|---|---|
| M-A | Medium | **One escrow, anyone's parameters.** Every market pays out of one USDG balance and `create` accepted any token, up to 255 outcomes, any κ, any seed and any resolver, so an accounting bug reachable only with odd parameters would reach the venue's markets (F1 was exactly this). | **Fixed (D10)** | `create` accepts only the immutable `factory`, which lists only binary κ = 30 USDG markets resolved by StockRoundResolver. A per-market escrow counter (every over-payment reverting inside its own market) was considered and not adopted: with creation closed the odd-parameter regions are unreachable, the normal region is covered by the solvency and conservation invariants and the differential suite, and the counter would touch the mechanism's hot paths. | `test_D10_OnlyTheFactoryCreatesMarkets`, `test_D10_TheAttackerCannotOpenItsOwnMarket` |
| M-B | Medium | **Thin emergency response.** The pause needed a multisig quorum, did not stop `create`, and nothing but the 72 h timeout could delay a resolution. | **Partly fixed (D10)** | A `pauser` the Safe names may pause, never unpause (one key kept offline, the deployer's by default), and the pause stops `create`. Not adopted: a guardian "hold" on resolution (it would let the Safe delay an outcome, a trust trade-off this venue does not want). There is no upgrade path by design; a migration is a new settler and factory, and the client's reads of one settler address are a known limitation for that day. | `test_D10_ThePauserMayPauseButNeverUnpause`, `test_D10_OnlyTheGuardianNamesThePauser`, `test_D10_ThePauseAlsoStopsNewMarkets`, `test_D10_ThePauserCannotReachAnythingButThePause` |
| L-1 | Low | **D9's "finalizing never reverts" was incomplete** for an unbounded κ with a lopsided seed (the 128-bit entry accumulator overflows) and for a finite κ on a token with a huge supply. | **Unreachable (D10)** | Both need a market the factory never lists (USDG, κ = 30, a symmetric seed). Only the factory creates markets. | as M-A |
| L-2 | Low | **`_claim` relied on D8 alone** to never pay a pending stake back as a refund (F1). | **Fixed (D10)** | `_claim` reverts `NotFinalized` on an unfinalized position; one read of a slot the claim already loads. | `test_D10_AClaimRefusesAPositionWhoseVintageIsNotFinal` |
| L-3 | Low | **A garbage answer on the round in effect stranded a market for 72 h.** The band check ran before the uniqueness checks, so the round could never be proven and neither `resolve` nor `voidStale` could run. | **Fixed** | The band is checked only after the round is proven the one in effect; a proven out-of-band answer refunds at once through `voidBadAnswer` (anyone, after the bell), `preview` says 7 BADANSWER, and the keeper voids it after two independent reads agree, as for STALE. A garbage round that is not in effect is still `BadProof`. | `test_AProvenGarbageAnswerVoidsThroughVoidBadAnswer`, `test_VoidBadAnswerNeedsTheRoundsInEffectAndAGarbageAnswer`, the client finder's phase-tape tests |
| L-4 | Low | **The factory accepted a strike time in the past**, so an opener (or a keeper bug) could list a market whose strike price was already known. | **Fixed** | `openUpDown` requires `block.timestamp < strikeTime` (`BadTimes`). The keeper already lists only before the bell. | `test_TimesAreChecked` |
| L-5 | Low | **Delisting a feed with empty details** (`setFeed(feed, 0, "", …, false)`) would erase the ticker the web reads for live markets on that feed. | **Accepted (runbook)** | Live markets settle from their own immutable spec either way; only a label is at stake. `docs/RUNBOOK.md` delists with the feed's same token, ticker and bounds and `allowed = false`. | — |
| L-6 | Low | **The rationale for §5 L-1 overstated the filler's capital at risk.** | **Corrected** | §5 L-1 now states the real cost (gas, about 0.0007 ETH per filled block). | — |
| I-1 | Info | Residue dust can only be claimed by the Safe, one market at a time. | **Accepted** | `claimResidue` is reference code kept byte for byte; the residue is floor dust (micro-USDG per market). | `diff-reference.sh` |
| I-2 | Info | The factory's listing table duplicates data the client also reads (about 66–90k gas per market). | **Accepted** | Kept for view-only enumeration; about 0.00002 ETH per market at observed gas prices. | GAS.md |
| I-3 | Info | The client finds a wallet's positions by walking every listing. | **Tracked (off-chain)** | Moves to the indexed `Entered(owner)` logs in the web/keeper work after the deploy. | — |
| I-4 | Info | A wallet shows a signed bet as an amount paid to HunchVPM; market and side are inside the nonce, so a compromised front end could swap the side. | **Accepted, documented** | Cannot be fixed on chain without a second typed signature; the bet panel shows the side before signing and the position shows it after. | — |

Deploy kit (same review): `DeployRH` wrote the deployment JSON during a dry run (without
`--broadcast`), flipping it to "deployed" with predicted addresses so the real run refused; it now
writes only when broadcasting. It also refuses a keeper (or pauser) that is a Safe owner, and wires
and checks `HunchVPM.factory()` and `pauser()`. The Safe accepts factory ownership right after
`post-deploy.sh` (docs/OPERATOR.md), and `/api/health` reports ownership and wiring.

## 7. The D9 gas margin, re-measured (2026-10-04)

After `foundryup` moved the build machine from forge 1.5.1 to 1.8.4, three D9 gas assertions
failed by about 1% on unchanged contracts: the worst full vintage measured 25.33M against its
25M ceiling, a full binary vintage 8.11M against 8M. The compiled contracts are byte-identical
under both releases. forge 1.8.4 had started running every test call as its own transaction
(`isolate` now defaults to true), and that is the measurement the D9 property needs.

**What the chain charges.** The worst case replayed as real transactions on anvil (200 entries
mined in one block, `finalizeVintage` in the next): `eth_estimateGas` 25,323,974, the figure
forge 1.8.4 reports. The old ceilings were set on a measurement inside one test transaction,
where the 200 entries had already dirtied the slots finalizing rewrites (100 gas a write
instead of 2,900 or 20,000): 23.1M, 2.2M lower than the chain. The D9 property was never at
risk, since 25.3M is still well inside the block, but the documented figure was low.

**The fix.** No contract changed (they are deployed and immutable).

- The D9 tests (`test/VintageStuffing.t.sol`) now measure every block-fit claim as a real
  transaction (isolate mode, set per test): the gas the finalizing transaction needs, 21,000
  + calldata + execution before the refund, with a gas limit of 32M in all. Re-baselined
  ceilings: worst full vintage of any creatable market 26M (measured 25,323,986), full binary
  vintage 9M (measured 7,994,309 through `resolve`, 8,091,727 through the next entry). The
  margin to the 32M limit is 6.7M gas (21%) at the measured worst case and 6M at the ceiling;
  docs/spec/03-contracts.md section Gas gives the full justification.
- The repo pins forge 1.8.4 (`scripts/forge.sh`; the gate fails clearly on any other release)
  and pins `isolate = false` and `dynamic_test_linking = false` in foundry.toml for the
  in-suite tables, which regenerate byte for byte.
- The fork gas table was regenerated: forge 1.5.1's isolate mode reported a call's gas net of
  its refund, so every fork figure published before 2026-10-04 was low by that call's refund
  (2,800 to 42,600 gas). Two cost targets now read over (`enter` first in a block, `resolve`);
  they are cost targets, not safety bounds (docs/spec/03-contracts.md, Gas).

## 8. Reproduce

```
bash scripts/forge.sh build --root contracts --sizes   # forge 1.8.4, the pinned release
bash scripts/forge.sh test --root contracts            # 512 fuzz runs, 128 x 64 invariants
FOUNDRY_PROFILE=ci bash scripts/forge.sh test --root contracts   # 10,000 differential runs, 256 x 128 invariants
bash scripts/diff-reference.sh --check
cd contracts && slither . --config-file slither.config.json --fail-high
```
