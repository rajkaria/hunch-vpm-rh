# @hunch-rh/client

Everything the Hunch venue on **Robinhood Chain (chain 4663)** needs to read the chain, price a
bet, prepare a gasless entry and build a transaction. It works in Node, a Next.js server and the
browser. It never holds a key and never signs: write helpers return call objects for the caller's
wallet (or the keeper) to send.

Settlement is the Vested Parimutuel as `HunchVPM` runs it: an early call is paid more, a late
entry gets its stake back plus whatever the other side adds after it, markets stay open until the
closing bell, and resolution uses two Chainlink rounds proven on chain. The arithmetic here is a
bigint mirror of the contract, tested against numbers exported from the contract itself.

```ts
import { loadDeployment, makePublicClient, readVenue, formatUsdg } from '@hunch-rh/client';

const deployment = loadDeployment();
const client = makePublicClient({ rpcUrl: process.env.RH_RPC_URL });
const venue = await readVenue(client, deployment);
if (!venue.deployed) console.log('launching soon');
for (const m of venue.markets) console.log(m.question, m.status, formatUsdg(m.totals.pool), 'USDG');
```

## Principles

- **Views only.** Markets and positions are enumerated with view calls (factory listings →
  settler and resolver views) batched through Multicall3. Logs are an optional enhancement (entry
  times, tx links). The public RPC keeps about 10 minutes of state and caps `eth_getLogs`; view
  reads work on it.
- **Exact money.** Amounts are `bigint` base units (USDG 6 decimals, prices 8 decimals).
  Formatting floors: a payout is never rounded up (`69_166_666n` shows as `69.16`).
- **Not deployed is a state, not an error.** Every read returns an empty, truthful snapshot while
  `deployments/robinhood-mainnet.json` says `"not-deployed"`. `readPrices` still reads the v1
  Chainlink feeds so the landing page can show live prices before launch.

## Chain and deployment

| Export | What |
|---|---|
| `robinhoodChain` | viem chain for 4663 (ETH gas, public RPC, Blockscout, Multicall3). Use it in wagmi. |
| `makePublicClient({ rpcUrl?, fallbackRpcUrls?, excludePublicRpc?, timeoutMs?, retryCount?, multicallBatch? })` | `fallback([...http(url, { timeout: 8000, retryCount: 2 })])` over primary → fallbacks → public RPC, with Multicall3 batching. |
| `rpcUrlsFor(options)` | The ordered RPC list a client would use. |
| `addChainParameters(rpcUrl?)` | `wallet_addEthereumChain` params for add-then-switch. |
| `explorerAddressUrl(addr)`, `explorerTxUrl(hash)`, `explorerBlockUrl(n)` | Blockscout links. |
| `loadDeployment({ json?, env? })` | The committed deployment, or the override in `json`, `HUNCH_DEPLOYMENT_JSON` (server, keeper) or `NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON`. Throws `DeploymentError` on an invalid override. |
| `isDeployed(d)`, `deploymentParams(d)`, `feedByTicker(d, t)`, `feedByAddress(d, a)` | Helpers. `deploymentParams` returns bigints. |
| `parseDeployment(input)`, `validateDeployment(value)` | Schema checks (EIP-55 included). |

Browser bundles: Next.js only inlines `process.env.NEXT_PUBLIC_*` when written literally, so pass
it explicitly: `loadDeployment({ json: process.env.NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON })`.

`deployments/robinhood-mainnet.json` is the single source of addresses. After editing it run
`pnpm exec node scripts/wire-deployment.mjs --write` (CI runs `--check`), which regenerates
`src/deployment/embedded.ts` and the README address table between
`<!-- deployment:start -->` and `<!-- deployment:end -->`.

## Constants

`CHAIN_ID` (4663), `USDG_ADDRESS`, `USDG_DECIMALS`, `USDG_EIP712_DOMAIN`,
`USDG_DOMAIN_SEPARATOR` (`0x7a3d…2036`, tested), `MULTICALL3_ADDRESS`, `PRICE_DECIMALS`,
`PRICE_SANITY_MAX`, `UP` (0), `DOWN` (1), `sideOf`, `outcomeOf`, `opposite`, `SCALE`,
`KAPPA_UNBOUNDED`, `MARKET_STATUS`, `PREVIEW_STATUS`, `PREVIEW_STATUS_NAME`, `ENTER_TYPEHASH`,
`RESTRICTED_COUNTRIES` (`US`, `CA`, `GB`, `CH`), `isRestrictedCountry(code)`,
`DRILL_MAX_FINAL_AGE`, `DEFAULT_MAX_AGE`.

## Reads (view calls)

```ts
const venue = await readVenue(client, deployment, { include: 'active' });
const market = await readMarket(client, deployment, 12n);          // null if not listed
const quote = quoteForMarket(market!, parseUsdg('25'), UP);        // exact, open vintage included
const portfolio = await readPositionsByOwner(client, deployment, address);
const prices = await readPrices(client, deployment);               // works before deployment
const proof = await readProof(client, deployment);
```

| Function | Returns |
|---|---|
| `readVenue(client, d, { nowSec?, strikes?, include?, maxListings?, roundReader? })` | `VenueSnapshot { deployed, head, nowSec, entriesPaused, listingCount, markets: MarketView[] }`, newest first. |
| `readMarket(client, d, marketId, { resolution?, ... })` | `MarketDetail` = `MarketView` + `positions: PositionView[]`, `head`, `entriesPaused`, `vintageBlock`, `resolution { rounds, preview }` after the bell. |
| `quoteForMarket(detail, amount, outcome)` | `Quote { offered, accepted, refused, floorIfWin, headroom, problem }`. |
| `readPositionsByOwner(client, d, owner, opts?)` | `OwnerPortfolio { positions: { market, position }[], totals { staked, accepted, deliverable, paidOut, open } }`. |
| `readPrices(client, d)` | `PricesSnapshot { deployed, nowSec, rows: PriceRow[] }` (price, round, age, `oraclePaused`, `allowListed`, `pendingFlatRateCheck`). |
| `readProof(client, d, opts?)` | `ProofSnapshot` counters: markets opened/open/resolved/voided, distinct bettors (openers, keeper and Safe excluded; their bets counted separately), USDG staked, accepted, seeded, paid out, fees taken/accrued/swept, Safe threshold and owners, all market views. |
| `readListings(client, d)` | Factory listings (cheap; the keeper uses it). |
| `readMarketPositions(client, d, marketId)` | Every `{ id, position }` of one market. |
| `readAllPositions(client, d, listings)` | Every position of the given listings. |
| `readChainHead(client)` | `{ blockNumber (L2), l1BlockNumber (vintage clock), timestamp }`. |
| `readMarketActivity(client, d, marketId, { fromBlock? })` | Enhancement from logs: entry tx + time per position, claim txs, resolve/void tx. May throw; degrade to no links. |
| `getLogsChunked(client, { address, event, args?, fromBlock, toBlock, maxRange? })` | `eth_getLogs` with adaptive range splitting (10k-log cap). |
| `callMany(client, calls, chunk?)` | Multicall3 with `allowFailure`, order kept. |

`MarketView` fields: `id`, `listing`, `specId`, `ticker`, `feed`, `stockToken`, `family`
(`daily` · `weekly` · `drill`), `question`, `rules` (the rules box), `status` (`Opens` · `Live` ·
`Frozen` · `Resolved UP` · `Resolved DOWN` · `Void`), `statusCode`, `winner`,
`settledByResolver`, `acceptingBets`, `strikeTime`, `finalTime`, `maxStrikeAge`, `maxFinalAge`,
`voidableAt`, `strike` (price in effect at the opening bell, proven by the round finder, or null),
`strikeProblem`, `live`, `change` (`{ direction, bps, text }`), `kappa`, `books`, `totals`
(`pool`, `up`, `down`, `pendingUp`, `pendingDown`, `paidOut`, `upPpm`, `downPpm`), `headroom`
(`up`, `down`: the largest stake accepted in full now), `pendingCount`, `feeBps`, `minEntry`,
`maxEntry`, `seedPerLeg`, `opener`, `openedAt`.

`PositionView` fields: `id`, `marketId`, `owner`, `outcome`, `side`, `offered`, `accepted`
(null until final), `refused`, `finalized`, `refunded`, `claimed`, `vintage`, `entryAcc`,
`isSeed`, `isOpener`, `accrued` (win payout if its side won now; only goes up), `settlement`
(`{ gross, fee, net, refund, total, deliverable }`), `paidOut` (once claimed), `classicPayout`
(after resolution: what an ordinary pool would have paid).

## Settlement math (exact mirror of the contract)

| Function | Mirrors |
|---|---|
| `headroom(book)` | `_headroom` |
| `accrued(position, ownBook)` | `HunchVPM.accrued` |
| `previewPayout(position, market, winnerBook)` | `previewPayout` |
| `feeOnGain(gross, accepted, feeBps)` | D1 fee, floored |
| `settlementOf(position, market, winnerBook, feeBps)` | what `claim`/`claimFor` would send now |
| `quote({ amount, outcome, books, openVintageDemand?, kappa, minEntry, maxEntry })` | §4.4 single-pass rationing |
| `quoteEntry({ ..., pending, vintageBlock, l1Block })` | rolls a stale vintage first, or joins the current one |
| `rollBooks(books, pending, kappa)`, `rationed(offered, head, demand)`, `seedClamp(seed, kappa)` | `_finalizeVintage`, the §4.4 cap, `_seedClamp` |
| `classicPayouts(positions, winner)` | `ClassicParimutuel` counterfactual |
| `simCreate`, `simEnter`, `simRoll`, `simFinalize`, `simResolve`, `simVoid`, `simSettle`, `simulateMarket(input)` | the whole market, block by block |
| `replayMarket(positions, kappa)`, `accrualPath(positions, kappa, index)` | rebuild from on-chain positions; the "only goes up" curve |
| `WORKED_EXAMPLE`, `workedExample()` | the docs' illustration (label it "Illustration") |

```ts
const { settlement } = workedExample();
formatUsdg(settlement!.positions[2]!.settlement.gross); // "69.16" (Mei, exact 69.166666)
```

## Chainlink rounds

"The price in effect at T" is the answer of the last round with `updatedAt ≤ T`.

| Function | What |
|---|---|
| `findLastAtOrBefore(reader, feed, t)` | `found { round, next, isLatest, sane, provable, age, reads }` · `before-first-round` · `phase-boundary`. Binary search in the proxy's current phase (≤ log2(rounds) + 3 reads); missing rounds skipped. |
| `findResolutionRounds(reader, { feed, strikeTime, finalTime, maxStrikeAge?, maxFinalAge? })` | `{ ok: true, strikeRound, finalRound, strike, final, expected }` or `{ ok: false, problem }`. `expected` is an off-chain hint; the resolver's `preview` decides. |
| `roundReaderFromClient(client)`, `cachedRoundReader(reader)` | Readers (a reverting `getRoundData` reads as a missing round). |
| `phaseOf`, `aggregatorRoundOf`, `proxyRoundId`, `isSaneRound` | Round id helpers. |

## Gasless entry (EIP-3009, USDG's hardcoded domain)

```ts
const salt = randomSalt();
const { validAfter, validBefore } = validityWindow(nowSec, 1800);
const auth = buildEnterAuthorization({ from, hunchVpm: deployment.contracts.HunchVPM.address,
  marketId, outcome: UP, amount, validAfter, validBefore, salt });
const signature = await walletClient.signTypedData({ account: from, ...auth }); // wallet on chain 4663
await fetch('/api/relay/enter', { method: 'POST', body: JSON.stringify({ from, marketId: `${marketId}`,
  outcome: UP, amount: `${amount}`, validAfter: `${validAfter}`, validBefore: `${validBefore}`, salt, signature }) });
```

`enterNonce({ hunchVpm, marketId, outcome, amount, salt, chainId? })`,
`RECEIVE_WITH_AUTHORIZATION_TYPES`, `usdgDomainSeparator()`, `recoverEnterSigner(auth, sig)`.

## Writes (call objects)

Each builder returns `{ address, abi, functionName, args }` for viem `simulateContract` /
`writeContract` or wagmi; `toTransaction(call)` gives raw `{ to, data, value }`.

`enterCall`, `enterWithAuthorizationCall`, `approveUsdgCall`, `claimCall`, `withdrawRefundCall`,
`claimForCall`, `withdrawRefundForCall`, `finalizeVintageCall`, `sweepFeesCall`, `voidMarketCall`,
`resolveCall` ("Resolve it yourself"), `voidStaleCall`, `voidPausedCall`, `openUpDownCall`.

## Calendar, time and copy

- NYSE sessions in America/New_York with `@date-fns/tz` (EDT/EST handled by the IANA zone):
  `isTradingDay`, `openingBell`, `closingBell` (13:00 on early closes), `sessionOn`,
  `nextSession`, `currentOrNextSession`, `sessionInProgress`, `previousSession`,
  `sessionsOfWeek`, `weeklyWindow`, `sessionsBetween`, `etDateOf`, `etTimeOn`, `addDays`,
  `holidayOn`, `earlyCloseOn`, `NYSE_CALENDAR`. Data: `src/calendar/nyse.json` (2026 and 2027,
  read from nyse.com); other years throw `CalendarRangeError`.
- Formatting: `formatUsdg` (floored to the cent), `formatUsdgWithUnit`, `parseUsdg`,
  `parseUsdgInput`, `formatPrice`, `formatPriceExact`, `formatMultiple`, `formatPercent`,
  `formatBps`, `priceChange`, `formatEtTime` ("9:30 am ET"), `formatEtDate` ("Tue Sep 29"),
  `formatEtDateLong`, `formatEtDateTime`, `formatDuration`, `formatAge`, `formatCountdown`,
  `formatAgeBound`.
- Copy: `family(listing)`, `questionFor(listing)`, `rulesBox(market)` (verbatim template, with
  segments for bold UP/DOWN), `REFUND_DRILL_NOTE`, `LATE_BETTOR_RULE`, `ELIGIBILITY_STATEMENT`.

## ABIs

`hunchVpmAbi`, `stockRoundResolverAbi`, `hunchMarketFactoryAbi` (generated from `contracts/out`
by `scripts/gen-abis.mjs`; a contract not yet compiled falls back to the hand-written frozen
interface), `usdgAbi`, `aggregatorV3Abi`, `stockTokenAbi`, `multicall3Abi`, `safeAbi`.

## Redaction

`redactRpcUrl(url)`, `urlSecrets(url)`, `makeRedactor(secrets)`: never print a keyed RPC URL or a
key.

## Tests

`pnpm --filter @hunch-rh/client test`. Fixtures: `test/fixtures/rounds-*.json` are captured from
chain 4663 by `pnpm exec tsx scripts/capture-rounds.ts` (never hand-written);
`contracts/fixtures/*.json` are exported by the Foundry suite from `HunchVPM`.
