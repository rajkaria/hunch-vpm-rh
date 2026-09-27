# 11 · Vision (source for VISION.md)

## What this becomes

A venue where retail holders of tokenized stocks take small, capped positions on what
their stocks do this week, and are paid for being early rather than for being fast. The
mechanism removes the two things that keep pool markets thin: nobody wants to go first,
and operators have to close betting before the most interesting moment.

## Month 1 (October 2026)
- Audit-lite: external review of the ~200-line diff + resolver; raise caps step by step.
- Every Robinhood Stock Token with a healthy Chainlink feed, daily and weekly.
- **Weekend markets** (Friday close → Monday open), which the resolver already supports.
- First 100 users: Hunch's existing community (tournament players and the main app's
  bettors; counts from FACTS.md only), Robinhood Wallet users in Asia and the EU reached through X and
  Telegram, Stock Token communities.

## Month 3
- N-way range markets ("where does NVDA close Friday?") at unbounded κ with a published
  minimum seed (paper §4.3, §14).
- A venue buy-back desk quoting cash-out from the venue's own model, never from the pool
  ratio (paper §15.3); positions are already transferable on-chain.
- Agent API + MCP tools (Hunch already runs both on its main product) so trading agents
  can quote acceptance and accrued payouts.
- Markets in the main Hunch app (playhunch.xyz) settle on this rail.

## Month 6
- Earnings-week and index markets; USDG float management for the seed.
- A market-implied "where does it open Monday" reading for protocols that need a
  weekend reference for Stock Tokens, published from settled books with its limits
  stated (the late pool ratio is not a probability, paper §5.1).
- Legal opinion per target market; licensing path where required.

## Revenue
2% of winners' gains on every settled market, plus the opening seed, which the
mechanism floors in every branch (P6) and which settled negative in none of 5,173
replayed markets (paper §13.4). Unit economics are reported from chain data, not projected, once there is a
month of it.

## What the buildathon validated / what is still a hypothesis
Validated (with receipts in FACTS.md): the mechanism runs on Robinhood Chain in USDG,
settles from Chainlink rounds without an operator, refunds on a bad price, and paid an
early bettor more than a late one with real money.
Hypothesis: that retail bettors will bet earlier when early is paid more. The paper's
own simulation found the payment shape moves volume earlier without making the early
price better (§16). We will measure entry timing on live markets.

## The ask
Founder House time with Arbitrum and Robinhood Chain engineers on: feed coverage and
corporate-action signals for Stock Tokens, USDG distribution to retail wallets, and
Robinhood Wallet dapp connectivity.
