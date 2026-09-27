// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title One method between the resolver and whichever oracle Arc ends up having
/// @notice Arc documents Chainlink, Chronicle, Pyth, RedStone and Stork as available, and
///         at the time of writing only Stork publishes an Arc address. Rather than bet on
///         one, `FeedResolver` reads through this adapter: a price normalised to 8 decimals
///         and the timestamp it was written. Swapping providers is a constructor argument,
///         not a code change.
/// @dev    8 decimals because that is what Chainlink's USD feeds use, so the most likely
///         eventual provider needs no conversion at all.
interface IPriceOracle {
    /// @param feedKey provider-defined: a feed address for Chainlink, a price id for Stork
    /// @return price8 the price, scaled to 8 decimals
    /// @return updatedAt unix seconds at which the provider last wrote it
    function read(bytes32 feedKey) external view returns (int256 price8, uint256 updatedAt);
}
