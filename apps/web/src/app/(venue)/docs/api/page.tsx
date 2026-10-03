// Keep this page in step with app/api/** and lib/api/shapes.ts: fields may be added, never renamed.
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
  { id: 'cron', label: 'GET /api/cron/[job]' },
] as const;

const SERVED = 'Served';
const EMPTY_UNTIL = 'Served; empty until launch';

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
          ['Freshness', 'Chain reads carry readAt (when they were read) and stale (true when the chain could not be read and this is the last good read).'],
          ['Stability', 'Fields may be added, never renamed or removed.'],
        ]}
      />
      <P>
        Anything these endpoints return can also be read straight from the contracts; the API is a cache, not a source of
        truth. See <TextLink href="/docs/contracts">Contracts</TextLink>. Before the contracts are deployed the read endpoints
        answer with empty lists and <C>&quot;deployed&quot;: false</C>, and the relay refuses.
      </P>

      <H2 id="endpoints">Endpoints</H2>
      <Table
        caption="Endpoints"
        head={['Method and path', 'What it returns', 'Cache', 'Status']}
        minWidth={620}
        rows={[
          [<C key="1">GET /api/prices</C>, 'The latest Chainlink reading for every ticker', '15 s', SERVED],
          [<C key="2">GET /api/markets</C>, 'Every market with its book and state', '15 s', EMPTY_UNTIL],
          [<C key="3">GET /api/markets/[id]</C>, 'One market with every position', '5 s', EMPTY_UNTIL],
          [<C key="4">GET /api/positions?owner=</C>, "One address's positions across markets", '5 to 15 s', EMPTY_UNTIL],
          [<C key="5">GET /api/proof</C>, 'Counters, settled markets, refund drill, fee sweeps', '60 s', EMPTY_UNTIL],
          [<C key="6">GET /api/health</C>, "Whether the keeper's jobs are keeping up", 'none', SERVED],
          [<C key="7">POST /api/relay/enter</C>, 'Relays a signed bet; returns the transaction hash', 'none', 'Served; refuses until launch'],
        ]}
      />

      <H2 id="prices">GET /api/prices</H2>
      <P>
        One multicall of <C>latestRoundData</C> across the Chainlink proxies in the deployment file. If the chain read fails,
        the response is still 200 with the last good readings and <C>status: &quot;stale-cache&quot;</C> (or{' '}
        <C>&quot;unavailable&quot;</C> if there has never been one), so a caller can show the age instead of nothing.
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
      <P>Every market listed by the factory, newest first, read with view calls. 503 if the chain has never been readable.</P>
      <CodeBlock label="200 application/json">{`{
  "deployed": true,
  "status": "deployed",
  "entriesPaused": false,
  "readAt": 1790712345, "stale": false,
  "markets": [
    {
      "id": "12",
      "href": "/m/12",
      "ticker": "NVDA",
      "family": "weekly",               // "daily" | "weekly" | "drill"
      "question": "Will NVDA finish the week UP? · Tue Sep 29 → Fri Oct 2",
      "phase": "live",                  // "opens" | "live" | "frozen" | "resolved" | "void"
      "status": "Live",                 // the same, in words: "Resolved UP", "Void", …
      "winner": null,                   // "UP" | "DOWN" once resolved
      "strikeTime": 1790688600,
      "finalTime": 1790971200,
      "strike": { "answer": "22410000000", "roundId": "18446744073709552790", "at": 1790688012 },
      "strikeProblem": null,
      "live": { "answer": "22566018707", "roundId": "18446744073709552799", "at": 1790711765 },
      "change": { "direction": "UP", "bps": 69, "text": "+0.69%" },
      "pool": { "up": "120000000", "down": "80000000" },   // accepted, seed included
      "totals": { "pool": "200000000", "up": "120000000", "down": "80000000",
                  "pendingUp": "0", "pendingDown": "0", "paidOut": "0" },
      "headroom": { "up": "2300000000", "down": "3500000000" },
      "limits": { "minEntry": "1000000", "maxEntry": "100000000", "feeBps": 200 },
      "acceptingBets": true,
      "maxStrikeAge": 93600, "maxFinalAge": 93600, "voidableAt": 1791230400,
      "seedPerLeg": "10000000", "opener": "0x…", "openedAt": 1790680000,
      "specId": "0x…",
      "feed": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
      "stockToken": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
      "rules": { "heading": "How this market settles.", "segments": [ … ], "text": "…" }
    }
  ]
}`}</CodeBlock>

      <H2 id="market">GET /api/markets/[id]</H2>
      <P>
        One market, its headroom per side and every position in entry order. Seed positions carry{' '}
        <C>&quot;seed&quot;: true</C>. After the bell it also carries the two rounds the round finder proved and what the
        resolver&rsquo;s <C>preview</C> says about them; after settlement, each position carries what it was paid and what an
        ordinary pool would have paid. 404 if Hunch never listed the id.
      </P>
      <CodeBlock label="200 application/json (404 if no such market)">{`{
  "market": { /* as in /api/markets */ },
  "headroom": { "up": "2900000000", "down": "1900000000" },
  "positions": [
    {
      "id": "57",
      "marketId": "12",
      "owner": "0x…",
      "side": "UP",
      "offered": "20000000",
      "accepted": "20000000",      // null until its batch is matched on chain
      "refused": "0",
      "accrued": "40000000",       // paid if UP won now; only goes up
      "payout": null,              // after settlement: paid for the settlement, after the fee
      "classicPayout": null,       // ordinary-pool comparison, after resolution
      "seed": false,
      "opener": false,             // placed by Hunch's own listing wallet
      "finalized": true, "refunded": false, "claimed": false,
      "vintage": "21345678",       // Ethereum block of entry (0 for the seed)
      "settlement": { "gross": "0", "fee": "0", "net": "0", "refund": "0", "total": "0", "deliverable": false },
      "paidOut": null,
      "enteredAt": 1790688900,     // from logs; null when they cannot be read
      "entryTx": "0x…",
      "payoutTx": null
    }
  ],
  "resolution": null,              // once settled: { "outcome": "UP" | "DOWN" | "FLAT" | "VOID",
                                   //   "reason": null | "flat" | "stale" | "paused" | "timeout",
                                   //   "strikeRound", "finalRound", "tx" }
  "head": { "blockNumber": "…", "l1BlockNumber": "…", "timestamp": 1790712345 },
  "entriesPaused": false,
  "vintageBlock": null,            // the open batch's Ethereum block
  "kappa": "30",
  "books": [ { "principal": "…", "acc": "…", "capacity": "…", "vested": "…", "demand": "…", "live": "…" }, { … } ],
  "finder": null,                  // after the bell: { "ok", "strikeRound", "finalRound", "strike", "final", "expected", "problem" }
  "preview": null,                 // after the bell: { "status", "name", "strikeAnswer", "strikeAt", "finalAnswer", "finalAt" }
  "activity": true,                // entry times and transaction links were read from logs
  "readAt": 1790712345, "stale": false
}`}</CodeBlock>

      <H2 id="positions">GET /api/positions?owner=0x…</H2>
      <P>
        Every position an address holds, across markets, with totals. The address is never logged and never sent to analytics.
        30 requests a minute per IP.
      </P>
      <CodeBlock label="200 application/json (400 if owner is not an address)">{`{
  "owner": "0x…",
  "deployed": true,
  "positions": [ { "marketId": "12", "question": "…", "ticker": "NVDA", "href": "/m/12",
                   "phase": "live", "status": "Live", "winner": null, "finalTime": 1790971200, "open": true,
                   /* position fields as above */ } ],
  "totals": {
    "staked": "70000000",
    "accrued": "96250000",        // what each open position is paid if its side wins now, summed
    "paid": "0",                  // settlement payouts already sent, after the fee
    "accepted": "70000000",
    "deliverable": "0",           // what claims and refunds would deliver now
    "open": 2
  },
  "readAt": 1790712345, "stale": false
}`}</CodeBlock>

      <H2 id="proof">GET /api/proof</H2>
      <P>
        Everything the <TextLink href="/proof">Proof</TextLink> page shows: contracts and feeds, the Safe&rsquo;s threshold,
        counters (each with the call it came from), settled markets with their rounds, the refund drill and fee sweeps.
        Hunch&rsquo;s own wallets are excluded from the bettor count and reported separately.
      </P>
      <CodeBlock label="200 application/json">{`{
  "status": "deployed",            // or "not-deployed"
  "contracts": [ { "name": "HunchVPM", "role": "…", "address": "0x…", "deployTx": "0x…", "verified": true } ],
  "feeds": [ { "name": "NVDA / USD", "address": "0x…", … } ],
  "safe": { "address": "0x…", "threshold": 2, "owners": 3 },
  "counters": [
    { "label": "Markets opened", "value": "24", "unit": "count",
      "source": "https://robinhoodchain.blockscout.com/address/0x…?tab=read_contract",
      "sourceLabel": "factory.listingCount()", "note": null }
  ],
  "settled": [ { "id": "12", "question": "…", "outcome": "UP", "strike": { … }, "final": { … },
                 "resolveTx": "0x…", "positions": 9, "totalPaid": "412500000" } ],
  "refundDrill": null,             // { "id", "status": "listed" | "refunded", "reason", "voidTxUrl", "refunds": [ … ] }
  "feeSweeps": [ { "tx": "0x…", "amount": "1200000", "at": 1790712345 } ],
  "bettors": { "distinct": 31, "excluded": [ "0x…" ], "operatorBets": 4, "bets": 88 },
  "usdg": { "staked": "…", "accepted": "…", "seeded": "…", "paidToBettors": "…", "paidOut": "…",
            "feesTaken": "…", "feesAccrued": "…", "feesSwept": "…" },
  "missing": [],                   // log-based sections that could not be read just now
  "readAt": 1790712345, "stale": false
}`}</CodeBlock>

      <H2 id="health">GET /api/health</H2>
      <P>
        200 when every check on the <TextLink href="/docs/keeper#health">keeper page</TextLink> holds, 503 otherwise, listing
        what failed. Never cached. Suitable for an uptime monitor.
      </P>
      <CodeBlock label="200 or 503 application/json">{`{
  "ok": false,
  "deployed": true,
  "nowSec": 1790712345,
  "checks": [
    { "name": "rpc-head", "ok": true, "detail": "latest block is 1 s old" },
    { "name": "settlement", "ok": false, "detail": "market 12 is 41 min past its bell" },
    { "name": "keeper-eth", "ok": true, "detail": "0.0081 ETH" },
    { "name": "market-reads", "ok": true, "detail": "2 open markets read current (oldest 4s)" },
    { "name": "market-logs", "ok": true, "detail": "/m/1 entry times and links read (2 entries)" }
  ]
}`}</CodeBlock>

      <H2 id="relay">POST /api/relay/enter</H2>
      <P>
        Relays a signed bet (see <TextLink href="/docs/gasless">Gasless betting</TextLink>). The relayer checks it, simulates
        it, sends <C>enterWithAuthorization</C>, waits up to ten seconds for the receipt and returns the transaction hash. It
        cannot change what was signed, and anyone can send the same call directly instead.
      </P>
      <H3 id="relay-request">Request</H3>
      <CodeBlock label="application/json">{`{
  "from": "0x…",                // the signer; the position's owner
  "marketId": "12",
  "outcome": 0,                 // 0 = UP, 1 = DOWN
  "amount": "25000000",         // USDG units; 1 to 100 USDG in the beta
  "validAfter": "0",
  "validBefore": "1790712645",  // at least 30 s and at most 1 hour from now
  "salt": "0x…",                // 32 random bytes
  "signature": "0x…",           // EIP-712 over USDG's ReceiveWithAuthorization
  "chainId": 4663,              // optional: checked if present
  "hunchVpm": "0x…"             // optional: checked if present
}`}</CodeBlock>
      <H3 id="relay-response">Response</H3>
      <CodeBlock label="200 application/json">{`{ "ok": true, "txHash": "0x…", "nonce": "0x…", "receipt": "confirmed" }   // or "pending" / "reverted"`}</CodeBlock>
      <Table
        caption="Relay errors"
        head={['Status', 'error', 'Meaning']}
        minWidth={520}
        rows={[
          ['400', <C key="a">invalid_request</C>, 'A field is missing or malformed.'],
          ['400', <C key="b">bad_signature</C>, 'Wrong domain, or the signature does not match this wallet, market, side and amount.'],
          ['400', <C key="b2">contract_signer</C>, 'A smart-contract wallet (ERC-1271) signed it: gasless bets need a regular wallet signature. Pay gas yourself.'],
          ['400', <C key="c">expired</C>, 'Outside validAfter / validBefore, or valid for longer than an hour.'],
          ['400', <C key="d">amount_out_of_bounds</C>, 'Below the minimum or above the maximum bet.'],
          ['403', <C key="e">region_blocked</C>, 'Stock-price markets are not offered where the request came from.'],
          ['404', <C key="e2">market_not_found</C>, 'Hunch never listed this market.'],
          ['409', <C key="f">market_closed</C>, 'Not taking bets: past the bell, settled, or new bets paused.'],
          ['409', <C key="f2">already_used</C>, 'This signature was already used. Sign a new bet.'],
          ['422', <C key="g0">insufficient_balance</C>, 'Not enough USDG in the signing wallet on Robinhood Chain.'],
          ['422', <C key="g">simulation_failed</C>, 'The call would revert; the message says why.'],
          ['429', <C key="h">rate_limited</C>, 'More than 10 requests a minute from this IP or this signer.'],
          ['502', <C key="h2">relay_failed</C>, 'The relayer could not confirm the send. It may have landed: send the SAME body again (USDG accepts a signature once, so this never bets twice).'],
          ['503', <C key="h3">busy</C>, 'Many bets landed in this Ethereum block. Send the same body again after retryAfter seconds.'],
          ['503', <C key="i">relay_unavailable</C>, 'The relayer is off or out of gas. Send the call yourself.'],
          ['503', <C key="j">not_deployed</C>, 'Hunch is not deployed yet.'],
        ]}
      />
      <Callout title="Errors are words">
        <p>
          Every error body is{' '}
          <C>{'{ "ok": false, "error": "<code>", "reason": "<relayer code>", "message": "<a sentence for a person>", "next": "retry" | "retry-same" | "sign-again" | "pay-gas" | "get-usdg" | "wait" | "none" }'}</C>
          . The message says what happened; <C>next</C> says what to do.
        </p>
      </Callout>
      <P>
        <B>Rate limits:</B> 10 relay requests a minute per IP and per signer, per server instance. GET endpoints are cached at
        the edge and have no limit beyond fair use, except positions (30 a minute per IP).
      </P>

      <H2 id="cron">GET /api/cron/[job]</H2>
      <P>
        For the scheduler only: <C>open</C>, <C>resolve</C> and <C>deliver</C> run the keeper&rsquo;s jobs and return its
        report. Every request needs <C>Authorization: Bearer</C> with the deployment&rsquo;s cron secret; anything else is 401.
        Every job is idempotent, and every action it takes, anyone can take.
      </P>
    </DocPage>
  );
}
