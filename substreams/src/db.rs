//! `db_out`: the three map outputs turned into `DatabaseChanges` for a hosted SQL sink.
//!
//! Two conventions run through this module.
//!
//! A market or position row is written by several different logs, each of which knows
//! only some of the columns. The row is CREATEd by the one log that opens it — a
//! MarketCreated or an Entered — and UPDATEd by the rest, setting only the columns that
//! log actually carries. That is why the proto tags every row with an op instead of
//! sending a whole entity each time: an update that also wrote the columns it does not
//! know would blank them.
//!
//! Running totals use the sink's own `add`, not a store. A position's total payout and
//! total refund accumulate over the one or two Claimed logs it emits, and `add` turns
//! that into `column = COALESCE(column, 0) + value` at the sink, which is correct under
//! replay and needs no extra module.
//!
//! Column naming: `recipient` rather than `to` because `to` is reserved in SQL, and
//! `seed` is a comma-separated string rather than an array because array literals are
//! dialect-specific and this output has to survive whichever driver the sink uses.

use substreams::scalar::BigInt;
use substreams_database_change::pb::sf::substreams::sink::database::v1::DatabaseChanges;
use substreams_database_change::tables::Tables;

use crate::amounts;
use crate::pb::hunch_vpm_v1::{
    BookDelta, BookDeltas, FeedReading, Market, MarketOp, MarketStatus, Markets, Meta, Position,
    PositionOp, Positions, Residue, ResolutionSpec, Settlement, SettlementRule, Vintage,
};

pub fn out(markets: &Markets, positions: &Positions, books: &BookDeltas) -> DatabaseChanges {
    let mut tables = Tables::new();

    for market in &markets.markets {
        write_market(&mut tables, market);
    }
    for spec in &markets.specs {
        write_spec(&mut tables, spec);
    }
    for reading in &markets.readings {
        write_reading(&mut tables, reading);
    }
    for position in &positions.positions {
        write_position(&mut tables, position);
    }
    for vintage in &positions.vintages {
        write_vintage(&mut tables, vintage);
    }
    for settlement in &positions.settlements {
        write_settlement(&mut tables, settlement);
    }
    for residue in &positions.residues {
        write_residue(&mut tables, residue);
    }
    for delta in &books.deltas {
        write_book_delta(&mut tables, delta);
    }

    tables.to_database_changes()
}

fn write_market(tables: &mut Tables, market: &Market) {
    let meta = meta_of(market.meta.as_ref());

    if market.op == MarketOp::Create as i32 {
        let row = tables.create_row("market", market.id.clone());
        row.set("rule", rule_name(market.rule))
            .set("settler", &market.settler)
            .set("market_id", market.market_id)
            .set("creator", &market.creator)
            .set("outcomes", market.outcomes)
            .set("kappa", &market.kappa)
            .set("kappa_unbounded", market.kappa_unbounded)
            .set("resolution_time", market.resolution_time)
            .set("status", status_name(market.status))
            .set("winner", market.winner)
            // Filled in by the factory's MarketOpened, which may or may not follow.
            .set("spec_id", "")
            .set("opener", "")
            .set("seed", "")
            .set("created_at_block", meta.block_number)
            .set("created_at_timestamp", meta.timestamp)
            .set("created_at_tx", &meta.tx_hash)
            .set("updated_at_block", meta.block_number)
            .set("updated_at_timestamp", meta.timestamp)
            .set("updated_at_tx", &meta.tx_hash);
        return;
    }

    // update_row after create_row in the same block merges into the insert, which is
    // exactly what MarketOpened needs: the factory emits it in the same transaction as
    // the settler's MarketCreated.
    let row = tables.update_row("market", market.id.clone());
    row.set("updated_at_block", meta.block_number)
        .set("updated_at_timestamp", meta.timestamp)
        .set("updated_at_tx", &meta.tx_hash);

    match market.op {
        op if op == MarketOp::LinkSpec as i32 => {
            row.set("spec_id", &market.spec_id)
                .set("opener", &market.opener)
                .set("seed", market.seed.join(","))
                .set("kappa", &market.kappa)
                .set("kappa_unbounded", market.kappa_unbounded)
                .set("resolution_time", market.resolution_time);
        }
        op if op == MarketOp::Resolve as i32 => {
            row.set("status", status_name(market.status))
                .set("winner", market.winner);
        }
        op if op == MarketOp::Void as i32 => {
            row.set("status", status_name(market.status));
        }
        _ => {}
    }
}

fn write_spec(tables: &mut Tables, spec: &ResolutionSpec) {
    let meta = meta_of(spec.meta.as_ref());
    tables
        .create_row("resolution_spec", spec.id.clone())
        .set("market", &spec.market)
        .set("settler", &spec.settler)
        .set("market_id", spec.market_id)
        .set("oracle", &spec.oracle)
        .set("feed_key", &spec.feed_key)
        .set("strike", &spec.strike)
        .set("direction", spec.direction)
        .set("resolution_time", spec.resolution_time)
        .set("max_staleness", spec.max_staleness)
        .set("resolver", &spec.resolver)
        .set("block_number", meta.block_number)
        .set("timestamp", meta.timestamp)
        .set("tx_hash", &meta.tx_hash);
}

fn write_reading(tables: &mut Tables, reading: &FeedReading) {
    let meta = meta_of(reading.meta.as_ref());
    let row = tables
        .create_row("feed_reading", reading.id.clone())
        .set("spec_id", &reading.spec_id)
        .set("resolver", &reading.resolver)
        .set("voided_stale", reading.voided_stale)
        // Empty on a stale void, which the sink stores as NULL.
        .set("price", &reading.price)
        .set("block_number", meta.block_number)
        .set("timestamp", meta.timestamp)
        .set("tx_hash", &meta.tx_hash)
        .set("log_index", meta.log_index);

    // The two resolver events carry disjoint facts, and a column neither of them knows is
    // left unwritten so the sink stores NULL. Writing the proto zero instead would assert
    // something false in every case: market 0 exists, outcome 0 can win, a feed timestamp
    // of 0 is the epoch, and an age of 0 is a perfectly fresh reading.
    if reading.voided_stale {
        row.set("age", reading.age);
    } else {
        row.set("market_id", reading.market_id)
            .set("winner", reading.winner)
            .set("updated_at", reading.updated_at);
    }
}

fn write_position(tables: &mut Tables, position: &Position) {
    let meta = meta_of(position.meta.as_ref());

    if position.op == PositionOp::Enter as i32 {
        tables
            .create_row("position", position.id.clone())
            .set("rule", rule_name(position.rule))
            .set("settler", &position.settler)
            .set("position_id", position.position_id)
            .set("market", &position.market)
            .set("market_id", position.market_id)
            .set("owner", &position.owner)
            .set("outcome", position.outcome)
            .set("offered", &position.offered)
            .set("vintage", position.vintage)
            .set("seed", position.seed)
            .set("payout_total", "0")
            .set("refund_total", "0")
            .set("entered_at_block", meta.block_number)
            .set("entered_at_timestamp", meta.timestamp)
            .set("entered_at_tx", &meta.tx_hash)
            .set("updated_at_block", meta.block_number)
            .set("updated_at_timestamp", meta.timestamp)
            .set("updated_at_tx", &meta.tx_hash);
        return;
    }

    let row = tables.update_row("position", position.id.clone());
    row.set("updated_at_block", meta.block_number)
        .set("updated_at_timestamp", meta.timestamp)
        .set("updated_at_tx", &meta.tx_hash);

    match position.op {
        op if op == PositionOp::Transfer as i32 => {
            row.set("owner", &position.owner);
        }
        op if op == PositionOp::Settle as i32 => {
            // Additive, because a position can settle twice: withdrawRefund pays the
            // refused remainder and the later claim pays the settlement.
            row.add("payout_total", amounts::parse(&position.payout))
                .add("refund_total", amounts::parse(&position.refund));
        }
        _ => {}
    }
}

fn write_vintage(tables: &mut Tables, vintage: &Vintage) {
    let meta = meta_of(vintage.meta.as_ref());
    tables
        .create_row("vintage", vintage.id.clone())
        .set("market", &vintage.market)
        .set("settler", &vintage.settler)
        .set("market_id", vintage.market_id)
        .set("vintage", vintage.vintage)
        .set("entries", vintage.entries)
        .set("finalized_at_block", meta.block_number)
        .set("finalized_at_timestamp", meta.timestamp)
        .set("finalized_at_tx", &meta.tx_hash);
}

fn write_settlement(tables: &mut Tables, settlement: &Settlement) {
    let meta = meta_of(settlement.meta.as_ref());
    tables
        .create_row("settlement", settlement.id.clone())
        .set("position", &settlement.position)
        .set("settler", &settlement.settler)
        .set("position_id", settlement.position_id)
        .set("recipient", &settlement.to)
        .set("payout", &settlement.payout)
        .set("refund", &settlement.refund)
        .set("block_number", meta.block_number)
        .set("timestamp", meta.timestamp)
        .set("tx_hash", &meta.tx_hash)
        .set("log_index", meta.log_index);
}

fn write_residue(tables: &mut Tables, residue: &Residue) {
    let meta = meta_of(residue.meta.as_ref());
    tables
        .create_row("residue", residue.id.clone())
        .set("market", &residue.market)
        .set("settler", &residue.settler)
        .set("market_id", residue.market_id)
        .set("recipient", &residue.to)
        .set("amount", &residue.amount)
        .set("block_number", meta.block_number)
        .set("timestamp", meta.timestamp)
        .set("tx_hash", &meta.tx_hash);
}

fn write_book_delta(tables: &mut Tables, delta: &BookDelta) {
    let meta = meta_of(delta.meta.as_ref());
    tables
        .create_row("book_delta", delta.id.clone())
        .set("book", &delta.book)
        .set("market", &delta.market)
        .set("settler", &delta.settler)
        .set("market_id", delta.market_id)
        .set("outcome", delta.outcome)
        .set("rule", rule_name(delta.rule))
        .set("principal", &delta.principal)
        .set("vested", &delta.vested)
        .set("capacity", &delta.capacity)
        .set("headroom", &delta.headroom)
        .set("unbounded", delta.unbounded)
        .set("principal_delta", &delta.principal_delta)
        .set("vested_delta", &delta.vested_delta)
        .set("block_number", meta.block_number)
        .set("timestamp", meta.timestamp);
}

fn meta_of(meta: Option<&Meta>) -> Meta {
    meta.cloned().unwrap_or_default()
}

// Enums go into the database as their protobuf names, not as the integers behind them.
// A column reading MARKET_STATUS_RESOLVED needs no lookup table to be read by a human or
// by whoever writes the next query.

fn rule_name(rule: i32) -> &'static str {
    SettlementRule::try_from(rule)
        .unwrap_or(SettlementRule::Unspecified)
        .as_str_name()
}

fn status_name(status: i32) -> &'static str {
    MarketStatus::try_from(status)
        .unwrap_or(MarketStatus::Unspecified)
        .as_str_name()
}

/// Exposed so a caller can log how much a block produced without decoding the output.
pub fn change_count(changes: &DatabaseChanges) -> usize {
    changes.table_changes.len()
}

/// Sum of every `payout` on a set of settlements. Used only by tests and logging, but
/// kept here so the column and the sum cannot drift apart.
pub fn total_payout(positions: &Positions) -> BigInt {
    positions
        .settlements
        .iter()
        .fold(BigInt::zero(), |acc, s| acc + amounts::parse(&s.payout))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};

    use super::*;
    use substreams_database_change::pb::sf::substreams::sink::database::v1::table_change::{
        Operation, PrimaryKey,
    };
    use substreams_database_change::pb::sf::substreams::sink::database::v1::TableChange;

    fn meta(block: u64) -> Meta {
        Meta {
            block_number: block,
            timestamp: 1_760_000_000,
            tx_hash: "0x5a".to_string(),
            log_index: 3,
            ordinal: 100,
        }
    }

    fn find<'a>(changes: &'a DatabaseChanges, table: &str, pk: &str) -> &'a TableChange {
        changes
            .table_changes
            .iter()
            .find(|c| {
                c.table == table && matches!(&c.primary_key, Some(PrimaryKey::Pk(key)) if key == pk)
            })
            .unwrap_or_else(|| panic!("no {table} change for {pk}"))
    }

    fn field<'a>(change: &'a TableChange, name: &str) -> &'a str {
        &change
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("no field {name}"))
            .value
    }

    fn has_field(change: &TableChange, name: &str) -> bool {
        change.fields.iter().any(|f| f.name == name)
    }

    fn created_market() -> Market {
        Market {
            id: "0xaa-1".to_string(),
            op: MarketOp::Create as i32,
            rule: SettlementRule::Vested as i32,
            settler: "0xaa".to_string(),
            market_id: 1,
            creator: "0xbb".to_string(),
            outcomes: 2,
            kappa: "30".to_string(),
            resolution_time: 1800,
            status: MarketStatus::Open as i32,
            winner: -1,
            meta: Some(meta(100)),
            ..Default::default()
        }
    }

    #[test]
    fn a_created_market_is_an_insert_with_every_column() {
        let markets = Markets {
            markets: vec![created_market()],
            ..Default::default()
        };
        let changes = out(&markets, &Positions::default(), &BookDeltas::default());
        let change = find(&changes, "market", "0xaa-1");
        assert_eq!(change.operation, Operation::Create as i32);
        assert_eq!(field(change, "creator"), "0xbb");
        assert_eq!(field(change, "kappa"), "30");
        assert_eq!(field(change, "outcomes"), "2");
        assert_eq!(
            field(change, "rule"),
            "SETTLEMENT_RULE_VESTED",
            "enums go in as names, so a query needs no lookup table"
        );
        assert_eq!(field(change, "status"), "MARKET_STATUS_OPEN");
        assert_eq!(field(change, "winner"), "-1");
        assert_eq!(field(change, "created_at_block"), "100");
    }

    #[test]
    fn a_resolution_updates_only_the_outcome_columns() {
        let markets = Markets {
            markets: vec![Market {
                id: "0xaa-1".to_string(),
                op: MarketOp::Resolve as i32,
                status: MarketStatus::Resolved as i32,
                winner: 1,
                meta: Some(meta(200)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let changes = out(&markets, &Positions::default(), &BookDeltas::default());
        let change = find(&changes, "market", "0xaa-1");
        assert_eq!(change.operation, Operation::Update as i32);
        assert_eq!(field(change, "winner"), "1");
        assert_eq!(field(change, "status"), "MARKET_STATUS_RESOLVED");
        assert!(
            !has_field(change, "creator"),
            "an update must not blank the columns its log never knew"
        );
        assert!(!has_field(change, "kappa"));
    }

    #[test]
    fn creation_and_the_factory_link_in_one_block_collapse_into_one_insert() {
        // MarketFactory.open calls the settler and the resolver in a single transaction,
        // so both logs land in the same block.
        let markets = Markets {
            markets: vec![
                created_market(),
                Market {
                    id: "0xaa-1".to_string(),
                    op: MarketOp::LinkSpec as i32,
                    spec_id: "0xspec".to_string(),
                    opener: "0xcc".to_string(),
                    seed: vec!["1000000".to_string(), "1000000".to_string()],
                    kappa: "30".to_string(),
                    resolution_time: 1800,
                    meta: Some(meta(100)),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let changes = out(&markets, &Positions::default(), &BookDeltas::default());
        let market_changes: Vec<_> = changes
            .table_changes
            .iter()
            .filter(|c| c.table == "market")
            .collect();
        assert_eq!(market_changes.len(), 1, "one row, one change");

        let change = market_changes[0];
        assert_eq!(change.operation, Operation::Create as i32);
        assert_eq!(field(change, "creator"), "0xbb");
        assert_eq!(field(change, "spec_id"), "0xspec");
        assert_eq!(field(change, "seed"), "1000000,1000000");
    }

    #[test]
    fn an_entry_inserts_a_position_with_zeroed_totals() {
        let positions = Positions {
            positions: vec![Position {
                id: "0xaa-7".to_string(),
                op: PositionOp::Enter as i32,
                settler: "0xaa".to_string(),
                position_id: 7,
                market: "0xaa-1".to_string(),
                market_id: 1,
                owner: "0xbb".to_string(),
                outcome: 1,
                offered: "2500000".to_string(),
                vintage: 4_200_000,
                meta: Some(meta(4_200_000)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let changes = out(&Markets::default(), &positions, &BookDeltas::default());
        let change = find(&changes, "position", "0xaa-7");
        assert_eq!(change.operation, Operation::Create as i32);
        assert_eq!(field(change, "offered"), "2500000");
        assert_eq!(field(change, "payout_total"), "0");
        assert_eq!(field(change, "refund_total"), "0");
    }

    #[test]
    fn two_settlements_on_one_position_accumulate_into_one_change() {
        let settle = |payout: &str, refund: &str| Position {
            id: "0xaa-7".to_string(),
            op: PositionOp::Settle as i32,
            payout: payout.to_string(),
            refund: refund.to_string(),
            meta: Some(meta(4_200_100)),
            ..Default::default()
        };
        let positions = Positions {
            positions: vec![settle("0", "250000"), settle("3100000", "0")],
            ..Default::default()
        };
        let changes = out(&Markets::default(), &positions, &BookDeltas::default());
        let change = find(&changes, "position", "0xaa-7");
        assert_eq!(change.operation, Operation::Update as i32);
        assert_eq!(field(change, "payout_total"), "3100000");
        assert_eq!(field(change, "refund_total"), "250000");
    }

    #[test]
    fn a_transfer_updates_the_owner_alone() {
        let positions = Positions {
            positions: vec![Position {
                id: "0xaa-7".to_string(),
                op: PositionOp::Transfer as i32,
                owner: "0xdd".to_string(),
                meta: Some(meta(4_200_050)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let changes = out(&Markets::default(), &positions, &BookDeltas::default());
        let change = find(&changes, "position", "0xaa-7");
        assert_eq!(field(change, "owner"), "0xdd");
        assert!(!has_field(change, "offered"));
        assert!(!has_field(change, "payout_total"));
    }

    #[test]
    fn a_resolution_writes_the_market_and_the_winner_but_no_age() {
        let markets = Markets {
            readings: vec![FeedReading {
                id: "0xspec-200-3".to_string(),
                spec_id: "0xspec".to_string(),
                market_id: 1,
                voided_stale: false,
                winner: 0,
                price: "6600000000000".to_string(),
                updated_at: 1699,
                meta: Some(meta(200)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let changes = out(&markets, &Positions::default(), &BookDeltas::default());
        let change = find(&changes, "feed_reading", "0xspec-200-3");
        assert_eq!(field(change, "market_id"), "1");
        assert_eq!(field(change, "winner"), "0");
        assert_eq!(field(change, "updated_at"), "1699");
        assert_eq!(field(change, "price"), "6600000000000");
        assert!(
            !has_field(change, "age"),
            "Resolved logs no age, and 0 would claim a perfectly fresh reading"
        );
    }

    #[test]
    fn a_stale_void_writes_no_market_id_and_no_winner() {
        // VoidedStale(bytes32 specId, uint256 age) names neither. Writing the proto zero
        // would assert "market 0, outcome 0 won" about an event whose entire meaning is
        // that the feed could not be trusted.
        let markets = Markets {
            readings: vec![FeedReading {
                id: "0xspec-200-3".to_string(),
                spec_id: "0xspec".to_string(),
                voided_stale: true,
                winner: -1,
                age: 3600,
                meta: Some(meta(200)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let changes = out(&markets, &Positions::default(), &BookDeltas::default());
        let change = find(&changes, "feed_reading", "0xspec-200-3");
        assert_eq!(field(change, "age"), "3600");
        assert_eq!(field(change, "voided_stale"), "true");
        assert_eq!(
            field(change, "price"),
            "",
            "an empty value is NULL at the sink"
        );
        assert!(!has_field(change, "market_id"), "0 is a real market id");
        assert!(!has_field(change, "winner"), "0 is a real outcome");
        assert!(!has_field(change, "updated_at"));
    }

    #[test]
    fn a_book_delta_row_carries_the_headroom() {
        let books = BookDeltas {
            deltas: vec![BookDelta {
                id: "0xaa-1-0-4200000".to_string(),
                book: "0xaa-1-0".to_string(),
                market: "0xaa-1".to_string(),
                settler: "0xaa".to_string(),
                market_id: 1,
                outcome: 0,
                principal: "1000000".to_string(),
                vested: "4000000".to_string(),
                capacity: "30000000".to_string(),
                headroom: "26000000".to_string(),
                principal_delta: "0".to_string(),
                vested_delta: "1000000".to_string(),
                rule: SettlementRule::Vested as i32,
                meta: Some(meta(4_200_000)),
                ..Default::default()
            }],
        };
        let changes = out(&Markets::default(), &Positions::default(), &books);
        let change = find(&changes, "book_delta", "0xaa-1-0-4200000");
        assert_eq!(change.operation, Operation::Create as i32);
        assert_eq!(field(change, "headroom"), "26000000");
        assert_eq!(field(change, "vested_delta"), "1000000");
        assert_eq!(field(change, "unbounded"), "false");
    }

    #[test]
    fn settlements_are_append_only_rows_of_their_own() {
        let positions = Positions {
            settlements: vec![Settlement {
                id: "0xaa-7-100-3".to_string(),
                position: "0xaa-7".to_string(),
                settler: "0xaa".to_string(),
                position_id: 7,
                to: "0xbb".to_string(),
                payout: "3100000".to_string(),
                refund: "250000".to_string(),
                meta: Some(meta(100)),
            }],
            ..Default::default()
        };
        let changes = out(&Markets::default(), &positions, &BookDeltas::default());
        let change = find(&changes, "settlement", "0xaa-7-100-3");
        assert_eq!(change.operation, Operation::Create as i32);
        assert_eq!(field(change, "recipient"), "0xbb");
        assert_eq!(field(change, "payout"), "3100000");
        assert_eq!(total_payout(&positions).to_string(), "3100000");
    }

    #[test]
    fn an_empty_block_produces_no_changes() {
        let changes = out(
            &Markets::default(),
            &Positions::default(),
            &BookDeltas::default(),
        );
        assert_eq!(change_count(&changes), 0);
    }

    #[test]
    fn changes_come_out_in_ordinal_order() {
        let markets = Markets {
            markets: vec![created_market()],
            ..Default::default()
        };
        let positions = Positions {
            positions: vec![Position {
                id: "0xaa-7".to_string(),
                op: PositionOp::Enter as i32,
                meta: Some(meta(100)),
                ..Default::default()
            }],
            ..Default::default()
        };
        let changes = out(&markets, &positions, &BookDeltas::default());
        let ordinals: Vec<u64> = changes.table_changes.iter().map(|c| c.ordinal).collect();
        let mut sorted = ordinals.clone();
        sorted.sort_unstable();
        assert_eq!(ordinals, sorted);
        assert_eq!(changes.table_changes.len(), 2);
    }

    // ------------------------------------------------------------ schema.sql agreement
    //
    // db_out writes column names as strings and schema.sql declares them as DDL. Nothing
    // in the type system connects the two, and a mismatch only surfaces at the sink, in
    // production, as a failed insert. These two tests close that gap: every column this
    // module writes must exist in the DDL, and every table the DDL declares must be one
    // this module writes.

    const SCHEMA: &str = include_str!("../schema.sql");
    const MANIFEST: &str = include_str!("../substreams.yaml");

    /// The `sink:` block is the only thing that puts schema.sql inside the packed .spkg.
    /// Drop it and the package still carries a working `db_out` and no DDL, so
    /// `substreams-sink-sql setup` and `substreams alpha service deploy` have nothing to
    /// apply. That failure surfaces at deploy time, on a machine with the CLI — which CI
    /// is not — so it is pinned here instead.
    #[test]
    fn the_manifest_declares_a_sink_that_ships_this_schema() {
        assert!(
            MANIFEST.contains("\n  - name: db_out\n"),
            "substreams.yaml declares no db_out module"
        );

        let after = MANIFEST
            .split_once("\nsink:\n")
            .expect("substreams.yaml declares no top-level `sink:` block")
            .1;
        // A YAML block ends at the first line that is not indented under it.
        let block: String = after
            .lines()
            .take_while(|line| line.starts_with(' '))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            block.contains("module: db_out"),
            "the sink must consume db_out, not another module: {block}"
        );
        assert!(
            block.contains("type: sf.substreams.sink.sql.service.v1.Service"),
            "the sink type is what tells `substreams pack` to inline a schema: {block}"
        );
        assert!(
            block.contains("schema: \"./schema.sql\""),
            "the sink must name the same schema.sql the column tests below read: {block}"
        );
    }

    /// Every table in schema.sql, with its declared column names.
    fn declared_tables() -> HashMap<String, BTreeSet<String>> {
        let mut tables = HashMap::new();
        let mut rest = SCHEMA;

        while let Some(start) = rest.find("CREATE TABLE IF NOT EXISTS ") {
            let after = &rest[start + "CREATE TABLE IF NOT EXISTS ".len()..];
            let (name, body) = after.split_once('(').expect("a table body");
            let (body, tail) = body.split_once(");").expect("a closed table body");

            let mut columns = BTreeSet::new();
            for line in body.lines() {
                let line = line.split("--").next().unwrap_or("").trim();
                if line.is_empty() {
                    continue;
                }
                let column = line.split_whitespace().next().expect("a column name");
                columns.insert(column.to_string());
            }
            tables.insert(name.trim().to_string(), columns);
            rest = tail;
        }
        tables
    }

    /// One of everything, so the walk below touches every write path in this module.
    fn every_row() -> (Markets, Positions, BookDeltas) {
        let markets = Markets {
            markets: vec![
                created_market(),
                Market {
                    id: "0xaa-1".to_string(),
                    op: MarketOp::LinkSpec as i32,
                    spec_id: "0xspec".to_string(),
                    meta: Some(meta(100)),
                    ..Default::default()
                },
                Market {
                    id: "0xaa-2".to_string(),
                    op: MarketOp::Resolve as i32,
                    meta: Some(meta(200)),
                    ..Default::default()
                },
                Market {
                    id: "0xaa-3".to_string(),
                    op: MarketOp::Void as i32,
                    meta: Some(meta(200)),
                    ..Default::default()
                },
            ],
            specs: vec![ResolutionSpec {
                id: "0xspec".to_string(),
                meta: Some(meta(100)),
                ..Default::default()
            }],
            // Both resolver paths: they write disjoint column sets, so one of each is
            // what it takes for the schema walk below to touch every column.
            readings: vec![
                FeedReading {
                    id: "0xspec-200-0".to_string(),
                    meta: Some(meta(200)),
                    ..Default::default()
                },
                FeedReading {
                    id: "0xspec-200-1".to_string(),
                    voided_stale: true,
                    winner: -1,
                    age: 3600,
                    meta: Some(meta(200)),
                    ..Default::default()
                },
            ],
        };
        let positions = Positions {
            positions: vec![
                Position {
                    id: "0xaa-7".to_string(),
                    op: PositionOp::Enter as i32,
                    meta: Some(meta(100)),
                    ..Default::default()
                },
                Position {
                    id: "0xaa-8".to_string(),
                    op: PositionOp::Transfer as i32,
                    meta: Some(meta(150)),
                    ..Default::default()
                },
                Position {
                    id: "0xaa-9".to_string(),
                    op: PositionOp::Settle as i32,
                    payout: "1".to_string(),
                    refund: "1".to_string(),
                    meta: Some(meta(200)),
                    ..Default::default()
                },
            ],
            vintages: vec![Vintage {
                id: "0xaa-1-99".to_string(),
                meta: Some(meta(100)),
                ..Default::default()
            }],
            settlements: vec![Settlement {
                id: "0xaa-9-200-0".to_string(),
                meta: Some(meta(200)),
                ..Default::default()
            }],
            residues: vec![Residue {
                id: "0xaa-1".to_string(),
                meta: Some(meta(300)),
                ..Default::default()
            }],
        };
        let books = BookDeltas {
            deltas: vec![BookDelta {
                id: "0xaa-1-0-100".to_string(),
                meta: Some(meta(100)),
                ..Default::default()
            }],
        };
        (markets, positions, books)
    }

    #[test]
    fn every_column_db_out_writes_exists_in_schema_sql() {
        let declared = declared_tables();
        let (markets, positions, books) = every_row();
        let changes = out(&markets, &positions, &books);
        assert!(!changes.table_changes.is_empty());

        for change in &changes.table_changes {
            let columns = declared
                .get(&change.table)
                .unwrap_or_else(|| panic!("schema.sql declares no table {}", change.table));
            for field in &change.fields {
                assert!(
                    columns.contains(&field.name),
                    "schema.sql has no {}.{}",
                    change.table,
                    field.name
                );
            }
        }
    }

    #[test]
    fn every_table_in_schema_sql_is_written_by_db_out() {
        let (markets, positions, books) = every_row();
        let changes = out(&markets, &positions, &books);
        let written: BTreeSet<&str> = changes
            .table_changes
            .iter()
            .map(|c| c.table.as_str())
            .collect();

        for table in declared_tables().keys() {
            assert!(
                written.contains(table.as_str()),
                "schema.sql declares {table}, which db_out never writes"
            );
        }
    }

    #[test]
    fn every_table_has_a_primary_key_and_a_single_column_one() {
        // The sink addresses rows by primary key; a composite key here would mean the id
        // this module builds is not the key the sink uses.
        let (markets, positions, books) = every_row();
        for change in out(&markets, &positions, &books).table_changes {
            match change.primary_key {
                Some(PrimaryKey::Pk(pk)) => {
                    assert!(!pk.is_empty(), "{} has an empty pk", change.table)
                }
                other => panic!("{} has an unexpected primary key: {other:?}", change.table),
            }
        }
    }
}
