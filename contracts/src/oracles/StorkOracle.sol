// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

interface IStork {
    struct TemporalNumericValue {
        uint64 timestampNs;
        int192 quantizedValue;
    }

    function getTemporalNumericValueV1(bytes32 id) external view returns (TemporalNumericValue memory value);
}

/// @title Stork behind IPriceOracle — the one provider with a published Arc address
/// @notice Arc testnet: `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62`. `feedKey` is Stork's
///         encoded asset id. Values are quantised at 18 decimals and timestamped in
///         nanoseconds, both of which this adapter normalises.
contract StorkOracle is IPriceOracle {
    error NoValue();
    error NegativeAnswer();

    IStork public immutable stork;

    constructor(IStork stork_) {
        stork = stork_;
    }

    /// @inheritdoc IPriceOracle
    function read(bytes32 feedKey) external view returns (int256 price8, uint256 updatedAt) {
        IStork.TemporalNumericValue memory v = stork.getTemporalNumericValueV1(feedKey);
        if (v.timestampNs == 0) revert NoValue();
        if (v.quantizedValue <= 0) revert NegativeAnswer();

        // 18 decimals down to 8, nanoseconds down to seconds.
        price8 = int256(v.quantizedValue) / int256(10 ** 10);
        updatedAt = uint256(v.timestampNs) / 1e9;
    }
}
