// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  The settler surface the StockRoundResolver drives
/// @notice A subset of HunchVPM (and of the reference VestedParimutuel, whose `getMarket`
///         HunchVPM keeps unchanged). `status` is returned as `uint8` (0 Open, 1 Resolved,
///         2 Voided), which is ABI-identical to the settler's enum.
interface IHunchSettler {
    function getMarket(uint256 marketId)
        external
        view
        returns (
            address token,
            address creator,
            address resolver,
            address residueOwner,
            uint64 resolutionTime,
            uint64 voidTimeout,
            uint8 n,
            uint8 status,
            uint8 winner,
            uint256 kappa,
            uint256 acceptedPool,
            uint256 paidOut
        );

    /// @notice Declare the winner. The settler accepts it only from the market's resolver,
    ///         only at or after the market's freeze.
    function resolve(uint256 marketId, uint8 winner) external;

    /// @notice Void the market (every position refunds its accepted principal). The settler
    ///         accepts it from the market's resolver at or after the freeze, or from anyone
    ///         after the market's void timeout.
    function voidMarket(uint256 marketId) external;
}
