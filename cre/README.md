# Chainlink CRE — price relay for Arc testnet

Chainlink publishes Data Feeds on **Arc mainnet** but not on **Arc testnet**. On testnet the
venue's markets resolve from Chainlink prices relayed by a Chainlink Runtime Environment
workflow:

```
Ethereum Sepolia                        Chainlink DON                     Arc testnet
AggregatorV3 ETH / USD, BTC / USD  ──►  hunch-price-relay (this dir)  ──►  KeystoneForwarder 0x76c9…5E62
  latestRoundData at the last            reads, reaches consensus,          verifies the DON signatures
  finalized block                        signs one report                   │
                                                                            ▼
                                                        ChainlinkCreOracle 0x68A7…c621 (IPriceOracle)
                                                                            │
                                                        FeedResolver.resolve(specId) ─► VestedParimutuel
```

On **Arc mainnet** none of this is needed: `ChainlinkFeedOracle` reads the feed directly
(ETH / USD proxy `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364`, from Chainlink's reference data
directory).

| | Arc testnet |
|---|---|
| `ChainlinkCreOracle` | [`0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621`](https://testnet.arcscan.app/address/0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621) (verified) |
| `KeystoneForwarder` (production) | [`0x76c9cf548b4179F8901cda1f8623568b58215E62`](https://testnet.arcscan.app/address/0x76c9cf548b4179F8901cda1f8623568b58215E62) |
| Source feeds (Ethereum Sepolia) | ETH / USD `0x694AA1769357215DE4FAC081bf1f309aDC325306`, BTC / USD `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` |
| Feed keys | `keccak256("ETH / USD")` = `0x62dd…1777`, `keccak256("BTC / USD")` = `0x0e3e…eb93` |

## What the adapter trusts

- Only the **production** `KeystoneForwarder` may deliver. The simulation `MockKeystoneForwarder`
  checks no signatures, so the adapter is never pointed at it.
- A fresh adapter **accepts nothing** until the owner names a workflow owner
  (`setExpectedAuthor`) and/or a workflow id (`setExpectedWorkflowId`). Otherwise any workflow on
  the DON could write a price into it.
- Until `lock()` the deployer can change those, so it is trusted until then. After `lock()`,
  nothing that decides which prices land can change.
- It stores the **source round's timestamp**, not the relay time. A market's `maxStaleness` is
  judged against the feed's real age. Both testnet markets use 5400 s, which is the Sepolia
  feeds' one-hour heartbeat plus room for the relay.
- A round that is not newer than the stored one, non-positive, more than 5 minutes in the future,
  or over 18 decimals is skipped. The rest of the report still lands.

## Run it

Needs [bun](https://bun.com) ≥ 1.2.21 and the CRE CLI with a Chainlink account.

**Install the CLI first** — `cre` is not a package in this repo, so `cre login` on a fresh machine
fails with `command not found: cre`. Chainlink's installer puts the binary in `~/.cre/bin` and
appends a `# cre` PATH line to `~/.zshrc` (no sudo):

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash
source ~/.zshrc
cre version            # v1.33.0 was current on 2026-09-13; anything ≥ 1.0.7 works
```

```bash
cd cre/price-relay
bun install            # postinstall runs `bun x cre-setup` (the Javy plugin)
bun test               # report encoding, checked byte for byte against Solidity abi.encode
bun x tsc --noEmit
```

Put the adapter address in `config.production.json` (and `config.staging.json`) as
`target.oracleAddress`. Then, from `cre/`:

```bash
cre login
cre whoami                                     # shows the workflow owner address and deploy access
cre workflow deploy price-relay --target production-settings
```

Deploying needs **deploy access**, which Chainlink grants per organisation. `cre whoami` shows
`Deploy Access: Not enabled` until then. `cre account access` asks for confirmation and a short
use-case description on a real terminal, so run it yourself; it cannot be answered from a
non-interactive shell. Chainlink replies by email.

Until then the simulation runs the real reads and builds the real report:

```bash
cre workflow simulate price-relay --target staging-settings --non-interactive --trigger-index 0
```

Checked 2026-09-13 with CLI v1.33.0: it compiles, reads ETH / USD 2,478.55 and BTC / USD 76,752.72
from Sepolia at the last finalized block, and encodes both into one report. The write goes
through the mock forwarder, which this adapter correctly refuses — so the zero transaction hash
it prints is expected, and nothing lands on Arc.

After the first deploy, authorise it on the adapter, and lock the adapter once it relays:

```bash
cast send 0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621 "setExpectedWorkflowId(bytes32)" <workflow-id> \
  --rpc-url https://rpc.testnet.arc.io --account arc-deployer
cast send 0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621 "setExpectedAuthor(address)" <workflow-owner> \
  --rpc-url https://rpc.testnet.arc.io --account arc-deployer
# once a PriceRelayed event has landed:
cast send 0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621 "lock()" \
  --rpc-url https://rpc.testnet.arc.io --account arc-deployer
```

Check that a price landed:

```bash
cast call 0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621 "read(bytes32)(int256,uint256)" \
  $(cast keccak "ETH / USD") --rpc-url https://rpc.testnet.arc.io
```

## Not in the pnpm workspace, on purpose

CRE workflows compile to WASM through Javy with bun, and `@chainlink/cre-sdk` pulls a native
plugin at install time. Keeping it out of `pnpm-workspace.yaml` keeps that toolchain out of
`pnpm install --frozen-lockfile` on CI and Vercel. `@chainlink/cre-sdk` is pinned to 1.20.0
because 1.21.0 was published with an unresolvable `workspace:*` dependency.
