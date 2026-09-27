// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice A settable oracle for tests and for seeding demo markets on a local chain.
///         Never deployed to a network that settles real stake.
contract MockOracle is IPriceOracle {
    mapping(bytes32 => int256) internal price;
    mapping(bytes32 => uint256) internal at;

    function set(bytes32 feedKey, int256 price8, uint256 updatedAt) external {
        price[feedKey] = price8;
        at[feedKey] = updatedAt;
    }

    /// @inheritdoc IPriceOracle
    function read(bytes32 feedKey) external view returns (int256, uint256) {
        return (price[feedKey], at[feedKey]);
    }
}
