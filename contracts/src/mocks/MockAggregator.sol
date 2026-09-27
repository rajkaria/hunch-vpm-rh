// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  MockAggregator: a Chainlink AggregatorV3 PROXY double with phases
/// @notice Round ids are proxy ids, `(phaseId << 64) | aggregatorRoundId`, exactly as on the
///         Robinhood Chain equity feeds (phase 1 starts at 18446744073709551617). Tests can:
///           * append rounds to the current phase at chosen timestamps and answers;
///           * start a new phase (a new aggregator behind the proxy), whose rounds restart at 1;
///           * overwrite any round with garbage, or delete one (a hole);
///           * choose how a missing round reads: revert "No data present" (OCR1 and the proxy's
///             own behaviour for an unknown phase) or return zeros (OCR2).
contract MockAggregator {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public decimals = 8;
    string public description;
    // forge-lint: disable-next-line(screaming-snake-case-const)
    uint256 public constant version = 6; // AggregatorV3Interface.version()
    uint16 public phaseId = 1;
    bool public zeroForMissing;

    mapping(uint80 => Round) internal rounds;
    /// @notice Number of aggregator rounds written in each phase.
    mapping(uint16 => uint64) public phaseRounds;

    constructor(string memory description_) {
        description = description_;
    }

    // ------------------------------------------------------------------ test controls

    function roundId(uint16 phase, uint64 aggregatorRound) public pure returns (uint80) {
        return (uint80(phase) << 64) | uint80(aggregatorRound);
    }

    /// @notice Append the next round of the current phase.
    function addRound(int256 answer, uint256 updatedAt) external returns (uint80 id) {
        uint64 next = phaseRounds[phaseId] + 1;
        phaseRounds[phaseId] = next;
        id = roundId(phaseId, next);
        rounds[id] = Round({answer: answer, updatedAt: updatedAt});
    }

    /// @notice A new aggregator behind the proxy: later rounds go to phase + 1, from round 1.
    function startPhase() external returns (uint16) {
        return ++phaseId;
    }

    /// @notice Overwrite (or create) any round, e.g. with a garbage answer.
    function setRound(uint80 id, int256 answer, uint256 updatedAt) external {
        rounds[id] = Round({answer: answer, updatedAt: updatedAt});
    }

    /// @notice Remove a round, leaving a hole.
    function deleteRound(uint80 id) external {
        delete rounds[id];
    }

    function setZeroForMissing(bool zero) external {
        zeroForMissing = zero;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    // ------------------------------------------------------------------ AggregatorV3Interface

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[id];
        if (r.updatedAt == 0) {
            require(zeroForMissing, "No data present");
            return (id, 0, 0, 0, id);
        }
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint64 n = phaseRounds[phaseId];
        require(n > 0, "No data present");
        return getRoundData(roundId(phaseId, n));
    }

    function latestRound() external view returns (uint256) {
        return roundId(phaseId, phaseRounds[phaseId]);
    }
}
