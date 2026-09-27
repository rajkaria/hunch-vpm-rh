// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  MockStockToken: the part of a Robinhood Stock Token the resolver reads
/// @notice `oraclePaused()` is Robinhood's corporate-action flag; tests flip it, and can make
///         it unreadable (revert) to check that an unreadable flag counts as paused.
contract MockStockToken {
    string public symbol;
    bool public paused;
    bool public unreadable;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }

    function setOraclePaused(bool paused_) external {
        paused = paused_;
    }

    function setUnreadable(bool unreadable_) external {
        unreadable = unreadable_;
    }

    function oraclePaused() external view returns (bool) {
        require(!unreadable, "unreadable");
        return paused;
    }
}
