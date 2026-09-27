# Facts, with receipts

Every public claim about this venue (landing page, README, `/proof`, video, submission) maps to
a row here with its receipt: a transaction hash, a contract call, or a Blockscout link. A claim
without a receipt is removed or moved to "Not built". Rows are added only from receipts.

## Live now

| Fact | Receipt |
|---|---|
| _Nothing is live yet. The contracts have not been deployed to Robinhood Chain mainnet._ | `deployments/robinhood-mainnet.json` → `"status": "not-deployed"` |

Rows to fill after the operator's deploy (docs/OPERATOR.md), each only with its receipt:

- HunchVPM deployed and verified: address, Blockscout verified link, deploy tx
- StockRoundResolver deployed and verified
- HunchMarketFactory deployed and verified, owned by the Safe (threshold n of m read on-chain)
- Markets opened / settled / voided: factory `listingCount`, resolver `Resolved` events, void txs
- Distinct bettors excluding operator wallets: list of addresses with their first entry tx
- USDG staked / paid out: sums of `Entered.offered` / `Claimed(payout + refund)`
- Early vs late (hero market): market id, positions, payout txs
- Refund drill: void tx, refund txs

## Built, not yet proven on mainnet

| Fact | Evidence in this repository |
|---|---|
| The settler equals the paper's reference with fee 0 and no caps | `contracts/test/Differential.t.sol` (118 vectors + fuzzing) |
| The worked example pays Mei 69.17 USDG (3.46×) and Ben 56.25 USDG (1.125×) | `contracts/test/WorkedExample.t.sol` → `contracts/fixtures/worked-example.json` |
| Only the unique "last round at or before T" pair resolves a market | `contracts/test/StockRoundResolver.t.sol` (property test vs brute force) |
| With entries paused, every non-entry function still works | `contracts/test/HunchVPM.t.sol` (T2.9) |

## Not built (roadmap)

Weekend markets, N-way range markets, a buy-back desk, an agent API, embedded wallets,
notifications. See [VISION.md](../VISION.md).
