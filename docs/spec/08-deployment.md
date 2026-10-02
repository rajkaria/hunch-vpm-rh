# 08 · Deployment

Every address below was checked with `cast` against chain 4663 on 2026-09-27 (internal
`research-facts.md` holds the commands and outputs). The deploy script re-checks each one
(`cast code` non-empty, expected `symbol()` / `description()` / `decimals()`) and refuses
to run on any mismatch.

## Chain facts

| Fact | Value |
|---|---|
| Chain | Robinhood Chain mainnet, id **4663**, Arbitrum Orbit (Nitro), ArbOS 61, parent chain Ethereum |
| RPC | public `https://rpc.mainnet.chain.robinhood.com` (rate-limited; keeps only ~10 min of historical state; `eth_getLogs` capped at 10k logs). **Use a keyed RPC** for the keeper, forks and round finding: Alchemy `https://robinhood-mainnet.g.alchemy.com/v2/{KEY}` (Robinhood-recommended) or QuickNode `https://{ENDPOINT}.robinhood-mainnet.quiknode.pro/{TOKEN}` |
| Explorer | `https://robinhoodchain.blockscout.com` (API behind a Cloudflare challenge) |
| Block time | ~100 ms; `block.number` is the **L1 block estimate** (~12 s steps) |
| EVM | Cancun/Prague opcodes work (PUSH0, TSTORE, MCOPY); `block.blobbasefee` reverts. Compile `evm_version = "cancun"` |
| Gas | base fee ~0.02 gwei, L1 data fee 0 at time of check; a USDG transfer ≈ 66k gas ≈ $0.004 |
| Sequencer uptime feed | none on this chain (our age bounds are the guard) |
| Transaction filtering | ArbOS 61 lets the chain operator filter transactions; forced L1 inclusion is not a guaranteed escape hatch. Disclosed in the README |

## Addresses we depend on

| What | Address |
|---|---|
| USDG (Paxos, UUPS proxy, 6 decimals, EIP-2612 + EIP-3009, freeze/pause by Paxos) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| USDG EIP-712 domain (hardcoded; no `eip712Domain()`) | name `Global Dollar`, version `1`, chainId `4663`, verifying contract = USDG; separator `0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036` |
| Chainlink feeds + Stock Tokens | table in `04-markets-and-resolution.md` §Tickers |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Safe v1.5.0 SafeProxyFactory / SafeL2 / Safe | `0x14F2982D601c9458F93bd70B218933A6f8165e7b` / `0xEdd160fEBBD92E350D4D398fb636302fccd67C7e` / `0xFf51A5898e281Db6DfC7855790607438dF2ca44b` |
| Safe v1.4.1 SafeProxyFactory / SafeL2 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` / `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| Safe app | `app.safe.global`, short name `robinhood`, tx service `https://api.safe.global/tx-service/robinhood`. **Ledger, Trezor and WalletConnect signers are disabled on this chain: sign with MetaMask or Rabby** |
| Create2 deployer / CreateX | `0x4e59b44847b379578588920cA78FbF26c0B4956C` / `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap v3 SwapRouter02 / QuoterV2 / UniversalRouter | `0xCaf681a66D020601342297493863E78C959E5cb2` / `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` / `0x8876789976decbfcbbbe364623c63652db8c0904` |
| USDG/WETH pool, fee 100 (deepest) | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` |

## Deploy order (`contracts/script/DeployRH.s.sol`)

Inputs by env var name only: `RH_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (local `.env`, set by
the operator with `pbpaste >> .env`), `SAFE_ADDRESS`, `KEEPER_ADDRESS`.

1. **Preflight** (script refuses to continue otherwise): chain id 4663; `SAFE_ADDRESS`
   has code and `getThreshold() ≥ 2` (or the operator passes `--allow-1of1` and the
   README states it); USDG `decimals() == 6`; each feed `decimals() == 8` and
   `description()` matches the ticker; each Stock Token `symbol()` matches; deployer
   holds ≥ 0.002 ETH.
2. `StockRoundResolver()` — no constructor args, no owner.
3. `HunchVPM(guardian = SAFE_ADDRESS, treasury = SAFE_ADDRESS, factory = the address step 4
   deploys to (the deployer's nonce + 1), pauser = PAUSER_ADDRESS or the deployer)`. The
   postflight checks `factory()` equals the deployed factory.
4. `HunchMarketFactory(settler, resolver, USDG, owner = deployer, treasury = SAFE_ADDRESS)`.
5. `setFeed(...)` for each v1 ticker (bounds 93,600 s), `setOpener(KEEPER_ADDRESS, true)`.
6. `transferOwnership(SAFE_ADDRESS)` (two-step); the operator accepts from the Safe app.
7. Write `deployments/robinhood-mainnet.json`: addresses, deploy tx hashes, start blocks,
   feeds with bounds, Safe, keeper, compiler settings, git commit.
8. Verify each contract (below) and open each Blockscout page in a browser to confirm.

A dry run of steps 1–7 against an anvil fork of 4663 (keyed RPC) is required before the
mainnet run: `forge script ... --fork-url $RH_RPC_URL` with no `--broadcast`, then with
`--broadcast` on anvil.

## Verification

1. Blockscout (official Robinhood docs command):
   `forge verify-contract <addr> src/X.sol:X --chain-id 4663 --rpc-url $RH_RPC_URL
   --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/`
2. If Cloudflare blocks it: Sourcify (`--verifier sourcify`), proven working on 4663.
3. Confirm "verified" in a real browser on Blockscout for every contract. Record the
   links in `docs/FACTS.md`.

## Vercel project and domain

- New Vercel project for this repo, root `apps/web`, framework Next.js.
- Domain `vpm.playhunch.xyz` (the `playhunch.xyz` zone is already on Vercel).
- Env vars (production; the operator sets secrets, Claude only names them):
  `NEXT_PUBLIC_CHAIN_ID=4663`, `NEXT_PUBLIC_RH_RPC_URL` (public RPC, read fallback),
  `RH_RPC_URL` (keyed, server only), `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`,
  `KEEPER_PRIVATE_KEY` (sensitive; the keeper is also the relayer), `CRON_SECRET`,
  optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- `vercel.json` crons per `06-keeper-and-ops.md`. `ignoreCommand` must diff
  `$VERCEL_GIT_PREVIOUS_SHA..HEAD` (Hunch's known trap), not `HEAD^`.

## Funding routes (what `/start` tells a bettor, and how the operator funds wallets)

| Route | Steps | Lands as | Notes |
|---|---|---|---|
| **USDC on Arbitrum One or Base → Across → Robinhood Chain** (recommended) | 1 tx on across.to | **USDG** | ~2 s fill. With gasless bets, the bettor needs **no ETH at all** |
| ETH on a major L2 → Relay or Across → Robinhood Chain, then swap on Uniswap (fee-100 USDG/WETH pool) | 2 txs | ETH → USDG | 1 WETH → 2,694.66 USDG quoted (≈7 bps all-in) |
| USDG on Ethereum or Solana → LayerZero OFT / Stargate | 1 tx | USDG | OFT peers set for Ethereum and Solana only |
| ETH on Ethereum → Arbitrum portal (canonical) | ~10 min in | ETH | 7-day withdrawal; slowest |
| Robinhood Wallet | native chain support | — | Moving USDG/ETH from the Robinhood app to the chain, and regional availability, are OPEN |

Operator needs (see internal blockers): ~0.01 ETH across deployer and keeper (the
keeper also pays relayed bets and claim deliveries; at ~$0.004 per call, 0.01 ETH covers
thousands), and ~300 USDG (seeds float ≈ 4 tickers × 2 open markets × 20 = 160 USDG, plus
the golden path, the refund drill and labelled starter grants).
