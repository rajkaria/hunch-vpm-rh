# Deployments

One JSON per network, so the app, the subgraph and the client all read the same addresses from
one place.

**Arc testnet is deployed** (`arc-testnet.json`, 2026-09-13, every contract verified on Arcscan). **Arc mainnet is
not** — it has no file, and absence means not deployed.

## Where the file comes from

`contracts/script/Deploy.s.sol` does **not** write it. The script `console.log`s a deployments
JSON to stdout and stops there — `fs_permissions` in `contracts/foundry.toml` grants write
access to `./GAS.md` and nothing else, so the script has no permission to write here. You
create the file from what it printed.

```bash
ORACLE_KIND=stork \
forge script contracts/script/Deploy.s.sol \
  --root contracts \
  --rpc-url arc_testnet \
  --account <keystore-account> \
  --broadcast \
  --verify --verifier blockscout --verifier-url https://testnet.arcscan.app/api/ \
  | tee deploy.log
```

Two things about that command that are easy to get wrong:

- The script path is relative to the directory you are standing in, not to `--root`. From the
  repository root it is `contracts/script/Deploy.s.sol`; `script/Deploy.s.sol --root contracts`
  fails with `contract source info format must be <path>:<contractname>`.
- `--broadcast` needs a signer. `--account <keystore-account>` reads an encrypted Foundry
  keystore and prompts for the password; `--ledger`, `--trezor` and `--interactive` work too.
  **Never `--private-key` on a command line** — it lands in your shell history.

`forge script` wraps the JSON in its own output, indented two spaces under a `== Logs ==`
header, so redirecting stdout straight into the file gives you something that is not JSON. Cut
the block out instead:

```bash
sed -n '/^  {$/,/^  }$/p' deploy.log | sed 's/^  //' > deployments/arc-testnet.json
```

Read the result before committing it — that is a text cut, not a parser, and those six
addresses are the only record of the deploy. Retyping them by hand out of the terminal is an
equally good answer.

## The oracle switch

`ORACLE_KIND` is `stork` (default), `chainlink` or `mock`. Stork is the only provider with a
published Arc testnet address today; the Chainlink adapter takes the feed address per market as
its `feedKey`, so it needs no address at deploy time. `mock` is local chains only. Anything
unrecognised falls through to Stork silently, so check the adapter address the script printed
against the one you expected.

## The files

| File | Network | Chain ID | Present |
|---|---|---|---|
| `arc-testnet.json` | Arc testnet | 5042002 | **yes** — blocks 61840931-61840932 |
| `arc-mainnet.json` | Arc mainnet | 5042 | no — not deployed |

Each file carries `chainId`, `vestedParimutuel`, `classicParimutuel`, `priceOracle`,
`feedResolver` and `marketFactory`, plus `startBlocks` per indexed contract — written by the
wiring script from forge's receipts in `contracts/broadcast/Deploy.s.sol/<chainId>/`, so the
record survives even without the broadcast directory.

## Arc testnet, as deployed

| Contract | Address |
|---|---|
| VestedParimutuel | [`0xC743940C75619f65F6178b7e49c0C3A0bE012Eec`](https://testnet.arcscan.app/address/0xC743940C75619f65F6178b7e49c0C3A0bE012Eec) |
| ClassicParimutuel | [`0x21603b2176aB8495A81fF3B3bE853C64f3860D57`](https://testnet.arcscan.app/address/0x21603b2176aB8495A81fF3B3bE853C64f3860D57) |
| StorkOracle (IPriceOracle adapter) | [`0x5938F12246642aE8E6A47Efbaa72a454EafD4287`](https://testnet.arcscan.app/address/0x5938F12246642aE8E6A47Efbaa72a454EafD4287) |
| FeedResolver | [`0xd9Fde9112a5dE78075fae334D8A9a67fDcAee3f3`](https://testnet.arcscan.app/address/0xd9Fde9112a5dE78075fae334D8A9a67fDcAee3f3) |
| MarketFactory | [`0x0380C6FC136AE64432558e407706a5C7E7652f07`](https://testnet.arcscan.app/address/0x0380C6FC136AE64432558e407706a5C7E7652f07) |
| ChainlinkCreOracle (IPriceOracle + CRE IReceiver) | [`0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621`](https://testnet.arcscan.app/address/0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621) — added later by `script/DeployCreOracle.s.sol`, block 61,858,720 |

Deployer `0x763e4A729cF78e33B8fdE36B9b6f29bBce120dE0`; the whole deploy cost ~0.123 USDC of gas.
Stork's Arc testnet feeds stopped updating on 2026-06-14, so the markets resolve through
`ChainlinkCreOracle` instead: Chainlink Data Feeds, relayed from Sepolia by a CRE workflow
(`cre/`). `chainlinkCreOracle` and `creForwarder` are optional keys, and the wiring script carries
the adapter into the web app. `markets` records every market opened on this network, and the
keeper workflow reads its spec ids from there.

A network that has not been deployed to has no file —
absence means "not deployed yet", never "look somewhere else".

Six places read these addresses and none imports another. After cutting the file:

```bash
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io pnpm wire:testnet   # writes the four committed readers
pnpm wire:check                                                     # what pnpm verify runs
```

The script refuses a file whose `chainId` is wrong or whose addresses hold no code, and prints
the two environment readers (MCP, agent) it cannot write, with the values to set for each.
