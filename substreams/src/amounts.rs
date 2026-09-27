//! Amount arithmetic that mirrors the settler's, including its saturating sentinel.
//!
//! The settler uses `type(uint256).max` as "kappa is unbounded", the prescription for
//! n-way markets, and defines `kappa * x` to be 0 for x = 0 and the sentinel otherwise.
//! An indexer that multiplied the sentinel out would produce a number no sink column can
//! hold, so unbounded capacity is carried as a flag and the capacity and headroom columns
//! are left empty for those books.

use std::str::FromStr;

use substreams::scalar::BigInt;

/// 2^256 - 1, the settler's KAPPA_UNBOUNDED.
pub fn kappa_unbounded() -> BigInt {
    // 2^256 - 1. Written as an expression rather than a literal so it is checkable by
    // eye against the Solidity `type(uint256).max`.
    let two = BigInt::from(2u64);
    two.pow(256) - BigInt::one()
}

pub fn is_unbounded(kappa: &BigInt) -> bool {
    *kappa == kappa_unbounded()
}

/// Parses a decimal amount string, treating an empty or malformed value as zero.
///
/// Empty is the normal case: proto3 has no null, so a field the emitting event did not
/// know is an empty string.
pub fn parse(value: &str) -> BigInt {
    if value.is_empty() {
        return BigInt::zero();
    }
    BigInt::from_str(value).unwrap_or_else(|_| BigInt::zero())
}

/// H_w = C_w - V_w, floored at zero.
///
/// The settler floors it too (`capacity > vested ? capacity - vested : 0`): vested can
/// exceed capacity after a partial fill leaves a book at exactly its cap and a later
/// vintage rounds against it, and a negative headroom is not a thing the mechanism has.
pub fn headroom(capacity: &BigInt, vested: &BigInt) -> BigInt {
    if capacity > vested {
        capacity.clone() - vested.clone()
    } else {
        BigInt::zero()
    }
}

/// kappa * amount, with the settler's sentinel rule. Returns None when kappa is
/// unbounded and the product would be the sentinel, i.e. when capacity is not a number.
pub fn capacity_for(kappa: &BigInt, amount: &BigInt) -> Option<BigInt> {
    if is_unbounded(kappa) {
        if amount.is_zero() {
            return Some(BigInt::zero());
        }
        return None;
    }
    Some(kappa.clone() * amount.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(value: &str) -> BigInt {
        BigInt::from_str(value).unwrap()
    }

    #[test]
    fn the_unbounded_sentinel_matches_solidity_uint256_max() {
        assert_eq!(
            kappa_unbounded().to_string(),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
        assert!(is_unbounded(&kappa_unbounded()));
        assert!(!is_unbounded(&BigInt::from(30u64)));
    }

    #[test]
    fn headroom_is_capacity_minus_vested() {
        assert_eq!(headroom(&big("3000"), &big("1200")), big("1800"));
    }

    #[test]
    fn headroom_floors_at_zero_when_a_book_is_full() {
        assert_eq!(headroom(&big("1000"), &big("1000")), BigInt::zero());
        assert_eq!(headroom(&big("1000"), &big("1500")), BigInt::zero());
    }

    #[test]
    fn capacity_is_kappa_times_principal() {
        // kappa is 30 for binary markets.
        assert_eq!(
            capacity_for(&big("30"), &big("1000000")),
            Some(big("30000000"))
        );
    }

    #[test]
    fn unbounded_kappa_has_no_capacity_number() {
        assert_eq!(capacity_for(&kappa_unbounded(), &big("1000000")), None);
    }

    #[test]
    fn unbounded_kappa_times_zero_is_zero_as_in_the_settler() {
        assert_eq!(
            capacity_for(&kappa_unbounded(), &BigInt::zero()),
            Some(BigInt::zero())
        );
    }

    #[test]
    fn parse_treats_absent_and_malformed_values_as_zero() {
        assert_eq!(parse(""), BigInt::zero());
        assert_eq!(parse("not a number"), BigInt::zero());
        assert_eq!(parse("1250000"), big("1250000"));
    }

    #[test]
    fn amounts_beyond_u128_survive_a_round_trip() {
        // A uint256 book under kappa 30 does not fit any fixed-width integer the sink or
        // the protobuf schema offers, which is why these columns are strings.
        let huge =
            big("115792089237316195423570985008687907853269984665640564039457584007913129639935");
        assert_eq!(parse(&huge.to_string()), huge);
    }
}
