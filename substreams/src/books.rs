//! Per-outcome book accounting: principal P_w, vested V_w and capacity C_w.
//!
//! # Why this is a reconstruction and not a read
//!
//! The settler never logs the accepted amount. `Entered` carries the OFFERED stake;
//! `VintageFinalized` carries only how many entries the vintage held. The accepted
//! amount is decided inside `_finalizeVintage` by rationing each entry against the
//! headroom its opposing books had at vintage start, and no log carries the result.
//!
//! An indexer cannot recompute it either. The rationing is a read-modify-write of book
//! state — you need H_w before you can know what was accepted, and you need what was
//! accepted before you can update H_w — and a Substreams module graph has no cycle in
//! which to express that: a store handler cannot read its own store.
//!
//! So the books here are built on the OFFERED basis and corrected to the accepted basis
//! as the evidence arrives:
//!
//!   * an entry adds its offered amount to its own book's principal and to every
//!     opposing book's vested total;
//!   * when a position later withdraws its refused remainder, the `Claimed` log carries
//!     that refund, which is exactly `offered - accepted`, and it is subtracted back out.
//!
//! Consequences, stated plainly:
//!
//!   * when nothing was rationed — every entry accepted in full, which is the case
//!     whenever the books have headroom to spare, and always when kappa is unbounded —
//!     the numbers are exact from the moment of entry;
//!   * when something was rationed, the books overstate by the refused amount until that
//!     position's refund is withdrawn, and are exact afterwards;
//!   * the creator's seed legs are the one case that never converges. An asymmetric seed
//!     is clamped at creation and the refused part is never pulled from the creator, so
//!     no refund log is ever emitted for it. A symmetric seed — the normal case — is
//!     accepted in full and is exact.
//!
//! Timing follows the same rule: the settler books a vintage lazily, at the first later
//! transaction that touches the market, so its own books move one or more blocks after
//! the entries. These books move at the entry block. The `vintage` table records when
//! each vintage was actually finalized, so the lag is recoverable.

use substreams::scalar::BigInt;

use crate::amounts;
use crate::keys::{book_key, BookField, BookId};
use crate::pb::hunch_vpm_v1::{Meta, Position, PositionOp, PositionRef, Positions, SettlementRule};

/// What a market's shape says about how its books move. Only the creation event knows
/// both numbers, which is why `store_markets` holds the creation shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketShape {
    pub outcomes: u32,
    pub kappa: BigInt,
    pub rule: SettlementRule,
}

/// One additive change to one store key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookAdd {
    pub book: BookId,
    pub field: BookField,
    pub amount: BigInt,
    /// The ordinal of the log that caused this change. Store writes are sorted by it so
    /// the store's own deltas come out in chain order, whatever order this module
    /// happened to walk the rows in.
    pub ordinal: u64,
}

impl BookAdd {
    pub fn key(&self) -> String {
        book_key(&self.book, self.field)
    }
}

/// Looks a market's creation shape up by settler and id.
pub trait MarketLookup {
    fn shape(&self, settler: &str, market_id: u64) -> Option<MarketShape>;
}

/// Looks a position up by settler and id, so a `Claimed` log — which carries only a
/// position id — can be attributed to the book its refund has to come out of.
pub trait PositionLookup {
    fn position(&self, settler: &str, position_id: u64) -> Option<PositionRef>;
}

/// The complete set of store writes this block's position rows imply.
///
/// Shared by `store_books`, which applies them, and `map_book_deltas`, which reports
/// them, so the two can never disagree about what moved.
pub fn book_adds(
    positions: &Positions,
    markets: &impl MarketLookup,
    lookup: &impl PositionLookup,
) -> Vec<BookAdd> {
    let mut adds = Vec::new();

    for position in &positions.positions {
        if position.op != PositionOp::Enter as i32 {
            continue;
        }
        let Some(shape) = shape_for(position, markets) else {
            // A market whose creation this run never saw — the usual cause is a start
            // block after the market opened. Skipping keeps the books absent rather
            // than wrong.
            continue;
        };
        let offered = amounts::parse(&position.offered);
        if offered.is_zero() {
            continue;
        }
        push_entry(
            &mut adds,
            position,
            &shape,
            &offered,
            ordinal_of(position.meta.as_ref()),
        );
    }

    for settlement in &positions.settlements {
        let refund = amounts::parse(&settlement.refund);
        if refund.is_zero() {
            continue;
        }
        let Some(reference) = lookup.position(&settlement.settler, settlement.position_id) else {
            continue;
        };
        let Some(shape) = markets.shape(&settlement.settler, reference.market_id) else {
            continue;
        };
        push_refund(
            &mut adds,
            settlement.settler.clone(),
            &reference,
            &shape,
            &refund,
            ordinal_of(settlement.meta.as_ref()),
        );
    }

    adds.sort_by_key(|add| add.ordinal);
    adds
}

fn ordinal_of(meta: Option<&Meta>) -> u64 {
    meta.map(|m| m.ordinal).unwrap_or_default()
}

fn push_entry(
    adds: &mut Vec<BookAdd>,
    position: &Position,
    shape: &MarketShape,
    offered: &BigInt,
    ordinal: u64,
) {
    let own = BookId::new(
        position.settler.clone(),
        position.market_id,
        position.outcome,
    );
    adds.push(BookAdd {
        book: own.clone(),
        field: BookField::Principal,
        amount: offered.clone(),
        ordinal,
    });

    // The classic rule has no vesting and no capacity — every stake is accepted and the
    // pool is split at settlement. Emitting the two columns for it would invent a
    // mechanism the contract does not have, so its books carry principal only.
    if shape.rule != SettlementRule::Vested {
        return;
    }

    if let Some(capacity) = amounts::capacity_for(&shape.kappa, offered) {
        adds.push(BookAdd {
            book: own,
            field: BookField::Capacity,
            amount: capacity,
            ordinal,
        });
    }

    // Rule 1: a stake vests into every opposing book, and never into its own.
    for other in 0..shape.outcomes {
        if other == position.outcome {
            continue;
        }
        adds.push(BookAdd {
            book: BookId::new(position.settler.clone(), position.market_id, other),
            field: BookField::Vested,
            amount: offered.clone(),
            ordinal,
        });
    }
}

fn push_refund(
    adds: &mut Vec<BookAdd>,
    settler: String,
    reference: &PositionRef,
    shape: &MarketShape,
    refund: &BigInt,
    ordinal: u64,
) {
    let own = BookId::new(settler.clone(), reference.market_id, reference.outcome);
    adds.push(BookAdd {
        book: own.clone(),
        field: BookField::Principal,
        amount: -refund.clone(),
        ordinal,
    });

    if shape.rule != SettlementRule::Vested {
        return;
    }

    if let Some(capacity) = amounts::capacity_for(&shape.kappa, refund) {
        adds.push(BookAdd {
            book: own,
            field: BookField::Capacity,
            amount: -capacity,
            ordinal,
        });
    }

    for other in 0..shape.outcomes {
        if other == reference.outcome {
            continue;
        }
        adds.push(BookAdd {
            book: BookId::new(settler.clone(), reference.market_id, other),
            field: BookField::Vested,
            amount: -refund.clone(),
            ordinal,
        });
    }
}

/// The in-block hint wins over the store: an entry in the same block as its market's
/// creation is the seed leg, and no store has that market yet.
fn shape_for(position: &Position, markets: &impl MarketLookup) -> Option<MarketShape> {
    if position.outcomes_hint > 0 && !position.kappa_hint.is_empty() {
        return Some(MarketShape {
            outcomes: position.outcomes_hint,
            kappa: amounts::parse(&position.kappa_hint),
            rule: rule_of(position.rule),
        });
    }
    markets.shape(&position.settler, position.market_id)
}

pub fn rule_of(rule: i32) -> SettlementRule {
    match rule {
        x if x == SettlementRule::Vested as i32 => SettlementRule::Vested,
        x if x == SettlementRule::Classic as i32 => SettlementRule::Classic,
        _ => SettlementRule::Unspecified,
    }
}

/// What `store_positions` needs to keep for each entry.
pub fn position_refs(positions: &Positions) -> Vec<(u64, String, PositionRef)> {
    positions
        .positions
        .iter()
        .filter(|p| p.op == PositionOp::Enter as i32)
        .map(|p| {
            (
                p.position_id,
                p.settler.clone(),
                PositionRef {
                    settler: p.settler.clone(),
                    market_id: p.market_id,
                    outcome: p.outcome,
                    offered: p.offered.clone(),
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::keys;
    use crate::pb::hunch_vpm_v1::Settlement;

    const SETTLER: &str = "0x1111111111111111111111111111111111111111";

    #[derive(Default)]
    struct Markets(HashMap<(String, u64), MarketShape>);

    impl Markets {
        fn with(
            mut self,
            market_id: u64,
            outcomes: u32,
            kappa: &str,
            rule: SettlementRule,
        ) -> Self {
            self.0.insert(
                (SETTLER.to_string(), market_id),
                MarketShape {
                    outcomes,
                    kappa: amounts::parse(kappa),
                    rule,
                },
            );
            self
        }
    }

    impl MarketLookup for Markets {
        fn shape(&self, settler: &str, market_id: u64) -> Option<MarketShape> {
            self.0.get(&(settler.to_string(), market_id)).cloned()
        }
    }

    #[derive(Default)]
    struct Refs(HashMap<(String, u64), PositionRef>);

    impl Refs {
        fn with(mut self, position_id: u64, market_id: u64, outcome: u32, offered: &str) -> Self {
            self.0.insert(
                (SETTLER.to_string(), position_id),
                PositionRef {
                    settler: SETTLER.to_string(),
                    market_id,
                    outcome,
                    offered: offered.to_string(),
                },
            );
            self
        }
    }

    impl PositionLookup for Refs {
        fn position(&self, settler: &str, position_id: u64) -> Option<PositionRef> {
            self.0.get(&(settler.to_string(), position_id)).cloned()
        }
    }

    fn entry(market_id: u64, outcome: u32, offered: &str) -> Position {
        Position {
            id: keys::position_row_id(SETTLER, 1),
            op: PositionOp::Enter as i32,
            rule: SettlementRule::Vested as i32,
            settler: SETTLER.to_string(),
            market_id,
            outcome,
            offered: offered.to_string(),
            ..Default::default()
        }
    }

    fn settlement(position_id: u64, refund: &str) -> Settlement {
        Settlement {
            settler: SETTLER.to_string(),
            position_id,
            refund: refund.to_string(),
            ..Default::default()
        }
    }

    fn amount_at(adds: &[BookAdd], outcome: u32, field: BookField) -> BigInt {
        adds.iter()
            .filter(|a| a.book.outcome == outcome && a.field == field)
            .fold(BigInt::zero(), |acc, a| acc + a.amount.clone())
    }

    #[test]
    fn an_entry_books_its_own_principal_and_capacity() {
        let positions = Positions {
            positions: vec![entry(1, 0, "1000000")],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 2, "30", SettlementRule::Vested),
            &Refs::default(),
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Principal),
            BigInt::from(1_000_000u64)
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Capacity),
            BigInt::from(30_000_000u64)
        );
    }

    #[test]
    fn a_stake_vests_into_every_opposing_book_and_never_its_own() {
        let positions = Positions {
            positions: vec![entry(1, 1, "500000")],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 3, "30", SettlementRule::Vested),
            &Refs::default(),
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Vested),
            BigInt::from(500_000u64)
        );
        assert_eq!(
            amount_at(&adds, 2, BookField::Vested),
            BigInt::from(500_000u64)
        );
        assert_eq!(
            amount_at(&adds, 1, BookField::Vested),
            BigInt::zero(),
            "a stake must not vest into the outcome it backs"
        );
    }

    #[test]
    fn an_unbounded_kappa_books_no_capacity_at_all() {
        let unbounded = amounts::kappa_unbounded().to_string();
        let positions = Positions {
            positions: vec![entry(1, 0, "1000000")],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 4, &unbounded, SettlementRule::Vested),
            &Refs::default(),
        );
        assert!(
            !adds.iter().any(|a| a.field == BookField::Capacity),
            "the sentinel must never be written out as a number"
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Principal),
            BigInt::from(1_000_000u64)
        );
        assert_eq!(
            amount_at(&adds, 1, BookField::Vested),
            BigInt::from(1_000_000u64)
        );
    }

    #[test]
    fn the_classic_rule_books_principal_only() {
        let mut position = entry(1, 0, "1000000");
        position.rule = SettlementRule::Classic as i32;
        let positions = Positions {
            positions: vec![position],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 2, "30", SettlementRule::Classic),
            &Refs::default(),
        );
        assert_eq!(adds.len(), 1);
        assert_eq!(adds[0].field, BookField::Principal);
    }

    #[test]
    fn a_refund_reverses_the_offered_basis_exactly() {
        let positions = Positions {
            settlements: vec![settlement(7, "250000")],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 2, "30", SettlementRule::Vested),
            &Refs::default().with(7, 1, 0, "1000000"),
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Principal),
            BigInt::from(-250_000i64)
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Capacity),
            BigInt::from(-7_500_000i64)
        );
        assert_eq!(
            amount_at(&adds, 1, BookField::Vested),
            BigInt::from(-250_000i64)
        );
    }

    #[test]
    fn an_entry_and_its_later_refund_net_to_the_accepted_amount() {
        let entered = Positions {
            positions: vec![entry(1, 0, "1000000")],
            ..Default::default()
        };
        let refunded = Positions {
            settlements: vec![settlement(7, "400000")],
            ..Default::default()
        };
        let markets = Markets::default().with(1, 2, "30", SettlementRule::Vested);
        let refs = Refs::default().with(7, 1, 0, "1000000");

        let mut adds = book_adds(&entered, &markets, &Refs::default());
        adds.extend(book_adds(&refunded, &markets, &refs));

        // 1_000_000 offered, 400_000 refused, so 600_000 accepted.
        assert_eq!(
            amount_at(&adds, 0, BookField::Principal),
            BigInt::from(600_000u64)
        );
        assert_eq!(
            amount_at(&adds, 1, BookField::Vested),
            BigInt::from(600_000u64)
        );
        assert_eq!(
            amount_at(&adds, 0, BookField::Capacity),
            BigInt::from(18_000_000u64)
        );
    }

    #[test]
    fn a_claim_with_no_refund_moves_no_book() {
        let positions = Positions {
            settlements: vec![settlement(7, "0")],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 2, "30", SettlementRule::Vested),
            &Refs::default().with(7, 1, 0, "1000000"),
        );
        assert!(adds.is_empty());
    }

    #[test]
    fn an_entry_into_an_unknown_market_is_skipped_rather_than_guessed() {
        let positions = Positions {
            positions: vec![entry(99, 0, "1000000")],
            ..Default::default()
        };
        let adds = book_adds(&positions, &Markets::default(), &Refs::default());
        assert!(adds.is_empty());
    }

    #[test]
    fn a_refund_for_an_unknown_position_is_skipped() {
        let positions = Positions {
            settlements: vec![settlement(7, "250000")],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 2, "30", SettlementRule::Vested),
            &Refs::default(),
        );
        assert!(adds.is_empty());
    }

    #[test]
    fn the_in_block_hint_opens_a_book_the_store_has_never_seen() {
        // The seed legs are logged in the same transaction as MarketCreated.
        let mut position = entry(1, 0, "1000000");
        position.outcomes_hint = 2;
        position.kappa_hint = "30".to_string();
        position.seed = true;
        let positions = Positions {
            positions: vec![position],
            ..Default::default()
        };
        let adds = book_adds(&positions, &Markets::default(), &Refs::default());
        assert_eq!(
            amount_at(&adds, 0, BookField::Principal),
            BigInt::from(1_000_000u64)
        );
        assert_eq!(
            amount_at(&adds, 1, BookField::Vested),
            BigInt::from(1_000_000u64)
        );
    }

    #[test]
    fn non_entry_rows_move_no_book() {
        let mut transfer = entry(1, 0, "1000000");
        transfer.op = PositionOp::Transfer as i32;
        let positions = Positions {
            positions: vec![transfer],
            ..Default::default()
        };
        let adds = book_adds(
            &positions,
            &Markets::default().with(1, 2, "30", SettlementRule::Vested),
            &Refs::default(),
        );
        assert!(adds.is_empty(), "a transfer changes an owner, not a book");
    }

    #[test]
    fn position_refs_cover_entries_only() {
        let mut settle = entry(1, 0, "1000000");
        settle.op = PositionOp::Settle as i32;
        let positions = Positions {
            positions: vec![entry(1, 0, "1000000"), settle],
            ..Default::default()
        };
        assert_eq!(position_refs(&positions).len(), 1);
    }

    #[test]
    fn store_keys_are_derived_from_the_book_id() {
        let add = BookAdd {
            book: BookId::new(SETTLER, 3, 1),
            field: BookField::Vested,
            amount: BigInt::one(),
            ordinal: 0,
        };
        assert_eq!(add.key(), format!("book:{SETTLER}:3:1:vested"));
    }
}
