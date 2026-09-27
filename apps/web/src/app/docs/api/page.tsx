// S7: keep this page in step with app/api/** as the routes land (shapes below are the contract the web app serves).
import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, CodeBlock, H2, H3, P, Table } from '@/components/docs/prose';
import { TextLink } from '@/components/ui/primitives';
import { SITE_URL } from '@/lib/site';

export const metadata: Metadata = {
  title: 'API',
  description:
    'The Hunch on Robinhood Chain HTTP API: read-only market, position, price, proof and health endpoints, and the relay endpoint for signed bets.',
  alternates: { canonical: '/docs/api' },
};

const TOC = [
  { id: 'conventions', label: 'Conventions' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'prices', label: 'GET /api/prices' },
  { id: 'markets', label: 'GET /api/markets' },
  { id: 'market', label: 'GET /api/markets/[id]' },
  { id: 'positions', label: 'GET /api/positions' },
  { id: 'proof', label: 'GET /api/proof' },
  { id: 'health', label: 'GET /api/health' },
  { id: 'relay', label: 'POST /api/relay/enter' },
] as const;

const LIVE = 'Live';
const LAUNCH = 'With the venue launch';

export default function ApiDoc() {
  return (
    <DocPage slug="api" toc={TOC}>
      <H2 id="conventions">Conventions</H2>
      <Table
        caption="API conventions"
        head={['', '']}
        minWidth={420}
        rows={[
          ['Base URL', <C key="b">{SITE_URL}</C>],
          ['Auth', 'None. Every GET is public, read-only and cached; nothing here holds a secret.'],
          ['Amounts', 'USDG in its smallest unit (6 decimals) as a decimal string: "25000000" is 25.00 USDG.'],
          ['Prices', 'Chainlink answers at 8 decimals as a decimal string: "22566018707" is 225.66.'],
          ['Times', 'Unix seconds (numbers).'],
          ['Outcomes', 'The strings "UP" and "DOWN" (0 and 1 on-chain).'],
          ['Stability', 'Fields may be added, never renamed or removed.'],
        ]}
      />
      <P>
        Anything these endpoints return can also be read straight from the contracts; the API is a cache, not a source of
        truth. See <TextLink href="/docs/contracts">Contracts</TextLink>.
      </P>

      <H2 id="endpoints">Endpoints</H2>
      <Table
        caption="Endpoints"
        head={['Method and path', 'What it returns', 'Cache', 'Status']}
        minWidth={620}
        rows={[
          [<C key="1">GET /api/prices</C>, 'The latest Chainlink reading for every ticker', '15 s', LIVE],
          [<C key="2">GET /api/markets</C>, 'Every market with its book and state', '15 s', LAUNCH],
          [<C key="3">GET /api/markets/[id]</C>, 'One market with every position', '15 s', LAUNCH],
          [<C key="4">GET /api/positions?owner=</C>, "One address's positions across markets", '15 s', LAUNCH],
          [<C key="5">GET /api/proof</C>, 'Counters, settled markets, refund drill, fee sweeps', '60 s', LAUNCH],
          [<C key="6">GET /api/health</C>, "Whether the keeper's jobs are keeping up", 'none', LAUNCH],
          [<C key="7">POST /api/relay/enter</C>, 'Relays a signed bet; returns the transaction hash', 'none', LAUNCH],
        ]}
      />

      <H2 id="prices">GET /api/prices</H2>
      <P>
        One multicall of <C>latestRoundData</C> across the four Chainlink proxies. If the chain read fails, the response is
        still 200 with the last good readings and <C>status: &quot;stale-cache&quot;</C> (or <C>&quot;unavailable&quot;</C>{' '}
        if there has never been one), so a caller can show the age instead of nothing.
      </P>
      <CodeBlock label="200 application/json">{`{
  "status": "live",              // "live" | "stale-cache" | "unavailable"
  "readAt": 1790712345,          // when these readings were taken
  "readings": [
    {
      "ticker": "NVDA",
      "name": "NVIDIA",
      "feed": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
      "answer": "22566018707",   // 8 decimals: 225.66018707
      "roundId": "18446744073709552722",
      "updatedAt": 1790711765    // the round's updatedAt
    }
    // … TSLA, AAPL, COIN
  ]
}`}</CodeBlock>

      <H2 id="markets">GET /api/markets</H2>
      <P>Every market listed by the factory, newest first, read with view calls.</P>
      <CodeBlock label="200 application/json">{`{
  "markets": [
    {
      "id": "12",
      "ticker": "NVDA",
      "family": "weekly",               // "daily" | "weekly"
      "question": "Will NVDA finish the week UP? · Tue Sep 29 → Fri Oct 2",
      "phase": "live",                  // "opens" | "live" | "frozen" | "resolved" | "void"
      "winner": null,                   // "UP" | "DOWN" once resolved
      "strikeTime": 1790688600,
      "finalTime": 1790971200,
      "strike": { "answer": "22410000000", "roundId": "18446744073709552790", "at": 1790688012 },
      "pool": { "up": "120000000", "down": "80000000" },   // accepted, seed included
      "limits": { "minEntry": "1000000", "maxEntry": "100000000", "feeBps": 200 },
      "specId": "0x…",
      "feed": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"
    }
  ]
}`}</CodeBlock>

      <H2 id="market">GET /api/markets/[id]</H2>
      <P>
        One market, its headroom per side and every position in entry order. Seed positions carry{' '}
        <C>&quot;seed&quot;: true</C>. After settlement, each winning position also carries the ordinary-pool comparison.
      </P>
      <CodeBlock label="200 application/json (404 if no such market)">{`{
  "market": { /* as in /api/markets */ },
  "headroom": { "up": "2900000000", "down": "1900000000" },
  "positions": [
    {
      "id": "57",
      "owner": "0x…",
      "side": "UP",
      "offered": "20000000",
      "accepted": "20000000",
      "refused": "0",
      "accrued": "40000000",       // paid if UP won now; only goes up
      "payout": null,              // set after settlement
      "classicPayout": null,       // ordinary-pool comparison, after settlement
      "seed": false,
      "enteredAt": 1790688900,
      "entryTx": "0x…",
      "payoutTx": null
    }
  ],
  "resolution": null               // { "outcome", "strikeRound", "finalRound", "tx" } once settled
}`}</CodeBlock>

      <H2 id="positions">GET /api/positions?owner=0x…</H2>
      <P>Every position an address holds, across markets, with totals. The address is never sent to analytics.</P>
      <CodeBlock label="200 application/json (400 if owner is not an address)">{`{
  "owner": "0x…",
  "positions": [ { "marketId": "12", "question": "…", /* position fields as above */ } ],
  "totals": { "staked": "70000000", "accrued": "96250000", "paid": "0" }
}`}</CodeBlock>

      <H2 id="proof">GET /api/proof</H2>
      <P>
        Everything the <TextLink href="/proof">Proof</TextLink> page shows: contracts and feeds, the Safe&rsquo;s threshold,
        counters (each with the query it came from), settled markets with their rounds, the refund drill and fee sweeps.
        Hunch&rsquo;s own wallets are excluded from the bettor count and reported separately.
      </P>
      <CodeBlock label="200 application/json">{`{
  "status": "deployed",            // or "not-deployed"
  "safe": { "address": "0x…", "threshold": 2, "owners": 3 },
  "counters": [
    { "label": "Markets opened", "value": "24", "unit": "count", "source": "https://robinhoodchain.blockscout.com/…" }
  ],
  "settled": [ { "id": "12", "outcome": "UP", "strike": { … }, "final": { … }, "resolveTx": "0x…", "positions": 9, "totalPaid": "412500000" } ],
  "refundDrill": null,
  "feeSweeps": []
}`}</CodeBlock>

      <H2 id="health">GET /api/health</H2>
      <P>
        200 when every check on the <TextLink href="/docs/keeper#health">keeper page</TextLink> holds, 503 otherwise, listing
        what failed. Suitable for an uptime monitor.
      </P>
      <CodeBlock label="200 or 503 application/json">{`{
  "ok": false,
  "checks": [
    { "name": "open-ran", "ok": true },
    { "name": "settled-on-time", "ok": false, "detail": "market 12 is 41 min past its bell" },
    { "name": "keeper-eth", "ok": true, "detail": "0.0081 ETH" }
  ]
}`}</CodeBlock>

      <H2 id="relay">POST /api/relay/enter</H2>
      <P>
        Relays a signed bet (see <TextLink href="/docs/gasless">Gasless betting</TextLink>). The relayer checks it, simulates
        it, sends <C>enterWithAuthorization</C> and returns the transaction hash. It cannot change what was signed, and
        anyone can send the same call directly instead.
      </P>
      <H3 id="relay-request">Request</H3>
      <CodeBlock label="application/json">{`{
  "from": "0x…",                // the signer; the position's owner
  "marketId": "12",
  "outcome": 0,                 // 0 = UP, 1 = DOWN
  "amount": "25000000",         // USDG units; 1 to 100 USDG in the beta
  "validAfter": "0",
  "validBefore": "1790712645",
  "salt": "0x…",                // 32 random bytes
  "signature": "0x…"            // EIP-712 over USDG's ReceiveWithAuthorization
}`}</CodeBlock>
      <H3 id="relay-response">Response</H3>
      <CodeBlock label="202 application/json">{`{ "txHash": "0x…" }`}</CodeBlock>
      <Table
        caption="Relay errors"
        head={['Status', 'error', 'Meaning']}
        minWidth={520}
        rows={[
          ['400', <C key="a">invalid_request</C>, 'A field is missing or malformed.'],
          ['400', <C key="b">bad_signature</C>, 'Wrong domain, or the code does not equal enterNonce(market, side, amount, salt).'],
          ['400', <C key="c">expired</C>, 'Outside validAfter / validBefore.'],
          ['400', <C key="d">amount_out_of_bounds</C>, 'Below the minimum or above the maximum bet.'],
          ['403', <C key="e">region_blocked</C>, 'Stock-price markets are not offered where the request came from.'],
          ['409', <C key="f">market_closed</C>, 'Not taking bets: past the bell, settled, or new bets paused.'],
          ['422', <C key="g">simulation_failed</C>, 'The call would revert (for example, not enough USDG).'],
          ['429', <C key="h">rate_limited</C>, 'More than 10 requests a minute from this IP or this signer.'],
          ['503', <C key="i">relay_unavailable</C>, 'The relayer is off or out of gas. Send the call yourself.'],
        ]}
      />
      <Callout title="Errors are words">
        <p>
          Every error body is <C>{'{ "error": "<code>", "message": "<a sentence for a person>" }'}</C>. The message says
          what happened and what to do next.
        </p>
      </Callout>
      <P>
        <B>Rate limits:</B> 10 relay requests a minute per IP and per signer. GET endpoints are cached at the edge and have
        no limit beyond fair use.
      </P>
    </DocPage>
  );
}
