//! Synthetic Firehose blocks for the decoder tests.
//!
//! Logs are built from the committed ABI rather than from hand-written topic hashes, so
//! a signature change in a contract shows up as a failing test here instead of as an
//! indexer that silently stops matching.
//!
//! No Firehose endpoint for Arc exists yet (see README), so these blocks are the only way
//! to exercise the decoders end to end. They are deliberately literal: one transaction,
//! logs in order, block index and ordinal assigned the way a real block assigns them.

#![cfg(test)]

use ethabi::ethereum_types::U256;
use ethabi::{Contract, Token};
use num_bigint::{BigInt as NumBigInt, Sign};
use num_traits::Num;
use substreams_ethereum::pb::eth::v2 as eth;

use crate::params::Contracts;

pub const VESTED: [u8; 20] = [0x11; 20];
pub const CLASSIC: [u8; 20] = [0x22; 20];
pub const FACTORY: [u8; 20] = [0x33; 20];
pub const RESOLVER: [u8; 20] = [0x44; 20];

pub const BLOCK: u64 = 4_200_000;
pub const TIMESTAMP: u64 = 1_760_000_000;
pub const TX_HASH: [u8; 32] = [0x5A; 32];

pub fn contracts() -> Contracts {
    Contracts {
        vested: Some(VESTED),
        classic: Some(CLASSIC),
        factory: Some(FACTORY),
        resolver: Some(RESOLVER),
    }
}

/// A raw log before it is placed in a block.
pub struct RawLog {
    pub address: Vec<u8>,
    pub topics: Vec<Vec<u8>>,
    pub data: Vec<u8>,
}

pub fn block(logs: Vec<RawLog>) -> eth::Block {
    block_at(BLOCK, logs, 1)
}

/// A block whose transaction reverted. `Block::logs()` skips it; nothing downstream
/// should see these logs.
pub fn failed_block(logs: Vec<RawLog>) -> eth::Block {
    block_at(BLOCK, logs, 0)
}

pub fn block_at(number: u64, logs: Vec<RawLog>, status: i32) -> eth::Block {
    let logs: Vec<eth::Log> = logs
        .into_iter()
        .enumerate()
        .map(|(i, raw)| eth::Log {
            address: raw.address,
            topics: raw.topics,
            data: raw.data,
            index: i as u32,
            block_index: i as u32,
            // Firehose ordinals are block-global and monotonic; the exact spacing does
            // not matter, only the order.
            ordinal: 100 + i as u64,
        })
        .collect();

    eth::Block {
        number,
        hash: vec![0xB1; 32],
        header: Some(eth::BlockHeader {
            timestamp: Some(prost_types::Timestamp {
                seconds: TIMESTAMP as i64,
                nanos: 0,
            }),
            ..Default::default()
        }),
        transaction_traces: vec![eth::TransactionTrace {
            hash: TX_HASH.to_vec(),
            status,
            receipt: Some(eth::TransactionReceipt {
                logs,
                ..Default::default()
            }),
            ..Default::default()
        }],
        ..Default::default()
    }
}

// ---------------------------------------------------------------- log builders

pub fn market_created(
    settler: [u8; 20],
    market_id: u64,
    creator_byte: u8,
    n: u8,
    kappa: &str,
    resolution_time: u64,
) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("VestedParimutuel", "MarketCreated"),
            word_u64(market_id),
            word_address(creator_byte),
        ],
        data: ethabi::encode(&[
            Token::Uint(U256::from(n)),
            Token::Uint(uint256(kappa)),
            Token::Uint(U256::from(resolution_time)),
        ]),
    }
}

pub fn resolved(settler: [u8; 20], market_id: u64, winner: u8) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![topic0("VestedParimutuel", "Resolved"), word_u64(market_id)],
        data: ethabi::encode(&[Token::Uint(U256::from(winner))]),
    }
}

pub fn voided(settler: [u8; 20], market_id: u64) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![topic0("VestedParimutuel", "Voided"), word_u64(market_id)],
        data: Vec::new(),
    }
}

pub fn entered(
    settler: [u8; 20],
    market_id: u64,
    position_id: u64,
    owner_byte: u8,
    outcome: u8,
    offered: &str,
    vintage: u64,
) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("VestedParimutuel", "Entered"),
            word_u64(market_id),
            word_u64(position_id),
            word_address(owner_byte),
        ],
        data: ethabi::encode(&[
            Token::Uint(U256::from(outcome)),
            Token::Uint(uint256(offered)),
            Token::Uint(U256::from(vintage)),
        ]),
    }
}

/// The classic settler's Entered has no vintage, which is what gives it a different
/// topic0 and lets one package index both settlers.
pub fn entered_classic(
    settler: [u8; 20],
    market_id: u64,
    position_id: u64,
    owner_byte: u8,
    outcome: u8,
    offered: &str,
) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("ClassicParimutuel", "Entered"),
            word_u64(market_id),
            word_u64(position_id),
            word_address(owner_byte),
        ],
        data: ethabi::encode(&[
            Token::Uint(U256::from(outcome)),
            Token::Uint(uint256(offered)),
        ]),
    }
}

pub fn vintage_finalized(settler: [u8; 20], market_id: u64, vintage: u64, entries: u64) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("VestedParimutuel", "VintageFinalized"),
            word_u64(market_id),
            word_u64(vintage),
        ],
        data: ethabi::encode(&[Token::Uint(U256::from(entries))]),
    }
}

pub fn claimed(
    settler: [u8; 20],
    position_id: u64,
    to_byte: u8,
    payout: &str,
    refund: &str,
) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("VestedParimutuel", "Claimed"),
            word_u64(position_id),
            word_address(to_byte),
        ],
        data: ethabi::encode(&[Token::Uint(uint256(payout)), Token::Uint(uint256(refund))]),
    }
}

pub fn residue_claimed(settler: [u8; 20], market_id: u64, to_byte: u8, amount: &str) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("VestedParimutuel", "ResidueClaimed"),
            word_u64(market_id),
            word_address(to_byte),
        ],
        data: ethabi::encode(&[Token::Uint(uint256(amount))]),
    }
}

pub fn position_transferred(
    settler: [u8; 20],
    position_id: u64,
    from_byte: u8,
    to_byte: u8,
) -> RawLog {
    RawLog {
        address: settler.to_vec(),
        topics: vec![
            topic0("VestedParimutuel", "PositionTransferred"),
            word_u64(position_id),
            word_address(from_byte),
            word_address(to_byte),
        ],
        data: Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn market_opened(
    factory: [u8; 20],
    market_id: u64,
    settler: [u8; 20],
    spec_byte: u8,
    opener_byte: u8,
    seed: &[&str],
    kappa: &str,
    resolution_time: u64,
) -> RawLog {
    let mut settler_word = vec![0u8; 12];
    settler_word.extend_from_slice(&settler);
    RawLog {
        address: factory.to_vec(),
        topics: vec![
            topic0("MarketFactory", "MarketOpened"),
            word_u64(market_id),
            settler_word,
            vec![spec_byte; 32],
        ],
        data: ethabi::encode(&[
            Token::Address(address_of(opener_byte)),
            Token::Array(seed.iter().map(|s| Token::Uint(uint256(s))).collect()),
            Token::Uint(uint256(kappa)),
            Token::Uint(U256::from(resolution_time)),
        ]),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spec_registered(
    resolver: [u8; 20],
    spec_byte: u8,
    settler: [u8; 20],
    market_id: u64,
    oracle_byte: u8,
    feed_key_byte: u8,
    strike: &str,
    direction: u8,
    resolution_time: u64,
    max_staleness: u64,
) -> RawLog {
    let mut settler_word = vec![0u8; 12];
    settler_word.extend_from_slice(&settler);
    RawLog {
        address: resolver.to_vec(),
        topics: vec![
            topic0("FeedResolver", "SpecRegistered"),
            vec![spec_byte; 32],
            settler_word,
            word_u64(market_id),
        ],
        data: ethabi::encode(&[
            Token::Address(address_of(oracle_byte)),
            Token::FixedBytes(vec![feed_key_byte; 32]),
            Token::Int(int256(strike)),
            Token::Uint(U256::from(direction)),
            Token::Uint(U256::from(resolution_time)),
            Token::Uint(U256::from(max_staleness)),
        ]),
    }
}

pub fn feed_resolved(
    resolver: [u8; 20],
    spec_byte: u8,
    market_id: u64,
    winner: u8,
    price: &str,
    updated_at: u64,
) -> RawLog {
    RawLog {
        address: resolver.to_vec(),
        topics: vec![topic0("FeedResolver", "Resolved"), vec![spec_byte; 32]],
        data: ethabi::encode(&[
            Token::Uint(U256::from(market_id)),
            Token::Uint(U256::from(winner)),
            Token::Int(int256(price)),
            Token::Uint(U256::from(updated_at)),
        ]),
    }
}

pub fn voided_stale(resolver: [u8; 20], spec_byte: u8, age: u64) -> RawLog {
    RawLog {
        address: resolver.to_vec(),
        topics: vec![topic0("FeedResolver", "VoidedStale"), vec![spec_byte; 32]],
        data: ethabi::encode(&[Token::Uint(U256::from(age))]),
    }
}

// ---------------------------------------------------------------- encoding helpers

fn abi_json(contract: &str) -> &'static str {
    match contract {
        "VestedParimutuel" => include_str!("../abi/VestedParimutuel.json"),
        "ClassicParimutuel" => include_str!("../abi/ClassicParimutuel.json"),
        "FeedResolver" => include_str!("../abi/FeedResolver.json"),
        "MarketFactory" => include_str!("../abi/MarketFactory.json"),
        other => panic!("no ABI committed for {other}"),
    }
}

/// topic0 straight from the committed ABI, so the fixtures cannot drift from the
/// decoders that `build.rs` generates from the same file.
pub fn topic0(contract: &str, event: &str) -> Vec<u8> {
    let abi = Contract::load(abi_json(contract).as_bytes()).expect("ABI parses");
    let event = abi.event(event).expect("event is in the ABI");
    event.signature().as_bytes().to_vec()
}

fn word_u64(value: u64) -> Vec<u8> {
    let mut word = vec![0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn word_address(byte: u8) -> Vec<u8> {
    let mut word = vec![0u8; 12];
    word.extend_from_slice(&[byte; 20]);
    word
}

fn address_of(byte: u8) -> ethabi::Address {
    ethabi::Address::from([byte; 20])
}

fn uint256(decimal: &str) -> U256 {
    let value = NumBigInt::from_str_radix(decimal, 10).expect("decimal amount");
    assert!(value.sign() != Sign::Minus, "uint256 cannot be negative");
    let (_, bytes) = value.to_bytes_be();
    let mut word = [0u8; 32];
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    U256::from_big_endian(&word)
}

/// Two's complement in 32 bytes, which is how a negative int256 travels in log data.
fn int256(decimal: &str) -> U256 {
    let value = NumBigInt::from_str_radix(decimal, 10).expect("decimal amount");
    let two_pow_256 = NumBigInt::from(1u8) << 256;
    let wrapped: NumBigInt = ((value % &two_pow_256) + &two_pow_256) % &two_pow_256;
    let (_, bytes) = wrapped.to_bytes_be();
    let mut word = [0u8; 32];
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    U256::from_big_endian(&word)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_settlers_entered_signatures_differ() {
        // This is the property the whole two-settler design rests on: the vested
        // Entered carries a vintage, the classic one does not, so one package can index
        // both without the logs colliding.
        assert_ne!(
            topic0("VestedParimutuel", "Entered"),
            topic0("ClassicParimutuel", "Entered")
        );
        // Their shared events do collide, which is why the rule comes from the address.
        assert_eq!(
            topic0("VestedParimutuel", "Resolved"),
            topic0("ClassicParimutuel", "Resolved")
        );
    }

    #[test]
    fn negative_int256_encodes_as_twos_complement() {
        assert_eq!(int256("-1"), U256::max_value());
        assert_eq!(int256("0"), U256::zero());
        assert_eq!(int256("125"), U256::from(125u64));
    }

    #[test]
    fn uint256_handles_values_past_u64() {
        let big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        assert_eq!(uint256(big), U256::max_value());
    }
}
