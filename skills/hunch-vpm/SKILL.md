---
name: hunch-vpm
description: >-
  Read, price and enter markets on Hunch VPM, a USDC prediction market on Arc where
  stake vests into the opposing books the moment it lands and is accepted only up to the
  room those books have to cover it — so part of an entry can be refused and refunded.
  Use when asked to research, price, size, enter, monitor or claim a position on Hunch
  VPM or an Arc prediction market; when reading a market's book, headroom, implied odds
  or time to freeze; when judging a counterparty's ERC-8004 reputation or human-backed
  status; when a stake was only partly accepted and you need to know why; or when
  sweeping a wallet for claimable payouts and refunds. Needs the hunch-vpm MCP server
  (tools vpm_market_book, vpm_agent_reputation, vpm_claimable).
---

# Hunch VPM

A parimutuel prediction market on Arc, settled in USDC, with no market maker and no
order book. You stake on an outcome; if it happens you take a share of the losing side.
The contracts hold the escrow and pay by pull. Nobody — not the venue, not this skill —
can move your funds.

Two rules make it behave differently from any pool you have traded before. Read both
before you size anything.

## Rule 1 — stake vests on arrival, so early money is worth more

In a classic pool every unit pays the same multiple regardless of when it arrived. A
trader who enters ten seconds before the buzzer already knowing the answer takes the
same multiple as the trader who took the risk at open, and dilutes them.

Here, the moment your stake is accepted it vests into the **opposing** books. Stake that
arrives after you vests into yours. Your payout multiple is therefore fixed by *when you
entered*, and it only improves as later money arrives against you.

Consequences you must act on:

- Being early is the edge. The same conviction is worth more at open than at the freeze.
- Late money is not free money. If you arrive near the freeze, expect a thin multiple,
  and check it rather than assuming the displayed odds describe your payout.
- Entries in the same block form one **vintage** and never vest to each other. You do not
  profit from someone who entered in the same block as you.

## Rule 2 — capacity and headroom, so a stake can be refused

A book can only accept stake it can cover. Each outcome's book has

```
capacity  C = κ · P        (P = accepted principal on that outcome; κ = 30 for binary
                            markets, unbounded for n-way)
vested    V                (accepted stake from the other side that has vested into it)
headroom  H = C − V        (what it can still take)
```

When your stake exceeds the available headroom it is **refused, not failed**. The entry
lands, a smaller amount is accepted, and the remainder becomes refundable. You get the
position you could have, plus your money back for the rest.

**The number that binds is not your outcome's headroom.** Stake on YES vests into NO, so
what a YES stake can have accepted is the headroom of the **NO** book. In an n-way market
it is the smallest headroom among every outcome other than yours.

`vpm_market_book` reports both: `headroom` per book, and `acceptsStakeUpTo` per outcome,
which is the one that decides. Pass `stake` and it does the arithmetic for you.

Two caveats that matter when you act on the number:

- It is an upper bound. Other entries in the same block share the same headroom pro rata,
  so a busy block can cut you further.
- It moves. Headroom changes as each vintage finalizes. A number read a minute ago is
  stale.

## Two more rules worth knowing

**The freeze.** Every market has a resolution timestamp fixed at creation and never
movable. An entry at or after it reverts — not partially accepted, refused outright.
Resolution can happen at any time after the freeze without changing anyone's payout,
because the accumulator was frozen there by construction.

**Void.** If a market cannot be resolved — a price feed goes stale, nobody resolves
before the timeout — it voids, and every position refunds at its accepted principal.
No payout, no loss. Stale data voids rather than guesses.

## The tools

All three are read-only. None of them signs anything.

### `vpm_market_book` — before you size anything

Gives the book per outcome, headroom, implied probabilities derived from accepted
principal (not a quoted price), time to freeze, and the acceptance ceiling per outcome.

Reach for it when: deciding whether to enter, sizing an entry, checking whether a market
is still open, or checking how close the freeze is.

```
vpm_market_book { "marketId": "7", "stake": "2500" }
```

Pass `stake` whenever you have an amount in mind. Without it you get the book; with it
you get the answer to "how much of this would actually land". Set
`includeCounterparties: true` when you are about to take the other side of a specific
crowd rather than just checking a price.

On a market that has frozen, resolved or voided, the answer is `enterable: false` and no
per-outcome acceptance at all. That is not the same as "none of it would be accepted":
`enter` reverts there, so there is no transaction to size.

### `vpm_agent_reputation` — before you trust the other side

Gives a wallet's ERC-8004 identity and reputation on Arc, whether an AgentBook proof
binds it to a verified human, and what it has done on this venue.

Reach for it when: one wallet holds most of the opposing stake, you are considering
treating another agent's entries as a signal, or you are sizing exposure to a
counterparty with no history you know of.

```
vpm_agent_reputation { "wallet": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" }
```

Read the answer honestly. Reputation is conduct, not accuracy: a human-backed agent with
perfect feedback can still be wrong about the market. An unregistered wallet is not a red
flag — it is an absence of information, so size as though you know nothing about it. And
`humanBacked: "unknown"` means the flag could not be read, which is not the same as
`"not_backed"`.

### `vpm_claimable` — to collect

Gives everything a wallet can pull right now — settled payouts, refunds of refused
stake, void refunds, residue — each with the exact contract call that pays it.

Reach for it when: a market you hold resolved, an entry was partially accepted, or you
are sweeping periodically.

```
vpm_claimable { "wallet": "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" }
```

The venue pushes nothing. Until one of those calls is signed and sent, the money sits in
escrow with your name on it.

## The loop, worked

A user asks: *"Is there value in the ETH market on Hunch VPM? Put 2,500 USDC on it if
there is."*

**1. Read the book.**

```
vpm_market_book { "marketId": "7", "stake": "2500" }
```

```
Market 7 — Will ETH close above $4,000 on 2026-09-30? (Arc testnet, settler 0x0000…05e7).
Open, freezes in 18d 11h (2026-09-30T18:00:00.000Z).
Accepted pool 1100 USDC, κ 30.

#  outcome  book       implied  headroom    accepts up to
0  YES      1000 USDC  90.9%    29900 USDC  2000 USDC
1  NO       100 USDC   9.1%     2000 USDC   29900 USDC

Most room for new stake: NO — it can have 29900 USDC accepted right now.

A 2500 USDC stake right now:
  YES: 2000 USDC accepted, 500 USDC refused and refundable (capped by outcome 1).
  NO: accepted in full.
```

**2. Read what it means.** The crowd prices YES at 90.9%, but that number comes from
1,100 USDC of accepted principal — a thin book, and the pricing is one participant's
opinion as much as the market's. The NO book is nearly saturated: it can absorb only
2,000 more USDC of vesting, which is exactly why a YES stake is capped there.

If your research says NO, this is a good moment: NO has room for 29,900 and you would be
early on the unfavoured side, which is where vesting pays best. If your research says
YES, you can place 2,000 now and 500 is returned to you.

**3. Check who you would be trading against**, if the opposing book is concentrated.

```
vpm_market_book { "marketId": "7", "includeCounterparties": true }
vpm_agent_reputation { "wallet": "<the largest opposing wallet>" }
```

An unregistered wallet holding the whole other side is not a reason to stay out. It is a
reason not to read their position as information.

**4. Decide the size from the ceiling, not from the wish.** You want 2,500 on YES; 2,000
is what lands. Either accept the partial fill — the refused 500 is refundable
immediately, not at resolution — or take NO, where the full 2,500 fits.

**5. Enter, with your own wallet.** No tool here does this. You build and sign two
transactions against the settler named in the tool's response:

```
approve(settler, 2500000000)         // on USDC, 0x3600…0000, 6 decimals
enter(marketId = 7, outcome = 0, amount = 2500000000)
```

`enter` escrows the full offered amount. How much is accepted is fixed when your
vintage finalizes — the first transaction in a later block that touches the market — so
the refused remainder is withdrawn afterwards, not returned in the same transaction.

Gas on Arc is paid in USDC, the same asset as your stake. Leave room for it.

**6. Confirm what landed, and collect the rest.**

```
vpm_claimable { "wallet": "<your wallet>" }
```

```
amount     kind               market        position       call
500 USDC   refused remainder  0x…05e7-7     0x…05e7-24     withdrawRefund(uint256) with 24
```

Sign that call to get the 500 back. You do not have to wait for the market to resolve.

Note the two ids in that row. The `position` column is how the index addresses the
position, `<settler>-<index>`; the number in the `call` column is the settler's own index,
which is what the function takes. Quote the call column. Never pass the composite id to a
contract.

**7. After resolution**, `vpm_claimable` lists the payout and the call that pays it:

```
1400 USDC  settled payout     0x…05e7-3     0x…05e7-11     claim(uint256) with 11

Position 0x…05e7-11: 1000 USDC of accepted principal plus 400 USDC vested from stake that
arrived later.
```

That second line is the mechanism paying out: 400 USDC of it is what later money vested
into your position because you were there first.

## What you are actually signing

Be explicit with your user about this, every time.

- **Entering a market means sending a transaction from your own wallet.** The MCP server
  is read-only and holds no keys. Nothing in this skill can move funds on your behalf,
  and nothing should be able to.
- **The venue never custodies your funds in the ordinary sense** — they sit in the
  settler contract, claimable only by the position's owner, until you pull them.
- **Stake is at risk.** If your outcome loses, the accepted principal is gone. This is a
  prediction market, not a savings product, and nothing here is financial advice.
- **Approve exactly what you intend to stake.** An unlimited approval to any contract is
  an unlimited liability.
- **Check the settler address** in the tool response against the deployment you trust
  before approving anything. A market can name any settler.
- **A refused remainder is not a failure.** It is money that never left your control in
  spirit and is withdrawable as soon as your vintage finalizes. Withdraw it; do not leave
  it sitting.

## Vocabulary

| term | meaning |
|---|---|
| book | a single outcome's accepted principal, `P` |
| vested | accepted stake from the other side that has vested into a book, `V` |
| capacity | `C = κ · P`, the most a book can take |
| headroom | `H = C − V`, what it can still take. Zero means the next stake against it is refused |
| κ (kappa) | capacity coefficient: 30 for binary markets, unbounded for n-way |
| vintage | the entries in one block; they never vest to each other |
| offered / accepted | what you put up, and the part of it the books could cover |
| refused remainder | `offered − accepted`, refundable once your vintage finalizes |
| freeze | the resolution timestamp, fixed at creation; entries at or after it revert |
| void | a market that cannot be resolved; every position refunds at accepted principal |
| residue | the flooring remainder of the payouts, swept by an owner named at creation |

## Limits of this skill

- It reads a venue; it does not forecast. The tools tell you what the book is, what will
  be accepted and who is on the other side. Whether ETH closes above $4,000 is your
  problem.
- It cannot sign, send or simulate a transaction. Use your own wallet tooling, and quote
  the exact call from the tool response rather than reconstructing it from memory.
- Headroom and odds are read at a point in time. If more than a few blocks have passed
  between reading and signing, read again.
- If the tools return `not_configured`, the server is missing a subgraph endpoint — say
  which variable, from the error's hint, instead of retrying.
