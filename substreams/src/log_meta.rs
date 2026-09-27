//! Provenance for every row: which block, which transaction, which log.

use substreams_ethereum::block_view::LogView;
use substreams_ethereum::pb::eth::v2 as eth;

use crate::pb::hunch_vpm_v1::Meta;

pub fn meta_of(block: &eth::Block, log: &LogView<'_>) -> Meta {
    Meta {
        block_number: block.number,
        timestamp: block.timestamp_seconds(),
        tx_hash: format!("0x{}", hex::encode(&log.receipt.transaction.hash)),
        // block_index, not index: index is relative to the transaction, so two logs in
        // one block could share it and the ids built from it would collide.
        log_index: log.log.block_index as u64,
        ordinal: log.log.ordinal,
    }
}
