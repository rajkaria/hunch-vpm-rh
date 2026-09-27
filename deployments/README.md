# Deployments

`robinhood-mainnet.json` is the only place contract addresses are written. The web app, the
keeper and the README read it (or are generated from it). Until the operator runs the deploy
(`docs/OPERATOR.md`), its `status` is `"not-deployed"` and every contract address is the zero
address: absence means not deployed.
