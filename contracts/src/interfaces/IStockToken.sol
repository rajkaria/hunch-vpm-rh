// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  The part of a Robinhood Stock Token that the resolver reads
/// @notice Every Stock Token on Robinhood Chain (Beacon-proxied `Stock` implementation)
///         exposes `oraclePaused()`, Robinhood's corporate-action flag: while it is true the
///         token's price is "temporarily unavailable" and must not be used to settle.
interface IStockToken {
    function oraclePaused() external view returns (bool);

    function symbol() external view returns (string memory);
}
