// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IParimutuelSettler} from "./interfaces/IParimutuelSettler.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title The market's resolver, so that no human resolves anything
/// @notice Today every Hunch market is settled by the operator. Here the settler's
///         `resolver` is this contract, and this contract only reads a price feed. Anyone
///         may call `resolve` once the market has frozen; the caller has no say in the
///         answer and gets nothing for making the call. If the feed has gone quiet past the
///         market's staleness bound the market voids and refunds instead of settling on a
///         number nobody should trust.
/// @dev    The spec is hashed into its own id so it is immutable once registered: the
///         strike, the direction, the feed and the staleness bound a market resolves
///         against cannot be edited after stake is down.
contract FeedResolver {
    // ------------------------------------------------------------------ types

    /// @param settler        the settler holding the market
    /// @param marketId       its market id
    /// @param oracle         the IPriceOracle adapter to read
    /// @param feedKey        adapter-defined: a feed address for Chainlink, an id for Stork
    /// @param strike         the threshold, at 8 decimals to match IPriceOracle
    /// @param direction      0 = above: outcome 0 wins at or above the strike. 1 = below
    /// @param resolutionTime mirrors the settler's freeze; resolve is refused before it
    /// @param maxStaleness   seconds; a reading older than this voids instead of resolving
    struct Spec {
        address settler;
        uint256 marketId;
        address oracle;
        bytes32 feedKey;
        int256 strike;
        uint8 direction;
        uint64 resolutionTime;
        uint64 maxStaleness;
    }

    uint8 internal constant DIRECTION_ABOVE = 0;
    uint8 internal constant DIRECTION_BELOW = 1;

    // ------------------------------------------------------------------ state

    mapping(bytes32 => Spec) public specs;
    mapping(bytes32 => bool) public settled;

    // ------------------------------------------------------------------ events

    event SpecRegistered(
        bytes32 indexed specId,
        address indexed settler,
        uint256 indexed marketId,
        address oracle,
        bytes32 feedKey,
        int256 strike,
        uint8 direction,
        uint64 resolutionTime,
        uint64 maxStaleness
    );
    event Resolved(bytes32 indexed specId, uint256 marketId, uint8 winner, int256 price, uint256 updatedAt);
    event VoidedStale(bytes32 indexed specId, uint256 age);

    // ------------------------------------------------------------------ errors

    error AlreadyRegistered();
    error UnknownSpec();
    error AlreadySettled();
    error TooEarly();
    error BadDirection();
    error BadSettler();
    error BadOracle();
    error NotStale();

    // ------------------------------------------------------------------ registration

    /// @notice Record how a market resolves. Permissionless: registering a spec grants no
    ///         power over a market that has not named this contract as its resolver.
    /// @dev    `specId` is the hash of the whole spec, so the same market can carry more
    ///         than one candidate spec but none of them can be mutated after the fact.
    function register(Spec calldata s) external returns (bytes32 specId) {
        if (s.settler == address(0)) revert BadSettler();
        if (s.oracle == address(0)) revert BadOracle();
        if (s.direction > DIRECTION_BELOW) revert BadDirection();

        specId = specIdOf(s);
        if (specs[specId].settler != address(0)) revert AlreadyRegistered();
        specs[specId] = s;

        emit SpecRegistered(
            specId, s.settler, s.marketId, s.oracle, s.feedKey, s.strike, s.direction, s.resolutionTime, s.maxStaleness
        );
    }

    function specIdOf(Spec calldata s) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                s.settler, s.marketId, s.oracle, s.feedKey, s.strike, s.direction, s.resolutionTime, s.maxStaleness
            )
        );
    }

    // ------------------------------------------------------------------ resolution

    /// @notice Read the feed and settle the market. Anyone, at or after the freeze.
    /// @dev    Reverts rather than voids when the reading is stale, so a keeper retrying
    ///         through a brief outage does not accidentally void a good market. Voiding is
    ///         a deliberate, separate call.
    function resolve(bytes32 specId) external {
        Spec memory s = _live(specId);
        if (block.timestamp < s.resolutionTime) revert TooEarly();

        (int256 price8, uint256 updatedAt) = IPriceOracle(s.oracle).read(s.feedKey);
        if (_age(updatedAt) > s.maxStaleness) revert NotStale();

        uint8 winner = winnerFor(price8, s.strike, s.direction);
        settled[specId] = true;

        emit Resolved(specId, s.marketId, winner, price8, updatedAt);
        IParimutuelSettler(s.settler).resolve(s.marketId, winner);
    }

    /// @notice Void the market because the feed has gone quiet past its staleness bound.
    ///         Anyone, at or after the freeze. Positions refund at accepted principal.
    function voidStale(bytes32 specId) external {
        Spec memory s = _live(specId);
        if (block.timestamp < s.resolutionTime) revert TooEarly();

        (, uint256 updatedAt) = IPriceOracle(s.oracle).read(s.feedKey);
        uint256 age = _age(updatedAt);
        if (age <= s.maxStaleness) revert NotStale();

        settled[specId] = true;

        emit VoidedStale(specId, age);
        IParimutuelSettler(s.settler).voidMarket(s.marketId);
    }

    // ------------------------------------------------------------------ views

    /// @notice Which outcome a price implies, as a pure function anyone can check.
    /// @dev    `above` is inclusive of the strike: at exactly the strike, "above" wins.
    ///         That has to be stated somewhere and the UI states it too.
    function winnerFor(int256 price8, int256 strike, uint8 direction) public pure returns (uint8) {
        bool above = price8 >= strike;
        if (direction == DIRECTION_ABOVE) return above ? 0 : 1;
        return above ? 1 : 0;
    }

    /// @notice What `resolve` would do right now, without sending a transaction.
    /// @return ready whether the market can be resolved this second
    /// @return winner the outcome it would settle to
    /// @return price8 the reading behind that answer
    /// @return age how old that reading is, in seconds
    function preview(bytes32 specId) external view returns (bool ready, uint8 winner, int256 price8, uint256 age) {
        Spec memory s = specs[specId];
        if (s.settler == address(0) || settled[specId]) return (false, 0, 0, 0);

        uint256 updatedAt;
        (price8, updatedAt) = IPriceOracle(s.oracle).read(s.feedKey);
        age = _age(updatedAt);
        winner = winnerFor(price8, s.strike, s.direction);
        ready = block.timestamp >= s.resolutionTime && age <= s.maxStaleness;
    }

    // ------------------------------------------------------------------ internals

    function _live(bytes32 specId) internal view returns (Spec memory s) {
        s = specs[specId];
        if (s.settler == address(0)) revert UnknownSpec();
        if (settled[specId]) revert AlreadySettled();
    }

    /// @dev A reading stamped in the future is treated as fresh rather than underflowing.
    function _age(uint256 updatedAt) internal view returns (uint256) {
        return updatedAt >= block.timestamp ? 0 : block.timestamp - updatedAt;
    }
}
