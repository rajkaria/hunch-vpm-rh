# @hunch-rh/web

The web venue for **Hunch on Robinhood Chain**: UP/DOWN prediction markets on Robinhood Stock
Tokens, in USDG on Robinhood Chain (chain 4663), settled from Chainlink rounds. Served at
`vpm.playhunch.xyz` once the domain is attached.

Next.js 16 App Router, React 19, Tailwind v4, TypeScript, Vitest. Server components by default;
client code only where something moves (the trading islands on `/m/[id]` and `/portfolio`, the price tape, countdowns, the menus, copy buttons,
the add-network button).

```sh
pnpm --filter @hunch-rh/web dev        # builds @hunch-rh/client and @hunch-rh/keeper, then next dev
pnpm --filter @hunch-rh/web test       # vitest + testing-library (jsdom)
pnpm --filter @hunch-rh/web typecheck  # next typegen && tsc (workspace packages from source)
pnpm --filter @hunch-rh/web build      # builds the workspace packages, then next build
```

## Routes

| Route | What it is |
| --- | --- |
| `/` | Hero, the live Chainlink price tape, the early-vs-late proof card (the latest settled weekly, else daily, else the worked example labelled "Illustration"), the markets grid (or the honest launching state), how it works, why early pays more, the powers table, contracts, why Robinhood Chain, FAQ, the country notice. ISR, 15 s. |
| `/m/[id]` | One market, trust before movement: question, ticker and status; the verbatim rules box; the prices (opening price with its round, latest price with its age, change in words, countdown); the bet panel; your positions; every bet; after the bell the settlement with "Resolve it yourself". Rendered per request from cached reads; 404 for an id Hunch never listed. |
| `/portfolio` | The connected wallet's positions across every market, totals, and claim buttons for anyone who would rather not wait for delivery. |
| `/proof` | Verify it yourself: contracts (Blockscout verification read live), feeds, the Safe (threshold and owners read on chain), powers, settled markets with their rounds and settlement txs, the refund drill, fee sweeps, live counters with the call each came from. ISR, 60 s. |
| `/how-it-works`, `/start`, `/docs/**` | The explanation, getting set up (add-then-switch through the wallet connection), the documentation. |
| `/api/**` | See `/docs/api`: markets, one market, positions, prices, proof, health, the relay, the cron jobs. |

## Data

`src/lib/server/*` reads the chain through `@hunch-rh/client` (view calls only, batched through
Multicall3): `readVenue`, `readMarket`, `readPositionsByOwner`, `readPrices`, `readProof`, with
logs (`readMarketActivity`, the resolver's events, fee sweeps) as an enhancement that degrades to
nothing. One public client: `RH_RPC_URL` first, the public RPC as the fallback transport; the
keyed URL never reaches the browser or a response.

Every read goes through Next's data cache (`unstable_cache`, tagged): venue and prices 15 s,
markets 5 s, positions 15 s, proof 60 s, settled logs longer. A confirmed bet expires its market
at once (the relay route, or a server action after a pay-gas bet), and the cron jobs expire every
market after they settle or pay anything, so a hard refresh shows what the chain holds. If a read
fails the last good value is served with its age ("Price unavailable, retrying"); with nothing
ever read the page says so rather than showing an empty grid.

`src/lib/api/shapes.ts` maps the client's view models to the documented JSON (bigints as decimal
strings); the market page's client islands start from the server's read and poll the same API.

## Wallets

wagmi 2, loaded on demand: static pages ship no wallet code (the header's Connect button loads it
when pressed, or at once if this browser was connected before). Browser wallets are discovered
over EIP-6963; WalletConnect appears when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set; Coinbase
Wallet (EOA). Wrong network means "Switch to Robinhood Chain", which adds the chain first and then
switches (wallets that never answer 4902 still get the add).

The bet panel's primary button walks connect → switch → sign one USDG authorization (gasless, the
default; relayed by `/api/relay/enter`) → receipt → refresh, or "Pay gas yourself": approve the
exact amount → `enter` → receipt → refresh. A full batch (`VintageFull`) is retried automatically;
every error is a sentence with the next step.

Analytics: Vercel Web Analytics page views and six custom events (`connect_wallet`,
`switch_chain`, `quote_shown`, `bet_submitted`, `bet_confirmed`, `resolve_clicked`). No address,
hash or signature is ever sent.

## Country gate

`src/proxy.ts` (Next 16's name for middleware) reads `x-vercel-ip-country`. For the US, Canada,
the UK and Switzerland every page still renders; the bet panel says "Not available in your
country" and the relay refuses (the keeper checks the same header). Claims, refunds and "Resolve
it yourself" stay available: they move no new stake. It is a front-end control; the contracts are
permissionless.

## Crons

`vercel.json` schedules `/api/cron/open` (`*/10 12-13 * * 1-5`), `/api/cron/resolve`
(`*/2 20-21 * * 1-5` and hourly at :07) and `/api/cron/deliver` (`*/5 * * * *`). Each requires
`Authorization: Bearer ${CRON_SECRET}` (Vercel Cron sends it) and runs `keeper.run(job)`.

## Local rehearsal (E2E)

`scripts/local-venue.ts` deploys the compiled contracts on a local anvil with chain id 4663 (MockUSDG
at USDG's address, so the real EIP-712 domain verifies), funds anvil's first two accounts, lists a
market that is open now, and writes an env file; `check` then drives a running build through a
relayed bet, the country gate, a pay-gas bet, the bell, the resolve and deliver crons, and reads
the settlement back. A build with `NEXT_PUBLIC_E2E=1` adds a "Mock Connector" wallet (anvil's
unlocked accounts) so the whole flow also works in a browser without an extension. The steps are
in the script's header. `next.config.mjs` bakes `NEXT_PUBLIC_E2E` in at build time, so a normal
build can never switch the mock wallet on; a test asserts it is off by default.

## Copy rules, enforced

`test/copy-lint.test.tsx` walks every user-facing string in `src` with the TypeScript AST and
fails on an em dash, a hype word, or YES/NO; it also fails if the mechanism's own vocabulary
(vested, parimutuel, vintage, κ, accumulator) appears on any button or on the first screen of
`/`. The hero's words are pinned by an inline snapshot in `test/landing-hero.test.tsx`.

## Tests

`pnpm --filter @hunch-rh/web test` (T10): the bet panel's state machine on both paths with a
mocked wallet and relay (connect → switch → sign → relayed → confirmed; connect → switch →
approve → enter → confirmed), automatic retry on a full batch, the pay-gas offer when the relay is
down, the quote block against the client's `quoteForMarket` on real-shaped markets (built with
the client's contract mirror), the country gate, the API routes (relay error mapping, cron 401,
health 503), the proof card from a settled market, the data layer's last-good fallback, the
wallet helpers (add-then-switch, error words, analytics scrubbing, E2E off by default), the copy
lint and the hero snapshot.

## Design

The Hunch design system (tokens in `src/app/globals.css`): ink ground, white-alpha surfaces,
0.08 hairlines, lime `#C8F04F` for UP and the one primary action per view, coral `#FF6B7A` for
DOWN, Archivo 800 display, Inter body, JetBrains Mono for every number. No glows, no gradient
fills, no blur. Mobile first: 375 px with a 16 px gutter and no horizontal scroll.

## Environment

See `.env.example` (names only). `RH_RPC_URL`, `KEEPER_PRIVATE_KEY` and `CRON_SECRET` are
server-only; nothing secret is ever a `NEXT_PUBLIC_` variable.
