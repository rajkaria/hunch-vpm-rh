# Deployments

`robinhood-mainnet.json` is the only place contract addresses are written. The web app, the
keeper and the README read it (or are generated from it: `pnpm wire`, checked in CI). It is
written by `scripts/post-deploy.sh`, which `scripts/go-live.sh` runs after the deploy; its
`status` is `"deployed"` and every receipt is listed in [`docs/FACTS.md`](../docs/FACTS.md).
Before a deploy the status is `"not-deployed"` and every contract address is the zero
address: absence means not deployed.

`feeds-4663.json` holds the feed measurements taken before each ticker was allow-listed
(`scripts/measure-feeds.ts`).
