# 05 · Web app (`apps/web`, served at `vpm.playhunch.xyz`)

Forked from hunch-vpm `apps/web` (Next.js 16 App Router, wagmi 2, viem 2, TanStack
Query 5). The Arc chain, The Graph data layer, Circle/AgentKit/World surfaces and the
Arc market fixtures are removed. Everything reads Robinhood Chain directly.

## Visual system

Hunch design system v1 (`hunch/docs/design/DESIGN-SYSTEM.md`): one matte flat system,
Hunch lime accent `#C8F04F`, no glows, no gradient fills, no blurred glass, display face
`font-display font-extrabold` (800 max, never `font-black`), **every number `font-mono`**,
depth by `border-white/[0.08]` + `bg-white/[0.03]` steps, one accent per view region,
44 px touch targets. Outcomes always appear as the words **UP** and **DOWN**. The single
solid-accent control per view is the primary action (Place bet / Connect).

## Copy rules (every user-visible string)

- Plain words first. The terms "vested", "parimutuel", "vintage", "κ", "accumulator"
  never appear above the fold or in a button. They live on `/how-it-works` under
  "For the curious", each defined on first use.
- No em dashes, no hype words (`hackathon/arsenal/copy/voice-lint.sh` clean).
- Money to the cent, in USDG, `font-mono`. Never round up a payout.
- Every claim on the page is backed by a chain read or links to one. No static numbers
  on the landing page except the test-pinned worked example, labelled "illustration".
- The late-bettor rule is said **before** the bet: "Bet late and you get your stake back
  plus whatever the other side adds after you. Bet early and you collect more."

## Routes

### `/` — landing (server component, revalidate 15 s)

Above the fold, in this order:
1. **Headline:** "Call it early. Get paid more."
   **Sub:** "Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain.
   Open until the closing bell. Settled by Chainlink."
2. **Proof card** (the most important component on the site): the most recently settled
   market with ≥ 1 winning non-seed position, rendered by `<EarlyVsLate>`:
   - question, opening and closing prices in effect (price, round id → explorer),
   - the earliest and the latest winning bettors: entry time (ET), stake, payout,
     multiple, payout tx link,
   - one line: "In an ordinary pool both would have been paid {classicMultiple}×",
   - link "See every bet in this market".
   Fallback order: latest settled weekly → latest settled daily → the worked example from
   `02-mechanism.md` with an "Illustration" label. The label is never dropped.
3. **Live markets grid** (`<MarketCard>` per open market): ticker + Stock Token logo,
   question, opening price (or "Sets at 9:30 ET" with countdown), live Chainlink price and
   change vs strike (UP/DOWN coloured words, not colour alone), countdown to the bell,
   total staked and UP/DOWN split, "Bet now and you'd collect everything the other side
   adds from here" line. Tapping opens `/m/[id]`.

Below the fold: How it works (3 steps: pick UP or DOWN · the earlier you bet, the more of
the other side's money is yours · the bell settles it, Chainlink decides, payouts arrive
automatically), the powers table (from `03-contracts.md`), contract links, the country
notice, footer links to `/proof`, `/how-it-works`, the paper, GitHub.

### `/m/[id]` — market page (server shell + client islands)

Order (trust before movement, per Hunch's market-page rule):
1. Question, ticker, status badge (Opens · Live · Frozen · Resolved UP/DOWN · Void).
2. **Rules box:** the verbatim template in `04-markets-and-resolution.md` §What a bettor
   is told.
3. **Price panel:** strike (price · time · round id · explorer), live price (updated
   {age} ago), change vs strike, countdown to the bell.
4. **Bet panel** (`<StakePanel>`), client:
   - UP / DOWN toggle (words), amount input (1–100 USDG), USDG balance on Robinhood
     Chain (read by address, any connected chain), max.
   - Quote block, recomputed on input: "Accepted now: {min(amount, headroom)} USDG" (and
     "{refused} comes straight back" if any), "If {side} wins, you're paid at least
     {floor} USDG, and this only goes up as people bet {opposite}", "Fee: 2% of
     winnings only", "No ETH needed".
   - Primary action: Connect → Place bet. The default path is **gasless**: the wallet
     signs one USDG `ReceiveWithAuthorization` (EIP-712, USDG's hardcoded domain; nonce =
     `enterNonce(market, side, amount, salt)`), the app posts it to `/api/relay/enter`,
     and the position appears when the relayed tx confirms. No ETH and no approval.
     The wallet must be on Robinhood Chain to sign (MetaMask rejects typed data whose
     domain chainId differs from the active chain), so the button walks connect →
     switch (free, add-then-switch) → sign. Fallback "Pay gas
     yourself": switch to Robinhood Chain → approve → `enter`. Errors in plain words
     with the next step.
   - Acceptance note: "Your bet is matched against the other side within ~15 seconds"
     (vintages close when Ethereum's block number ticks); the refused part, if any, is
     returned automatically.
   - Disabled with the reason when: geo-blocked, entries paused, frozen, not yet open.
5. **Your position(s)** (if connected): stake, accepted, returned, **accrued so far**
   ("If UP wins now: 23.40 USDG · was 20.00 when you bet"), a tiny monotone line of
   accrued over time (`<VestingCurve>` reused).
6. **Book:** every position in entry order: time (ET), side, stake, accrued/payout,
   multiple; seed rows labelled "Hunch opening seed". After resolution: a "Ordinary pool
   would have paid" column (`ClassicParimutuel` math, off-chain, same inputs).
7. **Resolution panel:** after the bell: the two round ids the keeper found, `preview()`
   result, and a **"Resolve it yourself"** button any connected wallet can press
   (calls `StockRoundResolver.resolve` with the proven rounds). After resolution: tx
   links for resolve and for each payout.

### `/portfolio`

Connected wallet's positions across all markets: market, side, stake, status, accrued or
paid, payout tx. Totals. Empty state links to the live markets.

### `/proof` — verify it yourself

- Contract table: HunchVPM, StockRoundResolver, HunchMarketFactory, USDG, each feed:
  address, Blockscout "verified" link, deploy tx.
- Safe: address, threshold / owners count (read on-chain), link to the Safe app.
- The powers table.
- Every settled market: question, strike round, final round, prices, resolve tx, number
  of positions, total paid.
- **Refund drill:** the market that voided on a stale or missing print, with the void tx
  and every refund tx.
- Fees swept to treasury (tx list).
- Live counters read from chain: markets opened, settled, voided; distinct bettor
  addresses (excluding the opener); USDG staked; USDG paid out. Each links to the query
  it came from (a Blockscout API URL or the contract call). The opener's own bets are
  excluded from "bettors" and shown separately.

### `/how-it-works`

Plain explanation, the worked example (numbers imported from the same JSON fixture the
Foundry test pins), what the mechanism does not do (from `02-mechanism.md`), "For the
curious" glossary, link to the paper, the pre-event provenance note.

### `/start` — get set up in 2 minutes

1. Get USDG on Robinhood Chain: **USDC on Arbitrum One or Base → Across** (one
   transaction, arrives as USDG in seconds). Other routes from `08-deployment.md`
   §Funding routes, each with its link. No ETH needed to bet.
2. Add Robinhood Chain to the wallet (button: `wallet_addEthereumChain` then
   `wallet_switchEthereumChain`, add-then-switch logic). Switching costs nothing.
3. Place your first bet (link to the soonest-closing market).

### `/pitch` — investor deck (unlisted)

Fifteen 1920 x 1080 slides scaled to the window (stacked on a narrow portrait screen), outside
the `(venue)` route group so it has no header or footer. `noindex`, not in the sitemap or the
nav. The story runs cover, opportunity, problem, why it stays broken, insight, the research
(the paper), product, more from Hunch (Hunch Cup and Bazaar), traction, business model,
competition, vision, team, the raise, thank you (Raj's email, Telegram and X, each a link). Every number comes from `apps/web/src/content/pitch.ts`
(the worked example from the contract mirror, addresses from the deployment file, the paper's
§13.4, dated production reads, and third-party market figures with their sources named on the
slide).
Keys: arrows/space, Home/End, 1 to 9, F full screen, O overview; the slide is in the hash.
Prints one slide per page; `pnpm --filter @hunch-rh/web pitch:pdf` regenerates
`public/hunch-pitch-deck.pdf` from a running production server.

## Data layer (`apps/web/src/lib/server/*`, via `packages/client`)

- `publicClient` for chain 4663 with a primary RPC (provider from `08-deployment.md`) and
  the public RPC as fallback (`fallback([...])` transport, 8 s timeout, 2 retries).
- **Markets list:** `MarketOpened` logs from the factory since its deploy block (cached
  server-side, 30 s) → multicall `getMarket`, `getBook(0)`, `getBook(1)` per market.
- **Positions:** `marketPositions(marketId, from, count)` → multicall `positions(id)` and
  `accrued(id)`; entry timestamps from `Entered` logs' block times (cached forever once
  final).
- **Prices:** multicall `latestRoundData` on every allow-listed feed (server, 15 s).
- **Resolution:** `Resolved` events of the resolver + `packages/client/rounds.ts` finder.
- API routes: `GET` (cached, no secrets) `/api/markets`, `/api/markets/[id]`,
  `/api/positions?owner=`, `/api/prices`, `/api/proof`, `/api/health`; `POST`
  `/api/relay/enter` (see `06-keeper-and-ops.md`).
- Client math mirrors the contract in `packages/client/src/mechanics.ts` (`accrued`,
  quote against headroom incl. open-vintage demand, classic counterfactual), tested
  against the contract (`07-testing.md` T8).

## Wallets

- wagmi connectors: `injected()` (MetaMask, Rabby, Robinhood Wallet's in-app browser if
  it injects), `walletConnect({ projectId })` (Reown project; `vpm.playhunch.xyz` must be
  on the project's domain allow-list), `coinbaseWallet()`.
- Chain object for 4663 with explorer `robinhoodchain.blockscout.com`, multicall3
  address (verified in `research-facts.md`).
- Wrong network: the primary button becomes "Switch to Robinhood Chain" and uses
  add-then-switch (wallets that do not return 4902 still get the add call).
- After every write: wait for the receipt, then refetch the market and portfolio
  queries; a hard refresh must show the same stake (golden-path step).
- Robinhood Wallet: verify dapp connection (WalletConnect or in-app browser) during the
  G4 golden path. If it cannot connect, `/start` says so plainly and lists the wallets
  that can.

## Geo and eligibility

- `src/proxy.ts` (Next 16's name for middleware) reads `x-vercel-ip-country`. For `US`, `CA`, `GB`, `CH`: pages render
  read-only, the bet panel shows "Not available in your country", and
  `/api/*` write helpers (none exist; all writes are wallet-signed) are unaffected.
- First bet in a session: a one-time checkbox "I am not a resident of the United
  States, Canada, the United Kingdom or Switzerland, and prediction markets are legal
  where I am." Stored in `localStorage` (wrapped in try/catch).
- The README and footer say plainly that the contracts are permissionless and the
  geo-block is a front-end control.

## Analytics (PMF evidence, no personal data)

Vercel Web Analytics page views + custom events: `connect_wallet`, `switch_chain`,
`quote_shown`, `bet_submitted`, `bet_confirmed`, `resolve_clicked`. The funnel
(visits → connects → bets) is reported in `docs/FACTS.md` with the date range. Wallet
addresses are never sent to analytics.

## Performance and resilience

- Landing and market pages render from cached server reads; client islands hydrate the
  bet panel and live price only.
- Every RPC failure degrades to "Price unavailable, retrying" rather than an empty grid;
  the last good snapshot is shown with its age.
- No `loading.tsx` above a page that can `notFound()`.
- Mobile first: 375 px wide with a 16 px gutter, no horizontal scroll.

## Out of scope for v1

Embedded wallets, gas sponsorship, fiat on-ramp widget, notifications, social sharing
images beyond the OG card, agent/MCP surfaces, cash-out.
