# @hunch-rh/web

The web venue for **Hunch on Robinhood Chain**: UP/DOWN prediction markets on Robinhood Stock
Tokens, in USDG on Robinhood Chain (chain 4663), settled from Chainlink rounds. Served at
`rh.playhunch.xyz` once the domain is attached.

Next.js 16 App Router, React 19, Tailwind v4, TypeScript, Vitest. Server components by default;
client code only where something moves (the price tape, countdowns, the menus, copy buttons,
the add-network button).

```sh
pnpm --filter @hunch-rh/web dev        # http://localhost:3000
pnpm --filter @hunch-rh/web test       # vitest + testing-library (jsdom)
pnpm --filter @hunch-rh/web typecheck  # next typegen && tsc --noEmit
pnpm --filter @hunch-rh/web build      # next build
```

## Routes

| Route | What it is | Built in |
| --- | --- | --- |
| `/` | Hero, live Chainlink price tape, the early-vs-late proof card, the markets grid (or the honest launching state), how it works, why early pays more, the powers table, contracts, why Robinhood Chain, FAQ, the country notice | S8 |
| `/how-it-works` | The plain explanation, the worked example, the rules box, what the rule does not do, "For the curious", provenance | S8 |
| `/start` | Get set up in 2 minutes: USDG via Across, other routes, add Robinhood Chain, first bet | S8 |
| `/proof` | Verify it yourself: contracts, feeds, the Safe, powers, settled markets, refund drill, fees, counters | S8 shell, S7 data |
| `/docs/**` | Eleven pages of documentation with a sidebar, a mobile drawer and prev/next | S8 |
| `/m/[id]`, `/portfolio` | Placeholders until the market page and portfolio ship | S7 |
| `/api/prices` | The tape's snapshot (temporary reader) | S8, S7 re-points it |
| `/opengraph-image`, `/twitter-image`, `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` | Share card and SEO | S8 |

## Data, and what is temporary

Everything under `src/lib/live/` is a stand-in until the web reads through `@hunch-rh/client`
(every file carries `TODO(S7)`):

- `prices.ts` reads `latestRoundData` from the four Chainlink proxies in one multicall, through
  `RH_RPC_URL` if set and the public RPC otherwise; a failed read returns the last good snapshot
  with its age (`stale-cache`) rather than a blank.
- `deployment.ts` reads the deployment JSON from `HUNCH_DEPLOYMENT_JSON` /
  `NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON` and otherwise returns "not deployed", with the planned
  venue parameters and the four feeds.
- `venue.ts` returns no markets and no settled market before deployment, so the landing page
  shows the launching state and the worked example labelled "Illustration".
- `proof.ts` returns the /proof page's rows with every counter unread (never zero).
- `types.ts` holds the typed props every data-driven component renders.

`src/content/worked-example.ts` replays the spec's worked example with the contract's own
fixed-point arithmetic; `test/worked-example.test.ts` pins it to the spec table and to
`contracts/fixtures/worked-example.json`. It is the only static set of numbers the site shows.

## Copy rules, enforced

`test/copy-lint.test.tsx` walks every user-facing string in `src` with the TypeScript AST and
fails on an em dash, a hype word, or YES/NO; it also fails if the mechanism's own vocabulary
(vested, parimutuel, vintage, κ, accumulator) appears on any button or on the first screen of
`/`. The hero's words are pinned by an inline snapshot in `test/landing-hero.test.tsx`.

## Design

The Hunch design system (tokens in `src/app/globals.css`): ink ground, white-alpha surfaces,
0.08 hairlines, lime `#C8F04F` for UP and the one primary action per view, coral `#FF6B7A` for
DOWN, Archivo 800 display, Inter body, JetBrains Mono for every number. No glows, no gradient
fills, no blur. Motion is the price tape's drift, a one-time bar growth and a price flash, all
off under `prefers-reduced-motion`. Mobile first: 375 px with a 16 px gutter and no horizontal
scroll.

`scripts/generate-icons.mjs` renders the favicon and app icons from the identity's geometry;
the share card is `src/app/opengraph-image.tsx`.

## Environment

See `.env.example`. None is required for the static pages. `RH_RPC_URL` is server-only;
nothing secret is ever a `NEXT_PUBLIC_` variable.
