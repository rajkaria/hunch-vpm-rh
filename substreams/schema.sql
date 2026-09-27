-- Sink schema for db_out. Apply with:
--   substreams-sink-sql setup "$DSN" hunch-vpm-v0.1.0.spkg
-- which reads this file through the package, not off disk: the `sink:` block in
-- substreams.yaml names it, and `substreams pack` inlines it into the .spkg. Delete that
-- block and the setup command has no DDL to apply. `substreams info <spkg>` shows the
-- embedded copy's size and MD5, which should match this file's.
--
-- Amounts are NUMERIC(78, 0), not BIGINT: they are uint256 on chain, and capacity is
-- kappa times principal, so a market well inside uint128 still overflows a 64-bit column
-- once kappa multiplies it. 78 digits is the width of 2^256 - 1.
--
-- Columns that a market or position row does not know yet are NULL, not zero: an
-- unresolved market has no winner, and a market that was not opened through the factory
-- has no spec. The sink writes NULL for an empty field value.

CREATE TABLE IF NOT EXISTS market (
    id                   TEXT PRIMARY KEY,       -- "{settler}-{market_id}"
    rule                 TEXT NOT NULL,          -- SETTLEMENT_RULE_VESTED | _CLASSIC
    settler              TEXT NOT NULL,
    market_id            BIGINT NOT NULL,
    creator              TEXT,
    outcomes             INTEGER,                -- n = |O|
    kappa                NUMERIC(78, 0),
    kappa_unbounded      BOOLEAN,                -- kappa = 2^256-1, the n-way prescription
    resolution_time      BIGINT,                 -- the freeze, fixed at creation
    status               TEXT,                   -- MARKET_STATUS_OPEN | _RESOLVED | _VOIDED
    winner               INTEGER,                -- -1 until resolved
    spec_id              TEXT,                   -- FeedResolver spec, when opened via the factory
    opener               TEXT,
    seed                 TEXT,                   -- offered per outcome, comma-separated
    created_at_block     BIGINT,
    created_at_timestamp BIGINT,
    created_at_tx        TEXT,
    updated_at_block     BIGINT,
    updated_at_timestamp BIGINT,
    updated_at_tx        TEXT
);

CREATE INDEX IF NOT EXISTS market_status_idx ON market (status);
CREATE INDEX IF NOT EXISTS market_resolution_time_idx ON market (resolution_time);

-- How a market resolves, hashed into its own id so it cannot be edited after stake lands.
CREATE TABLE IF NOT EXISTS resolution_spec (
    id              TEXT PRIMARY KEY,            -- specId
    market          TEXT NOT NULL,
    settler         TEXT NOT NULL,
    market_id       BIGINT NOT NULL,
    oracle          TEXT NOT NULL,
    feed_key        TEXT NOT NULL,
    strike          NUMERIC(78, 0) NOT NULL,     -- int256 at 8 decimals; may be negative
    direction       INTEGER NOT NULL,            -- 0 = above (inclusive), 1 = below
    resolution_time BIGINT NOT NULL,
    max_staleness   BIGINT NOT NULL,             -- seconds; beyond this the market voids
    resolver        TEXT NOT NULL,
    block_number    BIGINT NOT NULL,
    timestamp       BIGINT NOT NULL,
    tx_hash         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS resolution_spec_market_idx ON resolution_spec (market);

-- What the resolver actually read when it settled or voided. A stale void carries an age
-- and no price, which is the point: the reading was the thing that could not be trusted.
--
-- The two events behind this table know disjoint things. Resolved names the market, the
-- winning outcome, the price and the feed's own updatedAt, and says nothing about age.
-- VoidedStale names only the spec and the age. Whatever the emitting event did not carry
-- is NULL here, so every nullable column below is NULL on one of the two paths.
CREATE TABLE IF NOT EXISTS feed_reading (
    id           TEXT PRIMARY KEY,
    spec_id      TEXT NOT NULL,
    resolver     TEXT NOT NULL,
    market_id    BIGINT,                 -- NULL on a stale void: the event names no market
    voided_stale BOOLEAN NOT NULL,
    winner       INTEGER,                -- NULL on a stale void; 0 is a real outcome
    price        NUMERIC(78, 0),         -- NULL on a stale void
    updated_at   BIGINT,                 -- NULL on a stale void
    age          BIGINT,                 -- NULL on a resolution, which logs no age
    block_number BIGINT NOT NULL,
    timestamp    BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS feed_reading_spec_idx ON feed_reading (spec_id);

CREATE TABLE IF NOT EXISTS position (
    id                   TEXT PRIMARY KEY,       -- "{settler}-{position_id}"
    rule                 TEXT NOT NULL,
    settler              TEXT NOT NULL,
    position_id          BIGINT NOT NULL,
    market               TEXT,
    market_id            BIGINT,
    owner                TEXT,
    outcome              INTEGER,
    offered              NUMERIC(78, 0),         -- c_k, the stake offered at entry
    vintage              BIGINT,                 -- block number; 0 is the creator's seed
    seed                 BOOLEAN,
    payout_total         NUMERIC(78, 0),         -- accumulated across Claimed logs
    refund_total         NUMERIC(78, 0),         -- offered - accepted, refused by a book
    entered_at_block     BIGINT,
    entered_at_timestamp BIGINT,
    entered_at_tx        TEXT,
    updated_at_block     BIGINT,
    updated_at_timestamp BIGINT,
    updated_at_tx        TEXT
);

CREATE INDEX IF NOT EXISTS position_market_idx ON position (market);
CREATE INDEX IF NOT EXISTS position_owner_idx ON position (owner);
CREATE INDEX IF NOT EXISTS position_vintage_idx ON position (market, vintage);

-- Entries sharing a block share a vintage and never vest into each other. The settler
-- finalizes a vintage lazily, so finalized_at_block is later than `vintage`.
CREATE TABLE IF NOT EXISTS vintage (
    id                     TEXT PRIMARY KEY,     -- "{settler}-{market_id}-{vintage}"
    market                 TEXT NOT NULL,
    settler                TEXT NOT NULL,
    market_id              BIGINT NOT NULL,
    vintage                BIGINT NOT NULL,      -- the vintage's own block number
    entries                BIGINT NOT NULL,
    finalized_at_block     BIGINT NOT NULL,
    finalized_at_timestamp BIGINT NOT NULL,
    finalized_at_tx        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vintage_market_idx ON vintage (market);

-- Append-only. A position emits at most two Claimed logs: withdrawRefund pays the refused
-- remainder, and the later claim pays the settlement.
CREATE TABLE IF NOT EXISTS settlement (
    id           TEXT PRIMARY KEY,
    position     TEXT NOT NULL,
    settler      TEXT NOT NULL,
    position_id  BIGINT NOT NULL,
    recipient    TEXT NOT NULL,
    payout       NUMERIC(78, 0) NOT NULL,
    refund       NUMERIC(78, 0) NOT NULL,
    block_number BIGINT NOT NULL,
    timestamp    BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_position_idx ON settlement (position);

-- The flooring remainder, swept once by the owner named at creation.
CREATE TABLE IF NOT EXISTS residue (
    id           TEXT PRIMARY KEY,               -- "{settler}-{market_id}"
    market       TEXT NOT NULL,
    settler      TEXT NOT NULL,
    market_id    BIGINT NOT NULL,
    recipient    TEXT NOT NULL,
    amount       NUMERIC(78, 0) NOT NULL,
    block_number BIGINT NOT NULL,
    timestamp    BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL
);

-- One row per book per block in which that book moved. headroom = capacity - vested is
-- the room the book still has to accept stake; when it runs out a stake is refused and
-- refunded rather than reverted. Zero is therefore a meaningful value in these columns,
-- so capacity and headroom are NULL rather than 0 whenever there is nothing finite to
-- report: kappa is unbounded, the rule is classic (neither vesting nor capacity), or the
-- market's creation is behind the indexer's start block and its kappa is unknown. The
-- last case is the one to watch for in a query: rule is SETTLEMENT_RULE_UNSPECIFIED.
CREATE TABLE IF NOT EXISTS book_delta (
    id              TEXT PRIMARY KEY,            -- "{settler}-{market_id}-{outcome}-{block}"
    book            TEXT NOT NULL,               -- "{settler}-{market_id}-{outcome}"
    market          TEXT NOT NULL,
    settler         TEXT NOT NULL,
    market_id       BIGINT NOT NULL,
    outcome         INTEGER NOT NULL,
    rule            TEXT NOT NULL,
    principal       NUMERIC(78, 0),              -- P_w
    vested          NUMERIC(78, 0),              -- V_w
    capacity        NUMERIC(78, 0),              -- C_w = kappa * P_w
    headroom        NUMERIC(78, 0),              -- H_w = C_w - V_w, floored at 0
    unbounded       BOOLEAN NOT NULL,
    principal_delta NUMERIC(78, 0),
    vested_delta    NUMERIC(78, 0),
    block_number    BIGINT NOT NULL,
    timestamp       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS book_delta_book_block_idx ON book_delta (book, block_number);
CREATE INDEX IF NOT EXISTS book_delta_market_idx ON book_delta (market);
