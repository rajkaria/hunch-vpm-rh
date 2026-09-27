# @hunch-vpm/web

The web surface for the vested parimutuel on Arc.

**Live at <https://vpm.playhunch.xyz>** (Vercel project `hunch-vpm`; a push to `main` redeploys).
The apex `playhunch.xyz` is the parent product and is not served from here. Run it locally with
`pnpm --filter @hunch-vpm/web dev`.

Next.js App Router, TypeScript, Tailwind v4, Vitest. Every page renders from a data module
with a fixture implementation as the default, so the whole surface works with no network, no
subgraph and no deployed contracts.

## Local development

From the repository root:

```sh
pnpm install
pnpm --filter @hunch-vpm/web dev        # http://localhost:3000
pnpm --filter @hunch-vpm/web test       # vitest, 124 tests in 6 files
pnpm --filter @hunch-vpm/web typecheck  # next typegen && tsc --noEmit
pnpm --filter @hunch-vpm/web build      # next build
```

`typecheck` runs `next typegen` first because Next 16 generates the route types that
`next-env.d.ts` references. That keeps `pnpm -r --if-present typecheck` working in CI, where
typecheck runs before build.

## Pages

| Route      | What it does                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| `/`        | The board: every market with its book, per-outcome headroom bars, time to freeze |
| `/m/[id]`  | One market in full — the page the rest of the surface exists to lead to          |
| `/agents`  | Leaderboard, human-backed badges, ERC-8004 reputation                            |
| `/claim`   | Settlements, void refunds, refused remainders and residue, one row per transaction |
| `/docs`    | The mechanism, in the paper's language, linked to the paper                       |

The market page carries the vesting curve over the market's life, per-outcome capacity
consumed with refusal explained in plain words, your position and what it would pay if the
market resolved right now, the resolution spec in full, explorer links for the settler, the
resolver and the token, and a vested-against-classic comparison that states the difference as
a number.

## The data layer

```
src/lib/data/
  types.ts          what every page reads
  simulate.ts       replays the settler's bookkeeping to build the fixtures
  fixtures.ts       the dataset, derived from that replay
  fixture-source.ts the default implementation
  live.ts           the same interface over @hunch-vpm/client
  index.ts          which one the pages get   <- the switch
```

`src/lib/data/index.ts` is the only file that chooses. It reads the environment:

| Variable | Effect |
| --- | --- |
| `NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_TESTNET`, `_MAINNET` | Per network. Unset or empty: that network serves fixtures. Set: the live source. |
| `NEXT_PUBLIC_HUNCH_MARKET_IDS_TESTNET`, `_MAINNET` | Comma-separated subgraph ids (`<settler>-<index>`) each board lists. |
| `NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_TESTNET`, `_MAINNET` | Optional, for reputation reads. |

The unsuffixed names from before the network toggle are still read, as testnet; mainnet never
falls back to them. Which network a request reads is the header toggle, mirrored into the
`hunch-vpm.network` cookie so the server renders the same one (`src/lib/network-server.ts`);
`/api/positions` and `/api/claimable` take `?network=` and refuse anything but an Arc.

The market-id lists are also the set of `/m/<id>` routes that exist: the market page
sets `dynamicParams = false`, so an unknown id is a real 404 from the router. Letting unknown
ids render on demand looks more permissive but is worse — an ISR-cached `notFound()` is served
with a 200, so a wrong address would answer "Nothing here" while telling every crawler that
the page exists. The board reads the same list, so a market that is listed always has a page.

Two things about the live source are deliberate and worth knowing before you touch it.

It loads `@hunch-vpm/client` through a dynamic import whose specifier the compiler cannot
follow, and describes the client's surface with local interfaces instead of importing its
types. The client publishes its types from `dist`, and this app has to typecheck and build in
a workspace where that has not been produced — a fresh clone, and CI, where `typecheck` runs
before `build`. A static import would make this app's typecheck depend on another package's
build artefact.

And it is honest about its edges. The client answers questions about a market you can name; it
has no "list every market" read, no leaderboard aggregate, and no entry-level history to draw
a curve from. Where that is true the live source returns an empty list or an empty history and
the page renders the empty state it already has, rather than inventing a number.

### The fixtures are replayed, not typed in

`simulate.ts` runs entries through the settler's own rules — the seed clamp, per-vintage
rationing by `floor(c · H / D)`, `A_w += inflow · S / P_w` against the vintage-start principal,
capacity booked at `κ · accepted`. So the fixture books satisfy the settler's invariants by
construction: `capacity == κ · principal` and `P_o + V_o == Π` on every vested book, both
asserted in `test/fixtures.test.ts`. Numbers typed in by hand would drift from that the first
time anyone edited one, and every headroom bar and payout on the site would then be quoting a
state the contract could never reach.

## Tests

```sh
pnpm --filter @hunch-vpm/web test
```

- `test/units.test.ts` — exact bigint formatting, fixed-width truncation (a claimable balance
  is never rounded up), ppm and multiples.
- `test/vpm.test.ts` — the mechanism arithmetic against hand-computed integers: headroom, the
  headroom-bar maths and its clamping, single-pass rationing including the offer's own demand,
  `floor(s(S + ΔA)/S) == s + floor(s·ΔA/S)`, the classic payout, and both directions of the
  vested-against-classic comparison.
- `test/fixtures.test.ts` — the dataset's invariants and that it covers every state a page has
  to render: open, frozen, resolved, voided, n-way unbounded, a classic-settler market, and a
  position that was actually rationed.
- `test/market-detail.test.tsx` — component tests for the market page: the capacity meter's
  ARIA values, the book table separating a book's own headroom from the room a stake on it
  really has, and the comparator's refusal copy and arithmetic under interaction.

## Brand

Ink `#08080A` ground, Raised `#0E0E12` panels, Paper `#F4F4F2` text, Lime `#C8F04F` for YES and
UP, Coral `#FF6B7A` for NO and DOWN. Gold and Amber are declared as tokens because they belong
to the family, and are not used here — one accent doing one job.

Archivo 800 for display (800 is the ceiling; there is no 900), Inter 400/600 for body,
JetBrains Mono for numerals, loaded through `next/font/google`. Every number is mono and
tabular; prose never is.

Identity assets are the staged SVGs in `public/brand/`, used as drawn — never recoloured,
never stretched, never given a glow, a gradient or a shadow, and the block's corners are never
rounded.

`scripts/generate-icons.mjs` renders the favicon, the app icons and the OpenGraph card from
the identity's own geometry — the half-circle of radius 17 on stroke 12, evaluated per pixel —
so the wordmark in a link preview is the real wordmark rather than a substitute font. The
outputs are committed; a build never runs it. Re-run it with
`pnpm --filter @hunch-vpm/web icons` only if the geometry changes.

## Deploying to Vercel

The repository is a pnpm workspace, so the project has to be pointed at this directory.

**Project settings**

| Setting          | Value                                  |
| ---------------- | -------------------------------------- |
| Framework preset | Next.js                                |
| Root Directory   | `apps/web`                             |
| Install Command  | `pnpm install --frozen-lockfile`       |
| Build Command    | `pnpm build` (the default)             |
| Node version     | 20 or later                            |

Leave "Include files outside the root directory" enabled — it is on by default and this app
extends `../../tsconfig.base.json`.

**Environment variables.** None are required: a network with no subgraph URL serves the fixture
dataset and every page renders. Add a network's variables above to point it at a live subgraph.

**Custom domain.** Done: `vpm.playhunch.xyz` resolves to Vercel and serves production. For a
rebuild from scratch, add it under Project → Settings → Domains and create a `CNAME` on
`playhunch.xyz`:

```
vpm    CNAME    cname.vercel-dns.com.
```

Vercel issues the certificate once the record resolves. The apex `playhunch.xyz` is the main
product and is not touched by this project. `metadataBase` in `src/app/layout.tsx` is
`https://vpm.playhunch.xyz`; change it there if the host ever changes, so OpenGraph URLs stay
absolute and correct.

**Rendering.** The board, the market pages and the agents page render per request, because
which Arc they show is the viewer's cookie. The countdowns are client clocks reading an absolute
deadline.

## Live data, and the key that must not ship

`NEXT_PUBLIC_*` variables are inlined into the bundle every visitor downloads. The Graph
gateway carries its API key in the URL path, so pointing any `NEXT_PUBLIC_HUNCH_SUBGRAPH_URL*` (or
`NEXT_PUBLIC_ERC8004_SUBGRAPH_URL*`) variable at a keyed gateway URL would publish that key to everyone
who opens the site.

`src/lib/data/public-env.ts` refuses it. `readPublicEndpoint` throws at module load, so
`next build` fails rather than shipping the key, with a message that names the variable and the
problem and never prints the value — build logs are not private either. Unset is supported and
falls back to the fixture layer, which is how the app runs in this repository today.

Serve live data either from a keyless endpoint (a Studio query URL, or a gateway that
authenticates by header) or through a proxy you own that holds the key server-side.
