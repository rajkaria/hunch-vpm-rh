// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title Chainlink Data Feeds behind IPriceOracle
/// @notice `feedKey` is the aggregator's address, left-padded into the word. Arc joined
///         Chainlink Scale but has not published Data Feed addresses yet, so this adapter
///         ships written and tested and is wired the day an address exists.
/// @dev    Feed decimals are read per call and normalised to 8. USD feeds are already 8,
///         in which case the conversion is a no-op.
contract ChainlinkFeedOracle is IPriceOracle {
    error StaleRound();
    error NegativeAnswer();
    error BadFeed();

    /// @inheritdoc IPriceOracle
    function read(bytes32 feedKey) external view returns (int256 price8, uint256 updatedAt) {
        address feed = address(uint160(uint256(feedKey)));
        if (feed == address(0)) revert BadFeed();

        (, int256 answer,, uint256 at,) = AggregatorV3Interface(feed).latestRoundData();
        if (at == 0) revert StaleRound();
        if (answer <= 0) revert NegativeAnswer();

        uint8 d = AggregatorV3Interface(feed).decimals();
        price8 = _to8(answer, d);
        updatedAt = at;
    }

    function _to8(int256 answer, uint8 decimals_) internal pure returns (int256) {
        if (decimals_ == 8) return answer;
        if (decimals_ < 8) return answer * int256(10 ** uint256(8 - decimals_));
        return answer / int256(10 ** uint256(decimals_ - 8));
    }
}
