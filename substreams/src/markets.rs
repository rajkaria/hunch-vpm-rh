//! MarketCreated / Resolved / Voided into market rows, plus the resolver's side of the
//! story: the spec a market resolves against and the reading that settled or voided it.
//!
//! A market row is emitted once per lifecycle log and carries only the columns that log
//! knows, tagged with a [`MarketOp`]. `db_out` turns a CREATE into an insert and the rest
//! into updates, so a Resolved log never blanks the creator or the kappa.

use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

use crate::abi;
use crate::amounts;
use crate::keys;
use crate::log_meta::meta_of;
use crate::params::Contracts;
use crate::pb::hunch_vpm_v1::{
    FeedReading, Market, MarketOp, MarketStatus, Markets, ResolutionSpec, SettlementRule,
};

/// Sentinel for "no winner yet". proto3 has no null and outcome 0 is a real outcome, so
/// an unresolved market has to say so with something out of range.
pub const NO_WINNER: i32 = -1;

pub fn map(contracts: &Contracts, block: &eth::Block) -> Markets {
    let mut out = Markets::default();

    for log in block.logs() {
        let address = log.address();
        let meta = meta_of(block, &log);

        if let Some(rule) = contracts.settler_rule(address) {
            let settler = keys::address(address);

            if let Some(event) =
                abi::vested_parimutuel::events::MarketCreated::match_and_decode(log)
            {
                let kappa = event.kappa;
                out.markets.push(Market {
                    id: keys::market_row_id(&settler, event.market_id.to_u64()),
                    op: MarketOp::Create as i32,
                    rule: rule as i32,
                    settler: settler.clone(),
                    market_id: event.market_id.to_u64(),
                    creator: keys::address(&event.creator),
                    outcomes: event.n.to_u64() as u32,
                    kappa_unbounded: amounts::is_unbounded(&kappa),
                    kappa: kappa.to_string(),
                    resolution_time: event.resolution_time.to_u64(),
                    status: MarketStatus::Open as i32,
                    winner: NO_WINNER,
                    meta: Some(meta),
                    ..Default::default()
                });
                continue;
            }

            // Both settlers emit the same Resolved and Voided signatures, so one decoder
            // covers them; the rule comes from the emitting address.
            if let Some(event) = abi::vested_parimutuel::events::Resolved::match_and_decode(log) {
                out.markets.push(Market {
                    id: keys::market_row_id(&settler, event.market_id.to_u64()),
                    op: MarketOp::Resolve as i32,
                    rule: rule as i32,
                    settler: settler.clone(),
                    market_id: event.market_id.to_u64(),
                    status: MarketStatus::Resolved as i32,
                    winner: event.winner.to_u64() as i32,
                    meta: Some(meta),
                    ..Default::default()
                });
                continue;
            }

            if let Some(event) = abi::vested_parimutuel::events::Voided::match_and_decode(log) {
                out.markets.push(Market {
                    id: keys::market_row_id(&settler, event.market_id.to_u64()),
                    op: MarketOp::Void as i32,
                    rule: rule as i32,
                    settler,
                    market_id: event.market_id.to_u64(),
                    status: MarketStatus::Voided as i32,
                    winner: NO_WINNER,
                    meta: Some(meta),
                    ..Default::default()
                });
            }
            continue;
        }

        if contracts.is_factory(address) {
            if let Some(event) = abi::market_factory::events::MarketOpened::match_and_decode(log) {
                // The factory names the settler in the event, which is how the seed and
                // the spec id reach a market row that a settler log alone cannot carry.
                // A market opened on a settler this run does not index is skipped: a row
                // whose other columns will never arrive is worse than no row.
                let Some(rule) = contracts.settler_rule(&event.settler) else {
                    continue;
                };
                let settler = keys::address(&event.settler);
                out.markets.push(Market {
                    id: keys::market_row_id(&settler, event.market_id.to_u64()),
                    op: MarketOp::LinkSpec as i32,
                    rule: rule as i32,
                    settler,
                    market_id: event.market_id.to_u64(),
                    kappa_unbounded: amounts::is_unbounded(&event.kappa),
                    kappa: event.kappa.to_string(),
                    resolution_time: event.resolution_time.to_u64(),
                    winner: NO_WINNER,
                    spec_id: format!("0x{}", hex::encode(event.spec_id)),
                    opener: keys::address(&event.opener),
                    seed: event.seed.iter().map(|s| s.to_string()).collect(),
                    meta: Some(meta),
                    ..Default::default()
                });
            }
            continue;
        }

        if contracts.is_resolver(address) {
            let resolver = keys::address(address);

            if let Some(event) = abi::feed_resolver::events::SpecRegistered::match_and_decode(log) {
                let settler = keys::address(&event.settler);
                out.specs.push(ResolutionSpec {
                    id: format!("0x{}", hex::encode(event.spec_id)),
                    market: keys::market_row_id(&settler, event.market_id.to_u64()),
                    settler,
                    market_id: event.market_id.to_u64(),
                    oracle: keys::address(&event.oracle),
                    feed_key: format!("0x{}", hex::encode(event.feed_key)),
                    strike: event.strike.to_string(),
                    direction: event.direction.to_u64() as u32,
                    resolution_time: event.resolution_time.to_u64(),
                    max_staleness: event.max_staleness.to_u64(),
                    resolver,
                    meta: Some(meta),
                });
                continue;
            }

            if let Some(event) = abi::feed_resolver::events::Resolved::match_and_decode(log) {
                let spec_id = format!("0x{}", hex::encode(event.spec_id));
                out.readings.push(FeedReading {
                    id: keys::log_row_id(&spec_id, meta.block_number, meta.log_index),
                    spec_id,
                    resolver,
                    market_id: event.market_id.to_u64(),
                    voided_stale: false,
                    winner: event.winner.to_u64() as i32,
                    price: event.price.to_string(),
                    updated_at: event.updated_at.to_u64(),
                    // Resolved logs no age. db_out leaves the column unwritten rather
                    // than claiming the reading was zero seconds old.
                    age: 0,
                    meta: Some(meta),
                });
                continue;
            }

            if let Some(event) = abi::feed_resolver::events::VoidedStale::match_and_decode(log) {
                // A stale void carries no price by construction: the reading is the thing
                // that was not trustworthy. Only its age is logged — not the market id,
                // not the winner, not the feed's updatedAt. market_id and updated_at stay
                // at their proto zero and db_out declines to write either column; winner
                // gets the same NO_WINNER sentinel an unresolved market carries, because
                // outcome 0 is a real outcome that something really could have won.
                let spec_id = format!("0x{}", hex::encode(event.spec_id));
                out.readings.push(FeedReading {
                    id: keys::log_row_id(&spec_id, meta.block_number, meta.log_index),
                    spec_id,
                    resolver,
                    voided_stale: true,
                    winner: NO_WINNER,
                    age: event.age.to_u64(),
                    meta: Some(meta),
                    ..Default::default()
                });
            }
        }
    }

    out
}

/// True when the row is the one that opens the market, i.e. the only one `db_out` may
/// insert rather than update.
pub fn is_create(market: &Market) -> bool {
    market.op == MarketOp::Create as i32
}

pub fn rule_of(market: &Market) -> SettlementRule {
    match market.rule {
        x if x == SettlementRule::Vested as i32 => SettlementRule::Vested,
        x if x == SettlementRule::Classic as i32 => SettlementRule::Classic,
        _ => SettlementRule::Unspecified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{self, CLASSIC, FACTORY, RESOLVER, VESTED};

    #[test]
    fn market_created_opens_a_row_with_the_creation_columns() {
        let block = testkit::block(vec![testkit::market_created(
            VESTED, 3, 0xAA, 2, "30", 1800,
        )]);
        let got = map(&testkit::contracts(), &block);

        assert_eq!(got.markets.len(), 1);
        let market = &got.markets[0];
        assert_eq!(market.id, format!("{}-3", keys::address(&VESTED)));
        assert_eq!(market.op, MarketOp::Create as i32);
        assert_eq!(market.rule, SettlementRule::Vested as i32);
        assert_eq!(market.creator, keys::address(&[0xAA; 20]));
        assert_eq!(market.outcomes, 2);
        assert_eq!(market.kappa, "30");
        assert!(!market.kappa_unbounded);
        assert_eq!(market.resolution_time, 1800);
        assert_eq!(market.status, MarketStatus::Open as i32);
        assert_eq!(market.winner, NO_WINNER);
        assert_eq!(market.meta.as_ref().unwrap().block_number, testkit::BLOCK);
    }

    #[test]
    fn an_n_way_market_is_flagged_unbounded_rather_than_carrying_the_sentinel_as_a_number() {
        let unbounded = amounts::kappa_unbounded().to_string();
        let block = testkit::block(vec![testkit::market_created(
            VESTED, 1, 0xAA, 4, &unbounded, 900,
        )]);
        let market = &map(&testkit::contracts(), &block).markets[0];
        assert!(market.kappa_unbounded);
        assert_eq!(market.kappa, unbounded);
        assert_eq!(market.outcomes, 4);
    }

    #[test]
    fn the_same_signature_on_the_classic_settler_gets_the_classic_rule() {
        let block = testkit::block(vec![testkit::market_created(
            CLASSIC, 3, 0xAA, 2, "30", 1800,
        )]);
        let market = &map(&testkit::contracts(), &block).markets[0];
        assert_eq!(market.rule, SettlementRule::Classic as i32);
        assert_eq!(market.settler, keys::address(&CLASSIC));
    }

    #[test]
    fn resolved_updates_only_the_outcome_columns() {
        let block = testkit::block(vec![testkit::resolved(VESTED, 3, 1)]);
        let market = &map(&testkit::contracts(), &block).markets[0];
        assert_eq!(market.op, MarketOp::Resolve as i32);
        assert_eq!(market.status, MarketStatus::Resolved as i32);
        assert_eq!(market.winner, 1);
        assert_eq!(market.creator, "", "a Resolved log knows no creator");
        assert_eq!(market.kappa, "");
    }

    #[test]
    fn voided_leaves_the_winner_unset() {
        let block = testkit::block(vec![testkit::voided(VESTED, 3)]);
        let market = &map(&testkit::contracts(), &block).markets[0];
        assert_eq!(market.op, MarketOp::Void as i32);
        assert_eq!(market.status, MarketStatus::Voided as i32);
        assert_eq!(market.winner, NO_WINNER);
    }

    #[test]
    fn the_factory_links_the_spec_and_the_seed_onto_the_market() {
        let block = testkit::block(vec![testkit::market_opened(
            FACTORY,
            5,
            VESTED,
            0xBB,
            0xCC,
            &["1000000", "1000000"],
            "30",
            1800,
        )]);
        let market = &map(&testkit::contracts(), &block).markets[0];
        assert_eq!(market.op, MarketOp::LinkSpec as i32);
        assert_eq!(market.id, format!("{}-5", keys::address(&VESTED)));
        assert_eq!(market.spec_id, format!("0x{}", hex::encode([0xBB; 32])));
        assert_eq!(market.opener, keys::address(&[0xCC; 20]));
        assert_eq!(market.seed, vec!["1000000", "1000000"]);
    }

    #[test]
    fn a_market_opened_on_an_unindexed_settler_is_skipped() {
        let block = testkit::block(vec![testkit::market_opened(
            FACTORY,
            5,
            [0x99; 20],
            0xBB,
            0xCC,
            &["1"],
            "30",
            1800,
        )]);
        assert!(map(&testkit::contracts(), &block).markets.is_empty());
    }

    #[test]
    fn spec_registered_becomes_a_resolution_spec() {
        let block = testkit::block(vec![testkit::spec_registered(
            RESOLVER,
            0xBB,
            VESTED,
            5,
            0xDD,
            0xEE,
            "6500000000000",
            1,
            1800,
            120,
        )]);
        let got = map(&testkit::contracts(), &block);
        assert_eq!(got.specs.len(), 1);
        let spec = &got.specs[0];
        assert_eq!(spec.id, format!("0x{}", hex::encode([0xBB; 32])));
        assert_eq!(spec.market, format!("{}-5", keys::address(&VESTED)));
        assert_eq!(spec.oracle, keys::address(&[0xDD; 20]));
        assert_eq!(spec.feed_key, format!("0x{}", hex::encode([0xEE; 32])));
        assert_eq!(spec.strike, "6500000000000");
        assert_eq!(spec.direction, 1);
        assert_eq!(spec.max_staleness, 120);
    }

    #[test]
    fn a_negative_strike_survives_decoding() {
        // int256, so a below-zero strike is representable and must not wrap.
        let block = testkit::block(vec![testkit::spec_registered(
            RESOLVER,
            0xBB,
            VESTED,
            5,
            0xDD,
            0xEE,
            "-125000000",
            0,
            1800,
            60,
        )]);
        assert_eq!(
            map(&testkit::contracts(), &block).specs[0].strike,
            "-125000000"
        );
    }

    #[test]
    fn a_feed_resolution_records_the_reading_behind_it() {
        let block = testkit::block(vec![testkit::feed_resolved(
            RESOLVER,
            0xBB,
            5,
            0,
            "6600000000000",
            1699,
        )]);
        let got = map(&testkit::contracts(), &block);
        assert_eq!(got.readings.len(), 1);
        let reading = &got.readings[0];
        assert!(!reading.voided_stale);
        assert_eq!(reading.winner, 0);
        assert_eq!(reading.price, "6600000000000");
        assert_eq!(reading.updated_at, 1699);
    }

    #[test]
    fn a_stale_void_records_the_age_and_nothing_it_did_not_read() {
        // VoidedStale carries a spec id and an age. Everything else on the row has to
        // read as unknown rather than as a real value: 0 is a real market id and a real
        // winning outcome, and db_out is the half of this that turns them into NULL.
        let block = testkit::block(vec![testkit::voided_stale(RESOLVER, 0xBB, 3600)]);
        let reading = &map(&testkit::contracts(), &block).readings[0];
        assert!(reading.voided_stale);
        assert_eq!(reading.age, 3600);
        assert_eq!(reading.price, "");
        assert_eq!(
            reading.winner, NO_WINNER,
            "a voided market has no winner, and outcome 0 is a real outcome"
        );
        assert_eq!(reading.market_id, 0, "the event names no market");
        assert_eq!(reading.updated_at, 0, "the event carries no feed timestamp");
    }

    #[test]
    fn logs_from_untracked_addresses_are_ignored() {
        let block = testkit::block(vec![testkit::market_created(
            [0x77; 20], 3, 0xAA, 2, "30", 1800,
        )]);
        let got = map(&testkit::contracts(), &block);
        assert!(got.markets.is_empty() && got.specs.is_empty() && got.readings.is_empty());
    }

    #[test]
    fn a_reverted_transaction_contributes_nothing() {
        let block = testkit::failed_block(vec![testkit::market_created(
            VESTED, 3, 0xAA, 2, "30", 1800,
        )]);
        assert!(map(&testkit::contracts(), &block).markets.is_empty());
    }
}
