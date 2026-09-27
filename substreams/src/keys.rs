//! Store key and row id encoding.
//!
//! Every store key is `kind:settler:...`, colon-separated, with the settler address in
//! lowercase 0x hex. `map_book_deltas` reads book keys back out of store deltas, so the
//! encoding has to round-trip exactly; that is what the tests here pin down.
//!
//! Row ids use `-` instead of `:` so they read the way the rest of the stack writes
//! composite ids, and so a key and an id can never be confused for each other.

use crate::pb::hunch_vpm_v1::SettlementRule;

/// The three per-outcome scalars store_books tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookField {
    /// P_w, accepted principal on the outcome.
    Principal,
    /// V_w, total stake vested into the outcome from opposing entries.
    Vested,
    /// C_w = kappa * P_w. Absent for a market with an unbounded kappa.
    Capacity,
}

impl BookField {
    pub const ALL: [BookField; 3] = [BookField::Principal, BookField::Vested, BookField::Capacity];

    pub fn as_str(self) -> &'static str {
        match self {
            BookField::Principal => "principal",
            BookField::Vested => "vested",
            BookField::Capacity => "capacity",
        }
    }

    /// Not `FromStr`: these names are an internal key encoding, not a public parse.
    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "principal" => Some(BookField::Principal),
            "vested" => Some(BookField::Vested),
            "capacity" => Some(BookField::Capacity),
            _ => None,
        }
    }
}

/// The book a store key or a row refers to.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BookId {
    pub settler: String,
    pub market_id: u64,
    pub outcome: u32,
}

impl BookId {
    pub fn new(settler: impl Into<String>, market_id: u64, outcome: u32) -> Self {
        BookId {
            settler: settler.into(),
            market_id,
            outcome,
        }
    }

    /// The row id of the book itself, shared by every BookDelta row for it.
    pub fn row_id(&self) -> String {
        format!("{}-{}-{}", self.settler, self.market_id, self.outcome)
    }

    pub fn market_row_id(&self) -> String {
        market_row_id(&self.settler, self.market_id)
    }
}

pub fn book_key(book: &BookId, field: BookField) -> String {
    format!(
        "book:{}:{}:{}:{}",
        book.settler,
        book.market_id,
        book.outcome,
        field.as_str()
    )
}

/// Inverse of [`book_key`]. Returns None for any key this module did not write, so a
/// store shared with another writer cannot corrupt the book table.
pub fn parse_book_key(key: &str) -> Option<(BookId, BookField)> {
    let mut parts = key.split(':');
    if parts.next()? != "book" {
        return None;
    }
    let settler = parts.next()?.to_string();
    let market_id = parts.next()?.parse().ok()?;
    let outcome = parts.next()?.parse().ok()?;
    let field = BookField::from_name(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some((
        BookId {
            settler,
            market_id,
            outcome,
        },
        field,
    ))
}

pub fn market_key(settler: &str, market_id: u64) -> String {
    format!("market:{settler}:{market_id}")
}

pub fn position_key(settler: &str, position_id: u64) -> String {
    format!("position:{settler}:{position_id}")
}

pub fn market_row_id(settler: &str, market_id: u64) -> String {
    format!("{settler}-{market_id}")
}

pub fn position_row_id(settler: &str, position_id: u64) -> String {
    format!("{settler}-{position_id}")
}

pub fn vintage_row_id(settler: &str, market_id: u64, vintage: u64) -> String {
    format!("{settler}-{market_id}-{vintage}")
}

/// Settlements and feed readings are append-only, so their ids carry the log they came
/// from: one position can settle twice (a refund withdrawal, then the claim).
pub fn log_row_id(prefix: &str, block_number: u64, log_index: u64) -> String {
    format!("{prefix}-{block_number}-{log_index}")
}

/// Lowercase 0x hex, the form every id and store key uses.
pub fn address(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

pub fn rule_name(rule: SettlementRule) -> &'static str {
    match rule {
        SettlementRule::Unspecified => "UNSPECIFIED",
        SettlementRule::Vested => "VESTED",
        SettlementRule::Classic => "CLASSIC",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> BookId {
        BookId::new("0xabc0000000000000000000000000000000000001", 7, 1)
    }

    #[test]
    fn book_keys_round_trip_through_every_field() {
        for field in BookField::ALL {
            let key = book_key(&book(), field);
            let (got_book, got_field) = parse_book_key(&key).expect("parses");
            assert_eq!(got_book, book());
            assert_eq!(got_field, field);
        }
    }

    #[test]
    fn book_keys_are_distinct_per_field_and_outcome() {
        let a = book_key(&book(), BookField::Principal);
        let b = book_key(&book(), BookField::Vested);
        let c = book_key(&BookId::new(book().settler, 7, 2), BookField::Principal);
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn foreign_keys_are_rejected_rather_than_misparsed() {
        for bad in [
            "market:0xabc:7",
            "book:0xabc:7:1",
            "book:0xabc:7:1:principal:extra",
            "book:0xabc:notanumber:1:principal",
            "book:0xabc:7:1:demand",
            "",
        ] {
            assert!(parse_book_key(bad).is_none(), "{bad} should not parse");
        }
    }

    #[test]
    fn addresses_are_lowercase_hex_with_the_prefix() {
        assert_eq!(
            address(&[0xAB, 0xCD]),
            "0xabcd",
            "ids are compared as strings, so the case has to be fixed"
        );
    }

    #[test]
    fn ids_separate_their_parts_unambiguously() {
        assert_eq!(market_row_id("0xaa", 12), "0xaa-12");
        assert_eq!(vintage_row_id("0xaa", 12, 900), "0xaa-12-900");
        assert_eq!(log_row_id("0xaa-3", 100, 4), "0xaa-3-100-4");
        assert_eq!(book().row_id(), format!("{}-7-1", book().settler));
    }
}
