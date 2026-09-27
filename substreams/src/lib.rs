//! Substreams modules over the Hunch VPM settlers.
//!
//! The handlers here are deliberately thin. Every one of them decodes its inputs, hands
//! them to a plain function in one of the sibling modules, and encodes the result. All
//! the logic lives in those functions, because a `#[substreams::handlers::*]` function is
//! rewritten into an `extern "C"` entry point and cannot be called from a test.
//!
//! Module graph:
//!
//! ```text
//!   params ─┬─> map_markets ──────> store_markets ─┐
//!           │        │                             │
//!           └─> map_positions ──> store_positions ─┤
//!                    │                             │
//!                    └─────────────────────────────┴─> store_books
//!                                                            │
//!                                    map_book_deltas <────────┘
//!
//!   db_out <── map_markets, map_positions, map_book_deltas
//! ```
//!
//! `store_markets` holds each market's creation shape — n, kappa and which settlement
//! rule it runs under — because that is what the book accounting needs and only
//! `MarketCreated` carries it. `store_positions` holds the market and outcome behind each
//! position id, because a `Claimed` log carries only the id and its refund has to be
//! attributed back to a book.

// `#[substreams::handlers::*]` rewrites each handler into an `extern "C" fn(*mut u8,
// usize)` that the runtime calls with a pointer into the module's own linear memory.
// Clippy sees a public function dereferencing a raw pointer and asks for `unsafe`, which
// the macro cannot emit and which would not help: the host, not a Rust caller, supplies
// the pointer. The allow is on the crate because the lint fires on generated code.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod abi;
pub mod amounts;
pub mod books;
pub mod db;
pub mod deltas;
pub mod keys;
mod log_meta;
pub mod markets;
pub mod params;
pub mod pb;
pub mod positions;
#[cfg(test)]
mod testkit;

use anyhow::Context;
use substreams::errors::Error;
use substreams::pb::substreams::Clock;
use substreams::prelude::*;
use substreams::scalar::BigInt;
use substreams::store::{
    DeltaBigInt, Deltas, StoreAddBigInt, StoreGetBigInt, StoreGetProto, StoreSetProto,
};
use substreams_database_change::pb::sf::substreams::sink::database::v1::DatabaseChanges;
use substreams_ethereum::pb::eth::v2 as eth;

use crate::books::{MarketLookup, MarketShape, PositionLookup};
use crate::deltas::{BookReader, KeyDelta};
use crate::markets::is_create;
use crate::params::Contracts;
use crate::pb::hunch_vpm_v1::{
    BookDeltas, Market, MarketOp, Markets, PositionRef, Positions, SettlementRule,
};

substreams_ethereum::init!();

#[substreams::handlers::map]
fn map_markets(params: String, block: eth::Block) -> Result<Markets, Error> {
    let contracts = parse_params(&params)?;
    Ok(markets::map(&contracts, &block))
}

#[substreams::handlers::map]
fn map_positions(params: String, block: eth::Block) -> Result<Positions, Error> {
    let contracts = parse_params(&params)?;
    Ok(positions::map(&contracts, &block))
}

/// The creation shape of every market, keyed by settler and market id.
///
/// Only `MARKET_OP_CREATE` rows are written: the later lifecycle rows know the status but
/// not n or kappa, and overwriting with a partial row would erase what the books need.
/// The live status lives in the `market` table, not here.
#[substreams::handlers::store]
fn store_markets(markets: Markets, store: StoreSetProto<Market>) {
    for market in &markets.markets {
        if !is_create(market) {
            continue;
        }
        let ordinal = market.meta.as_ref().map(|m| m.ordinal).unwrap_or_default();
        store.set(
            ordinal,
            keys::market_key(&market.settler, market.market_id),
            market,
        );
    }
}

/// The market and outcome behind every position id.
#[substreams::handlers::store]
fn store_positions(positions: Positions, store: StoreSetProto<PositionRef>) {
    for (position_id, settler, reference) in books::position_refs(&positions) {
        store.set(0, keys::position_key(&settler, position_id), &reference);
    }
}

/// Per-outcome principal, vested and capacity.
///
/// See `books.rs` for what these numbers are and are not: they are built on the offered
/// basis and corrected when a refused remainder is withdrawn.
#[substreams::handlers::store]
fn store_books(
    positions: Positions,
    markets: StoreGetProto<Market>,
    known: StoreGetProto<PositionRef>,
    store: StoreAddBigInt,
) {
    for add in books::book_adds(&positions, &markets, &known) {
        store.add(add.ordinal, add.key(), &add.amount);
    }
}

/// Headroom over time: one row per book per block in which the book moved.
#[substreams::handlers::map]
fn map_book_deltas(
    clock: Clock,
    book_deltas: Deltas<DeltaBigInt>,
    books: StoreGetBigInt,
    markets: StoreGetProto<Market>,
) -> Result<BookDeltas, Error> {
    let key_deltas: Vec<KeyDelta> = book_deltas
        .deltas
        .into_iter()
        .map(|delta| KeyDelta {
            key: delta.key,
            old_value: delta.old_value,
            new_value: delta.new_value,
        })
        .collect();

    let timestamp = clock
        .timestamp
        .map(|t| t.seconds as u64)
        .unwrap_or_default();

    Ok(deltas::map(
        &key_deltas,
        &books,
        &markets,
        deltas::block_meta(clock.number, timestamp),
    ))
}

#[substreams::handlers::map]
fn db_out(
    markets: Markets,
    positions: Positions,
    book_deltas: BookDeltas,
) -> Result<DatabaseChanges, Error> {
    Ok(db::out(&markets, &positions, &book_deltas))
}

fn parse_params(params: &str) -> Result<Contracts, Error> {
    let contracts = Contracts::parse(params)
        .with_context(|| format!("module parameter {params:?} is not a valid contract set"))?;
    if contracts.is_empty() {
        // Not an error: a run against a chain where nothing is deployed yet is a
        // legitimate no-op. Saying so once beats an empty output with no explanation.
        substreams::log::info!(
            "no contract addresses configured; set them with -p, e.g. -p map_markets=vested=0x..."
        );
    }
    Ok(contracts)
}

// ------------------------------------------------------------------ store adapters
//
// The logic modules talk to small traits rather than to concrete store types, so they can
// be tested on the host. These are the only implementations that touch the real stores.

impl MarketLookup for StoreGetProto<Market> {
    fn shape(&self, settler: &str, market_id: u64) -> Option<MarketShape> {
        let market = self.get_last(keys::market_key(settler, market_id))?;
        if market.op != MarketOp::Create as i32 {
            return None;
        }
        Some(MarketShape {
            outcomes: market.outcomes,
            kappa: amounts::parse(&market.kappa),
            rule: rule_of(market.rule),
        })
    }
}

impl PositionLookup for StoreGetProto<PositionRef> {
    fn position(&self, settler: &str, position_id: u64) -> Option<PositionRef> {
        self.get_last(keys::position_key(settler, position_id))
    }
}

impl BookReader for StoreGetBigInt {
    fn value(&self, key: &str) -> Option<BigInt> {
        self.get_last(key)
    }
}

fn rule_of(rule: i32) -> SettlementRule {
    books::rule_of(rule)
}
