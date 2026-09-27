//! Entered / VintageFinalized / Claimed / PositionTransferred / ResidueClaimed into
//! position rows.
//!
//! One subtlety drives the shape of this module: the settler posts the creator's seed
//! legs from inside `create`, so the first `Entered` logs of a market land in the same
//! transaction as its `MarketCreated`. `store_books` needs n and kappa to open those
//! books and no store has seen the market yet at that point. So this module does a first
//! pass over the block for MarketCreated and stamps the n and kappa it finds onto the
//! entries of that same block. Entries into a market created in an earlier block leave
//! the hint empty and `store_books` reads the market from `store_markets` instead.

use std::collections::HashMap;

use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event;

use crate::abi;
use crate::keys;
use crate::log_meta::meta_of;
use crate::params::Contracts;
use crate::pb::hunch_vpm_v1::{Position, PositionOp, Positions, Residue, Settlement, Vintage};

/// n and kappa for a market created in the block being processed.
#[derive(Clone)]
struct Hint {
    outcomes: u32,
    kappa: String,
}

pub fn map(contracts: &Contracts, block: &eth::Block) -> Positions {
    let hints = market_hints(contracts, block);
    let mut out = Positions::default();

    for log in block.logs() {
        let address = log.address();
        let Some(rule) = contracts.settler_rule(address) else {
            continue;
        };
        let settler = keys::address(address);
        let meta = meta_of(block, &log);

        if let Some(event) = abi::vested_parimutuel::events::Entered::match_and_decode(log) {
            let market_id = event.market_id.to_u64();
            let vintage = event.vintage.to_u64();
            let hint = hints.get(&(settler.clone(), market_id));
            out.positions.push(Position {
                id: keys::position_row_id(&settler, event.position_id.to_u64()),
                op: PositionOp::Enter as i32,
                rule: rule as i32,
                market: keys::market_row_id(&settler, market_id),
                settler: settler.clone(),
                position_id: event.position_id.to_u64(),
                market_id,
                owner: keys::address(&event.owner),
                outcome: event.outcome.to_u64() as u32,
                offered: event.offered.to_string(),
                vintage,
                // Vintage 0 is reserved for the creator's seed legs; no `enter` call can
                // produce it, because `enter` stamps the current block number.
                seed: vintage == 0,
                outcomes_hint: hint.map(|h| h.outcomes).unwrap_or_default(),
                kappa_hint: hint.map(|h| h.kappa.clone()).unwrap_or_default(),
                meta: Some(meta),
                ..Default::default()
            });
            continue;
        }

        // The classic settler's Entered has no vintage. Its positions are all vintage 0
        // in the sense that nothing is batched, but calling them seed legs would be
        // wrong, so the seed flag stays false and the vintage column stays 0.
        if let Some(event) = abi::classic_parimutuel::events::Entered::match_and_decode(log) {
            let market_id = event.market_id.to_u64();
            let hint = hints.get(&(settler.clone(), market_id));
            out.positions.push(Position {
                id: keys::position_row_id(&settler, event.position_id.to_u64()),
                op: PositionOp::Enter as i32,
                rule: rule as i32,
                market: keys::market_row_id(&settler, market_id),
                settler: settler.clone(),
                position_id: event.position_id.to_u64(),
                market_id,
                owner: keys::address(&event.owner),
                outcome: event.outcome.to_u64() as u32,
                offered: event.offered.to_string(),
                outcomes_hint: hint.map(|h| h.outcomes).unwrap_or_default(),
                kappa_hint: hint.map(|h| h.kappa.clone()).unwrap_or_default(),
                meta: Some(meta),
                ..Default::default()
            });
            continue;
        }

        if let Some(event) = abi::vested_parimutuel::events::VintageFinalized::match_and_decode(log)
        {
            let market_id = event.market_id.to_u64();
            let vintage = event.vintage.to_u64();
            out.vintages.push(Vintage {
                id: keys::vintage_row_id(&settler, market_id, vintage),
                market: keys::market_row_id(&settler, market_id),
                settler,
                market_id,
                vintage,
                entries: event.entries.to_u64(),
                meta: Some(meta),
            });
            continue;
        }

        if let Some(event) = abi::vested_parimutuel::events::Claimed::match_and_decode(log) {
            let position_id = event.position_id.to_u64();
            let position = keys::position_row_id(&settler, position_id);
            let payout = event.payout.to_string();
            let refund = event.refund.to_string();

            out.settlements.push(Settlement {
                id: keys::log_row_id(&position, meta.block_number, meta.log_index),
                position: position.clone(),
                settler: settler.clone(),
                position_id,
                to: keys::address(&event.to),
                payout: payout.clone(),
                refund: refund.clone(),
                meta: Some(meta.clone()),
            });
            out.positions.push(Position {
                id: position,
                op: PositionOp::Settle as i32,
                rule: rule as i32,
                settler,
                position_id,
                payout,
                refund,
                meta: Some(meta),
                ..Default::default()
            });
            continue;
        }

        if let Some(event) =
            abi::vested_parimutuel::events::PositionTransferred::match_and_decode(log)
        {
            let position_id = event.position_id.to_u64();
            out.positions.push(Position {
                id: keys::position_row_id(&settler, position_id),
                op: PositionOp::Transfer as i32,
                rule: rule as i32,
                settler,
                position_id,
                owner: keys::address(&event.to),
                meta: Some(meta),
                ..Default::default()
            });
            continue;
        }

        if let Some(event) = abi::vested_parimutuel::events::ResidueClaimed::match_and_decode(log) {
            let market_id = event.market_id.to_u64();
            out.residues.push(Residue {
                id: keys::market_row_id(&settler, market_id),
                market: keys::market_row_id(&settler, market_id),
                settler,
                market_id,
                to: keys::address(&event.to),
                amount: event.amount.to_string(),
                meta: Some(meta),
            });
        }
    }

    out
}

fn market_hints(contracts: &Contracts, block: &eth::Block) -> HashMap<(String, u64), Hint> {
    let mut hints = HashMap::new();
    for log in block.logs() {
        if contracts.settler_rule(log.address()).is_none() {
            continue;
        }
        if let Some(event) = abi::vested_parimutuel::events::MarketCreated::match_and_decode(log) {
            hints.insert(
                (keys::address(log.address()), event.market_id.to_u64()),
                Hint {
                    outcomes: event.n.to_u64() as u32,
                    kappa: event.kappa.to_string(),
                },
            );
        }
    }
    hints
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amounts;
    use crate::pb::hunch_vpm_v1::SettlementRule;
    use crate::testkit::{self, CLASSIC, VESTED};

    #[test]
    fn an_entry_becomes_a_position_row() {
        let block = testkit::block(vec![testkit::entered(
            VESTED, 3, 42, 0xAA, 1, "2500000", 4_200_000,
        )]);
        let got = map(&testkit::contracts(), &block);

        assert_eq!(got.positions.len(), 1);
        let position = &got.positions[0];
        assert_eq!(position.id, format!("{}-42", keys::address(&VESTED)));
        assert_eq!(position.op, PositionOp::Enter as i32);
        assert_eq!(position.rule, SettlementRule::Vested as i32);
        assert_eq!(position.market, format!("{}-3", keys::address(&VESTED)));
        assert_eq!(position.owner, keys::address(&[0xAA; 20]));
        assert_eq!(position.outcome, 1);
        assert_eq!(position.offered, "2500000");
        assert_eq!(position.vintage, 4_200_000);
        assert!(!position.seed);
    }

    #[test]
    fn vintage_zero_marks_the_creator_seed_legs() {
        let block = testkit::block(vec![
            testkit::market_created(VESTED, 3, 0xAA, 2, "30", 1800),
            testkit::entered(VESTED, 3, 0, 0xAA, 0, "1000000", 0),
            testkit::entered(VESTED, 3, 1, 0xAA, 1, "1000000", 0),
        ]);
        let got = map(&testkit::contracts(), &block);
        assert_eq!(got.positions.len(), 2);
        assert!(got.positions.iter().all(|p| p.seed));
        assert!(got.positions.iter().all(|p| p.vintage == 0));
    }

    #[test]
    fn entries_in_the_creating_block_carry_the_market_hint() {
        let block = testkit::block(vec![
            testkit::market_created(VESTED, 3, 0xAA, 2, "30", 1800),
            testkit::entered(VESTED, 3, 0, 0xAA, 0, "1000000", 0),
        ]);
        let position = &map(&testkit::contracts(), &block).positions[0];
        assert_eq!(position.outcomes_hint, 2);
        assert_eq!(position.kappa_hint, "30");
    }

    #[test]
    fn entries_into_an_older_market_carry_no_hint() {
        let block = testkit::block(vec![testkit::entered(
            VESTED, 3, 9, 0xAB, 0, "500000", 4_200_000,
        )]);
        let position = &map(&testkit::contracts(), &block).positions[0];
        assert_eq!(position.outcomes_hint, 0);
        assert_eq!(position.kappa_hint, "");
    }

    #[test]
    fn a_hint_does_not_leak_across_settlers() {
        let block = testkit::block(vec![
            testkit::market_created(VESTED, 3, 0xAA, 2, "30", 1800),
            testkit::entered_classic(CLASSIC, 3, 0, 0xAA, 0, "1000000"),
        ]);
        let position = &map(&testkit::contracts(), &block).positions[0];
        assert_eq!(position.settler, keys::address(&CLASSIC));
        assert_eq!(position.outcomes_hint, 0);
    }

    #[test]
    fn the_classic_settler_entry_decodes_without_a_vintage() {
        let block = testkit::block(vec![testkit::entered_classic(
            CLASSIC, 7, 11, 0xAB, 0, "750000",
        )]);
        let position = &map(&testkit::contracts(), &block).positions[0];
        assert_eq!(position.rule, SettlementRule::Classic as i32);
        assert_eq!(position.offered, "750000");
        assert_eq!(position.vintage, 0);
        assert!(!position.seed, "a classic entry is not a seed leg");
    }

    #[test]
    fn an_unbounded_kappa_hint_is_carried_verbatim() {
        let unbounded = amounts::kappa_unbounded().to_string();
        let block = testkit::block(vec![
            testkit::market_created(VESTED, 3, 0xAA, 4, &unbounded, 1800),
            testkit::entered(VESTED, 3, 0, 0xAA, 0, "1000000", 0),
        ]);
        let position = &map(&testkit::contracts(), &block).positions[0];
        assert_eq!(position.kappa_hint, unbounded);
        assert_eq!(position.outcomes_hint, 4);
    }

    #[test]
    fn vintage_finalized_records_the_finalizing_block_not_the_vintage_block() {
        let block = testkit::block(vec![testkit::vintage_finalized(VESTED, 3, 4_199_999, 5)]);
        let got = map(&testkit::contracts(), &block);
        assert_eq!(got.vintages.len(), 1);
        let vintage = &got.vintages[0];
        assert_eq!(vintage.vintage, 4_199_999);
        assert_eq!(vintage.entries, 5);
        assert_eq!(vintage.meta.as_ref().unwrap().block_number, testkit::BLOCK);
    }

    #[test]
    fn a_claim_produces_both_a_ledger_row_and_a_position_update() {
        let block = testkit::block(vec![testkit::claimed(
            VESTED, 42, 0xAA, "3100000", "250000",
        )]);
        let got = map(&testkit::contracts(), &block);

        assert_eq!(got.settlements.len(), 1);
        let settlement = &got.settlements[0];
        assert_eq!(settlement.payout, "3100000");
        assert_eq!(settlement.refund, "250000");
        assert_eq!(
            settlement.position,
            format!("{}-42", keys::address(&VESTED))
        );

        assert_eq!(got.positions.len(), 1);
        let position = &got.positions[0];
        assert_eq!(position.op, PositionOp::Settle as i32);
        assert_eq!(position.payout, "3100000");
        assert_eq!(position.refund, "250000");
    }

    #[test]
    fn two_claims_on_one_position_get_distinct_ledger_ids() {
        // withdrawRefund pays the refused remainder, the later claim pays the settlement.
        let block = testkit::block(vec![
            testkit::claimed(VESTED, 42, 0xAA, "0", "250000"),
            testkit::claimed(VESTED, 42, 0xAA, "3100000", "0"),
        ]);
        let got = map(&testkit::contracts(), &block);
        assert_eq!(got.settlements.len(), 2);
        assert_ne!(got.settlements[0].id, got.settlements[1].id);
    }

    #[test]
    fn a_transfer_moves_the_owner_and_nothing_else() {
        let block = testkit::block(vec![testkit::position_transferred(VESTED, 42, 0xAA, 0xBC)]);
        let position = &map(&testkit::contracts(), &block).positions[0];
        assert_eq!(position.op, PositionOp::Transfer as i32);
        assert_eq!(position.owner, keys::address(&[0xBC; 20]));
        assert_eq!(position.offered, "", "a transfer log knows no amount");
    }

    #[test]
    fn residue_is_keyed_by_market_because_it_is_swept_once() {
        let block = testkit::block(vec![testkit::residue_claimed(VESTED, 3, 0xAA, "17")]);
        let got = map(&testkit::contracts(), &block);
        assert_eq!(got.residues.len(), 1);
        assert_eq!(got.residues[0].id, format!("{}-3", keys::address(&VESTED)));
        assert_eq!(got.residues[0].amount, "17");
    }

    #[test]
    fn logs_from_untracked_settlers_are_ignored() {
        let block = testkit::block(vec![testkit::entered(
            [0x77; 20], 3, 42, 0xAA, 1, "2500000", 4_200_000,
        )]);
        assert!(map(&testkit::contracts(), &block).positions.is_empty());
    }
}
