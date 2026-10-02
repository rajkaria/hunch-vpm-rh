# Facts, with receipts

Every public claim about this venue (landing page, README, `/proof`, video, submission) maps to
a row here with its receipt: a transaction hash, a contract call, or a Blockscout link. A claim
without a receipt is removed or moved to "Not built". Rows are added only from receipts.

## Live now

Deployed to Robinhood Chain mainnet (4663) on 2026-10-02 from commit `c8aac85` (the second
review's hardening included) by `bash scripts/go-live.sh`. Explorer:
`https://robinhoodchain.blockscout.com/tx/<hash>`.

| Fact | Receipt |
|---|---|
| HunchVPM is deployed at `0x1c23356536eA8E30F53481b971098aC30DA43576`, source verified | deploy tx `0x3a007ba9e76c889caabbe9049c957f482e9bd26703217fc9168e55344e880bf9`; Sourcify `exact_match` |
| StockRoundResolver is deployed at `0xb3336ab62cB57841CDEA2CA43d62F2D2c5287721`, source verified | deploy tx `0x5deadfcf523257da629b38ac8ab8be3fc06d3e885facd354de19e3c1abeb269b`; Sourcify `exact_match` |
| HunchMarketFactory is deployed at `0x2EdcCA1e40AEACD3ef2d5FcBFEAC5B356e1b6676`, source verified | deploy tx `0xc67939506d4308ed9042f3fe0caac5509e734854c4773aa7107a9419d9329f27`; Sourcify `exact_match` |
| HunchVPM's only market creator is the factory (D10); its pauser is the deployer `0xf2c2975975aE49f02c83F61b7022a292E3725013` (pause only, never resume) | settler `factory()` = the factory, `pauser()` = the deployer |
| The Safe `0x5866308Af35fA8AbD67f88d31695aD029143F336` is 2 of 3; the operator holds all three owner keys | creation tx `0x516e740448b81f55c03ab6c5c0db524d037355cb73f61519e69e8df03e2f1338`; `getThreshold()` = 2, `getOwners()` = 3 |
| The Safe owns the factory, and is the settler's guardian and treasury | Safe tx `0x01ee3783c0add0b53b12132a091ee89ddd38870566cb025828b0fdb38a01de9f` (`acceptOwnership()`); factory `owner()`, settler `guardian()` and `treasury()` = the Safe |
| NVDA, TSLA, AAPL and COIN are allow-listed with 26 h staleness bounds | four factory txs from the deployer (`0x3c0b…de1b`, `0xb465…7417`, `0x7ac3…28fd`, `0x405d…0369`); `feeds(feed)` on the factory |
| The keeper `0xEb420AD181518814B6E3feb89A9d369Da3F5b580` may list markets | factory tx `0xd243…0b4a` (`setOpener`); `openers(keeper)` = true |

Rows to fill as the venue runs, each only with its receipt:

- Markets opened / settled / voided: factory `listingCount`, resolver `Resolved` events, void txs
- Distinct bettors excluding operator wallets: list of addresses with their first entry tx
- USDG staked / paid out: sums of `Entered.offered` / `Claimed(payout + refund)`
- Early vs late (hero market): market id, positions, payout txs
- Refund drill: void tx, refund txs

## Superseded: the first deploy (2026-10-02, never used)

Deployed from commit `0c2caf2`, which predates the second review's hardening (`a23d4a4`: D10,
`voidBadAnswer`, the past-strike guard). It never listed a market or held USDG; the venue was
redeployed from the hardened source and these addresses are not used by the app or the keeper.
The Safe below is the same Safe the redeploy uses.

| Fact | Receipt |
|---|---|
| HunchVPM is deployed at `0x4fB64Dd74E6314C6415E3dE7268ea4Dda8771917`, source verified | deploy tx `0x5e298e144e636e748630eeb953df83aaca7f2ff0c35def191d4e31513d4509fa`; Sourcify `exact_match` (creation and runtime) |
| StockRoundResolver is deployed at `0xE8b25102a2B0414d67FDC2011F3Ba3859b149A62`, source verified | deploy tx `0x34c10e57d5c23f197cef06fac17f67116c7d4cd4004cf4cc8cb7751104ac8fd7`; Sourcify `exact_match` |
| HunchMarketFactory is deployed at `0xcb7055449c98d124A12E5F03fB0eA1D41AF3b7eA`, source verified | deploy tx `0x15fbbec5649f4372ebb18307f58c0335787594ce22309bac587f43457eddc275`; Sourcify `exact_match` |
| The Safe `0x5866308Af35fA8AbD67f88d31695aD029143F336` is 2 of 3; the operator holds all three owner keys | creation tx `0x516e740448b81f55c03ab6c5c0db524d037355cb73f61519e69e8df03e2f1338`; `getThreshold()` = 2, `getOwners()` = 3 |
| The Safe owns the factory, and is the settler's guardian and treasury | Safe tx `0x2b4e41912fa602a9a4b237480fe103c4599e5c4cb6640872433efd2280045f3e` (`acceptOwnership()`); factory `owner()`, settler `guardian()` and `treasury()` = the Safe |
| NVDA, TSLA, AAPL and COIN are allow-listed with 26 h staleness bounds | four factory txs from the deployer (`0x1120…db61`, `0x6dec…fa34`, `0x1d03…6a64`, `0xd41a…b462`); `feeds(feed)` on the factory |
| The keeper `0xEb420AD181518814B6E3feb89A9d369Da3F5b580` may list markets | factory `openers(keeper)` = true |

## Built, not yet proven on mainnet

| Fact | Evidence in this repository |
|---|---|
| The settler equals the paper's reference with fee 0 and no caps | `contracts/test/Differential.t.sol` (118 vectors + fuzzing) |
| The worked example pays Mei 69.17 USDG (3.46×) and Ben 56.25 USDG (1.125×) | `contracts/test/WorkedExample.t.sol` → `contracts/fixtures/worked-example.json` |
| Only the unique "last round at or before T" pair resolves a market | `contracts/test/StockRoundResolver.t.sol` (property test vs brute force) |
| With entries paused, every non-entry function still works | `contracts/test/HunchVPM.t.sol` (T2.9) |
| A used or cancelled USDG authorization cannot book an entry (real USDG does not revert on it) | `contracts/test/fork/ForkE2E.t.sol` against real USDG on a fork of chain 4663 |
| Nobody can choose which Chainlink phase settles a market | `contracts/test/PhaseOverlap.t.sol`, INV-7 with overlapping aggregators |
| The resolver reads the real NVDA, TSLA, AAPL and COIN feeds correctly (Fri 2026-09-25 session) | `contracts/test/fork/ResolverFork.t.sol` |
| The whole launch works on a fork of chain 4663: Safe, deploy, ownership, listing, gasless bet from a wallet with no ETH, replay refused, resolve, delivery, fees, residue | `bash scripts/rehearse-fork.sh` → `REHEARSAL PASSED` |
| The venue runs the golden path end to end (country block, relayed bet, pay-gas bet, cron resolve and deliver, proof card from the settled market) | `apps/web/scripts/local-venue.ts check` → `ALL CHECKS PASSED` |

## Not built (roadmap)

Weekend markets, N-way range markets, a buy-back desk, an agent API, embedded wallets,
notifications. See [VISION.md](../VISION.md).
