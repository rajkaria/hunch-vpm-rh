# 10 · Risk register

| # | Risk | Likelihood / impact | Mitigation | Fallback |
|---|---|---|---|---|
| R1 | **No outside bettors** by Tuesday, so F3 has only operator wallets | High / fatal for F3 | Recruit before deploy (internal blockers list); starter grants of a few USDG + gas to testers who ask, **labelled on `/proof`** with count and total; daily markets give many chances | Show the early-vs-late proof with labelled starter-grant wallets; never present operator wallets as users |
| R2 | USDG hard to acquire on Robinhood Chain for testers | Medium / high | USDC on Arbitrum/Base → Across → USDG in ~2 s; gasless bets remove the ETH step; `/start` page; starter grants | Operator sends USDG directly to tester wallets (labelled) |
| R3 | Chainlink stock feed slow or silent (Amen-style SPY lag) | Medium / medium | Feed selection by measured print frequency; per-feed `maxFinalAge` from measured heartbeat; stale → proof-based void (refund) | Drop the ticker via `setFeed(allowed=false)` |
| R4 | Feeds update on 0.5% moves or a 24 h heartbeat, 24/5: the "price at the bell" can be hours old and up to ~0.5% off the official print; calm days end FLAT | Certain / medium | "Price in effect at T" definition stated in the rules box; FLAT refunds; flat-rate check per ticker before allow-listing; volatile tickers first | Weekly markets carry the proof if daily ones go FLAT often |
| R5 | Phase change on a feed mid-window (aggregator migration; old and new phases overlap in time) | Low / medium | The resolver proves the round in effect in the highest phase with one (unique pair; nobody can pick a phase); `PhaseBoundary` only beyond 8 phases + page; 72 h void timeout | Operator voids after timeout (anyone can) |
| R6 | Corporate action (split) inside a window | Low / high | Keeper calendar skip; on-chain multiplier check if the token exposes one | Guardian pauses entries on that ticker's new markets; the market voids on its proofs or timeout |
| R7 | Contract bug in the diff | Low / high | Minimal diff, differential + invariant + fork tests, Slither, beta caps (100 USDG per entry, 10 USDG seeds), entries pause | Pause entries; claims keep working |
| R8 | Keeper down (Vercel cron miss) | Medium / low | Anyone can resolve/deliver; "Resolve it yourself" button; health alerts | Operator runs `pnpm keeper run-once` locally |
| R9 | RPC rate limits | Medium / medium | Provider key + public fallback transport; server-side caching | Blockscout API for logs |
| R10 | Regulatory: stock-price binaries to EU retail resemble binary options (ESMA 2018 ban); prediction markets are gambling-regulated in many countries | Medium / high (for a real launch, not the demo) | Geo-block US/CA/UK/CH like Stock Tokens; eligibility checkbox; "beta, unaudited" labels; small caps; README "Legal" section; roadmap item for a legal opinion | State it plainly in the pitch Q&A; do not claim compliance |
| R11 | Wallet can't add/switch chain 4663 (4902 handling) | Medium / medium | add-then-switch; manual network details on `/start` | WalletConnect path |
| R12 | Robinhood Wallet can't connect to dapps | Unknown / medium | Verify at G4 | `/start` says so; MetaMask/Rabby path |
| R13 | Reown/WalletConnect domain not allow-listed | Medium / medium | Operator adds `vpm.playhunch.xyz` on day 1 | injected wallets only |
| R14 | Judges read it as "the London entry again" | Medium / high | Different mechanism, chain, stake asset and contracts; provenance table in README; one line on the London entry, nothing more | — |
| R16 | **Paxos freezes or pauses USDG**, or freezes a winner's address | Low / high | Per-position claims (one frozen winner fails alone); disclosed dependency | None for a contract-level freeze: funds wait until Paxos unfreezes |
| R17 | Chain operator filters transactions (ArbOS 61); no sequencer uptime feed | Low / medium | Age bounds, 72 h void timeout; disclosed | — |
| R18 | Relayer abused (spam signatures) | Low / low | Off-chain checks + simulation before sending; rate limits; gas per bet < $0.01 | Turn relay off; pay-gas path remains |
| R19 | Public RPC keeps ~10 min of state → forks and round finding fail | Certain without a key / high | Keyed Alchemy/QuickNode RPC is a day-1 blocker | — |
| R15 | Deadline slip from scope creep | High / fatal | Battle clock gates (internal); cut order: pay-gas fallback path → proof counters → portfolio polish → second weekly ticker | Ship F1–F3 + S1 only |
