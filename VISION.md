# Vision

## What this becomes

A venue where holders of tokenized stocks take small, capped positions on what their stocks
do this week, and are paid for being early rather than for being fast. The payout rule removes
the two things that keep pool markets thin: nobody wants to go first, and operators have to
close betting before the most interesting moment.

## Month 1 (October 2026)

- An external review of the settler diff and the resolver; entry caps raised step by step.
- Every Robinhood Stock Token with a healthy Chainlink feed, daily and weekly.
- **Weekend markets** (Friday close to Monday open, 80 h staleness bound), which the resolver
  already supports.
- First users from Hunch's existing community, Robinhood Wallet users in Asia and the EU, and
  Stock Token communities.

## Month 3

- N-way range markets ("where does NVDA close Friday?") at unbounded capacity with a published
  minimum seed (paper §4.3, §14).
- A venue buy-back desk quoting cash-out from the venue's own model, never from the pool ratio
  (paper §15.3). Positions are already transferable on-chain.
- An agent API and MCP tools so trading agents can quote acceptance and accrued payouts.
- Markets in the main Hunch app (playhunch.xyz) settling on this rail.

## Month 6

- Earnings-week and index markets; seed float management in USDG.
- A market-implied "where does it open Monday" reading for protocols that need a weekend
  reference for Stock Tokens, published from settled books with its limits stated (the late
  pool ratio is not a probability, paper §5.1).
- A legal opinion per target market and a licensing path where one is required.

## How it earns

2% of winners' gains on every settled market. The opening seed is floored in every branch by
the mechanism (P6), so listing every ticker every day is a revolving float, not a subsidy.
Unit economics will be reported from chain data once there is a month of it, not projected.

## What is proven and what is still a hypothesis

Proven only once it has a receipt in [`docs/FACTS.md`](docs/FACTS.md): the mechanism running on
Robinhood Chain in USDG, settling from Chainlink rounds without an operator, refunding on a bad
price, and paying an early bettor more than a late one with real money.

Hypothesis: that retail bettors will bet earlier when early is paid more. The paper's own
simulation found that the payment shape moves volume earlier without making the early price
better (§16). Entry timing on live markets will be measured and published.
