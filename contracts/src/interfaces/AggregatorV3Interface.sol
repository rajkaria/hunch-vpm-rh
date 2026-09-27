// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  Chainlink AggregatorV3Interface (declared locally, no dependency)
/// @notice The read surface of a Chainlink price-feed proxy. Round ids are proxy ids:
///         `(phaseId << 64) | aggregatorRoundId`. A round the proxy does not hold either
///         reverts ("No data present") or returns `updatedAt == 0`, depending on the
///         aggregator generation; callers must treat both as "absent".
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
