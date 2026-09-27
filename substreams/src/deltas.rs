//! Headroom over time, derived from `store_books`.
//!
//! One row per book per block in which that book moved. The totals come from the store
//! (so a row is a full snapshot, not just what changed) and the deltas come from the
//! store's own deltas (so a consumer can see the movement without differencing rows).
//!
//! Headroom is the number the mechanism turns on: `H_w = C_w - V_w` is the room a book
//! still has to accept stake, and when it runs out a stake is refused and refunded
//! rather than reverted. That makes zero a loaded value in these two columns, so they
//! are left empty — NULL at the sink — whenever there is no finite capacity to report:
//! an unbounded kappa, the classic rule, or a market this run never saw created.

use std::collections::BTreeMap;

use substreams::scalar::BigInt;

use crate::amounts;
use crate::books::MarketLookup;
use crate::keys::{self, BookField, BookId};
use crate::pb::hunch_vpm_v1::{BookDelta, BookDeltas, Meta, SettlementRule};

/// A store delta reduced to what this module needs: which key, and the running totals
/// before and after the block.
pub struct KeyDelta {
    pub key: String,
    pub old_value: BigInt,
    pub new_value: BigInt,
}

/// Point lookup into `store_books`.
pub trait BookReader {
    fn value(&self, key: &str) -> Option<BigInt>;
}

pub fn map(
    deltas: &[KeyDelta],
    store: &impl BookReader,
    markets: &impl MarketLookup,
    meta: Meta,
) -> BookDeltas {
    // BTreeMap rather than HashMap: the row order has to be deterministic, because a
    // sink that replays a block must produce the same change ordinals every time.
    let mut moved: BTreeMap<BookId, Movement> = BTreeMap::new();

    for delta in deltas {
        let Some((book, field)) = keys::parse_book_key(&delta.key) else {
            continue;
        };
        let movement = moved.entry(book).or_default();
        let change = delta.new_value.clone() - delta.old_value.clone();
        match field {
            BookField::Principal => movement.principal = movement.principal.clone() + change,
            BookField::Vested => movement.vested = movement.vested.clone() + change,
            // Capacity moves in lockstep with principal, so reporting it as a delta adds
            // nothing; the snapshot column carries it.
            BookField::Capacity => {}
        }
    }

    let mut out = BookDeltas::default();
    for (book, movement) in moved {
        let shape = markets.shape(&book.settler, book.market_id);
        let rule = shape
            .as_ref()
            .map(|s| s.rule)
            .unwrap_or(SettlementRule::Unspecified);
        let unbounded = shape
            .as_ref()
            .is_some_and(|s| amounts::is_unbounded(&s.kappa));

        let principal = read(store, &book, BookField::Principal);
        let vested = read(store, &book, BookField::Vested);

        // Three cases have no capacity to report, and all three leave both columns empty
        // so the sink writes NULL:
        //
        //   * an unbounded kappa has no finite capacity by construction;
        //   * the classic rule has neither vesting nor capacity, so vested stays at the
        //     zero the store never wrote;
        //   * a market whose creation this run never saw — the start block is after it —
        //     has no known kappa, and store_books wrote no capacity key for its books.
        //
        // The last one is the one worth stating. `read` would hand back zero for the
        // missing key and headroom would floor to zero, and zero headroom is not "we do
        // not know": it is exactly the state in which a book refuses and refunds a stake.
        // Every book on an unknown market would read as permanently full.
        let known = shape.is_some();
        let (capacity, headroom) = if !known || unbounded || rule == SettlementRule::Classic {
            (String::new(), String::new())
        } else {
            let capacity = read(store, &book, BookField::Capacity);
            let headroom = amounts::headroom(&capacity, &vested);
            (capacity.to_string(), headroom.to_string())
        };

        out.deltas.push(BookDelta {
            id: format!("{}-{}", book.row_id(), meta.block_number),
            market: book.market_row_id(),
            settler: book.settler.clone(),
            market_id: book.market_id,
            outcome: book.outcome,
            book: book.row_id(),
            principal: principal.to_string(),
            vested: vested.to_string(),
            capacity,
            headroom,
            unbounded,
            principal_delta: movement.principal.to_string(),
            vested_delta: movement.vested.to_string(),
            rule: rule as i32,
            meta: Some(meta.clone()),
        });
    }

    out
}

#[derive(Default)]
struct Movement {
    principal: BigInt,
    vested: BigInt,
}

fn read(store: &impl BookReader, book: &BookId, field: BookField) -> BigInt {
    store
        .value(&keys::book_key(book, field))
        .unwrap_or_else(BigInt::zero)
}

/// Block-level provenance for an aggregate row.
pub fn block_meta(block_number: u64, timestamp: u64) -> Meta {
    Meta {
        block_number,
        timestamp,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::books::MarketShape;

    const SETTLER: &str = "0x1111111111111111111111111111111111111111";

    #[derive(Default)]
    struct Store(HashMap<String, BigInt>);

    impl Store {
        fn with(mut self, outcome: u32, field: BookField, value: &str) -> Self {
            self.0.insert(
                keys::book_key(&BookId::new(SETTLER, 1, outcome), field),
                amounts::parse(value),
            );
            self
        }
    }

    impl BookReader for Store {
        fn value(&self, key: &str) -> Option<BigInt> {
            self.0.get(key).cloned()
        }
    }

    struct Market(Option<MarketShape>);

    impl MarketLookup for Market {
        fn shape(&self, _settler: &str, _market_id: u64) -> Option<MarketShape> {
            self.0.clone()
        }
    }

    fn vested_market(kappa: &str) -> Market {
        Market(Some(MarketShape {
            outcomes: 2,
            kappa: amounts::parse(kappa),
            rule: SettlementRule::Vested,
        }))
    }

    fn delta(outcome: u32, field: BookField, old: &str, new: &str) -> KeyDelta {
        KeyDelta {
            key: keys::book_key(&BookId::new(SETTLER, 1, outcome), field),
            old_value: amounts::parse(old),
            new_value: amounts::parse(new),
        }
    }

    fn meta() -> Meta {
        block_meta(4_200_000, 1_760_000_000)
    }

    #[test]
    fn headroom_is_capacity_minus_vested() {
        let store = Store::default()
            .with(0, BookField::Principal, "1000000")
            .with(0, BookField::Capacity, "30000000")
            .with(0, BookField::Vested, "4000000");
        let got = map(
            &[delta(0, BookField::Vested, "3000000", "4000000")],
            &store,
            &vested_market("30"),
            meta(),
        );

        assert_eq!(got.deltas.len(), 1);
        let row = &got.deltas[0];
        assert_eq!(row.principal, "1000000");
        assert_eq!(row.capacity, "30000000");
        assert_eq!(row.vested, "4000000");
        assert_eq!(row.headroom, "26000000");
        assert_eq!(row.vested_delta, "1000000");
        assert_eq!(row.principal_delta, "0");
        assert!(!row.unbounded);
        assert_eq!(row.rule, SettlementRule::Vested as i32);
    }

    #[test]
    fn a_full_book_reports_zero_headroom_not_a_negative_one() {
        let store = Store::default()
            .with(0, BookField::Capacity, "1000000")
            .with(0, BookField::Vested, "1500000");
        let got = map(
            &[delta(0, BookField::Vested, "900000", "1500000")],
            &store,
            &vested_market("30"),
            meta(),
        );
        assert_eq!(got.deltas[0].headroom, "0");
    }

    #[test]
    fn an_unbounded_market_leaves_capacity_and_headroom_empty() {
        let unbounded = amounts::kappa_unbounded().to_string();
        let store = Store::default()
            .with(0, BookField::Principal, "1000000")
            .with(0, BookField::Vested, "9000000");
        let got = map(
            &[delta(0, BookField::Vested, "0", "9000000")],
            &store,
            &vested_market(&unbounded),
            meta(),
        );
        let row = &got.deltas[0];
        assert!(row.unbounded);
        assert_eq!(row.capacity, "");
        assert_eq!(row.headroom, "");
        assert_eq!(row.vested, "9000000");
    }

    #[test]
    fn a_classic_book_reports_principal_only() {
        let store = Store::default().with(0, BookField::Principal, "1000000");
        let market = Market(Some(MarketShape {
            outcomes: 2,
            kappa: amounts::parse("30"),
            rule: SettlementRule::Classic,
        }));
        let got = map(
            &[delta(0, BookField::Principal, "0", "1000000")],
            &store,
            &market,
            meta(),
        );
        let row = &got.deltas[0];
        assert_eq!(row.principal, "1000000");
        assert_eq!(row.capacity, "");
        assert_eq!(row.headroom, "");
        assert_eq!(row.rule, SettlementRule::Classic as i32);
    }

    #[test]
    fn one_row_per_book_however_many_keys_moved() {
        let store = Store::default()
            .with(0, BookField::Principal, "1000000")
            .with(0, BookField::Capacity, "30000000")
            .with(0, BookField::Vested, "500000");
        let got = map(
            &[
                delta(0, BookField::Principal, "0", "1000000"),
                delta(0, BookField::Capacity, "0", "30000000"),
                delta(0, BookField::Vested, "0", "500000"),
            ],
            &store,
            &vested_market("30"),
            meta(),
        );
        assert_eq!(got.deltas.len(), 1);
        assert_eq!(got.deltas[0].principal_delta, "1000000");
        assert_eq!(got.deltas[0].vested_delta, "500000");
    }

    #[test]
    fn rows_come_out_in_a_deterministic_order() {
        let store = Store::default();
        let deltas = vec![
            delta(2, BookField::Principal, "0", "1"),
            delta(0, BookField::Principal, "0", "1"),
            delta(1, BookField::Principal, "0", "1"),
        ];
        let got = map(&deltas, &store, &vested_market("30"), meta());
        let outcomes: Vec<u32> = got.deltas.iter().map(|d| d.outcome).collect();
        assert_eq!(outcomes, vec![0, 1, 2]);
    }

    #[test]
    fn a_negative_delta_from_a_refund_is_reported_as_such() {
        let store = Store::default().with(0, BookField::Principal, "600000");
        let got = map(
            &[delta(0, BookField::Principal, "1000000", "600000")],
            &store,
            &vested_market("30"),
            meta(),
        );
        assert_eq!(got.deltas[0].principal_delta, "-400000");
        assert_eq!(got.deltas[0].principal, "600000");
    }

    #[test]
    fn keys_written_by_something_else_are_ignored() {
        let got = map(
            &[KeyDelta {
                key: "someone:elses:key".to_string(),
                old_value: BigInt::zero(),
                new_value: BigInt::one(),
            }],
            &Store::default(),
            &vested_market("30"),
            meta(),
        );
        assert!(got.deltas.is_empty());
    }

    #[test]
    fn a_book_whose_market_is_unknown_still_reports_its_principal() {
        // Starting mid-history, the creation event is behind the start block. The
        // principal is still meaningful; the capacity is not claimed.
        let store = Store::default().with(0, BookField::Principal, "1000000");
        let got = map(
            &[delta(0, BookField::Principal, "0", "1000000")],
            &store,
            &Market(None),
            meta(),
        );
        let row = &got.deltas[0];
        assert_eq!(row.principal, "1000000");
        assert_eq!(row.rule, SettlementRule::Unspecified as i32);
        assert_eq!(row.capacity, "", "unknown kappa is not zero kappa");
        assert_eq!(
            row.headroom, "",
            "zero headroom is the state in which a book refuses stake, not 'unknown'"
        );
        assert!(
            !row.unbounded,
            "unknown kappa is not unbounded kappa either"
        );
    }

    #[test]
    fn the_row_id_pins_a_book_to_a_block() {
        let got = map(
            &[delta(1, BookField::Principal, "0", "1")],
            &Store::default(),
            &vested_market("30"),
            meta(),
        );
        assert_eq!(got.deltas[0].id, format!("{SETTLER}-1-1-4200000"));
        assert_eq!(got.deltas[0].book, format!("{SETTLER}-1-1"));
    }
}
