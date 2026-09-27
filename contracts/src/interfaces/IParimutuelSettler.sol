// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "../VestedParimutuel.sol";

/// @title The settlement surface a venue can swap by configuration
/// @notice Both settlers behind this interface hold escrow, accept stake into per-outcome
///         books, freeze at a resolution timestamp, settle to one winner and pay by pull.
///         They differ only in what a unit of stake is worth: `VestedParimutuel` vests it
///         into the opposing books on arrival and accepts it only up to the capacity those
///         books have to cover it, while `ClassicParimutuel` pays every unit the same
///         multiple regardless of when it landed.
/// @dev    The vendored `VestedParimutuel` predates this interface and does not declare it.
///         Every signature below is copied from that contract so `IParimutuelSettler(vpm)`
///         is a valid cast; `ParimutuelInterfaceTest` is the guard that keeps it true.
///         Enum returns are `uint8` here because the concrete `Status` type lives inside
///         each settler — ABI-identical, since selectors do not depend on return types.
interface IParimutuelSettler {
    /// @dev Mirrors both settlers' `Status`: 0 Open, 1 Resolved, 2 Voided.
    enum Status {
        Open,
        Resolved,
        Voided
    }

    /// @notice Open a market by posting a seed on every outcome.
    /// @param  token          transfer-exact settlement asset
    /// @param  seed           amount offered per outcome; length n = |O| >= 2
    /// @param  kappa          capacity coefficient; ignored by settlers that do not ration
    /// @param  resolutionTime the freeze — entries at or after it are refused
    /// @param  voidTimeout    seconds after the freeze from which anyone may void
    /// @param  resolver       the only address that may resolve
    /// @param  residueOwner   the residue's named owner, fixed at creation
    function create(
        IERC20 token,
        uint256[] calldata seed,
        uint256 kappa,
        uint64 resolutionTime,
        uint64 voidTimeout,
        address resolver,
        address residueOwner
    ) external returns (uint256 marketId);

    /// @notice Offer `amount` on `outcome`. How much is accepted is settler-defined.
    function enter(uint256 marketId, uint8 outcome, uint256 amount) external returns (uint256 positionId);

    /// @notice Declare the realized outcome. Resolver only, at or after the freeze.
    function resolve(uint256 marketId, uint8 winner) external;

    /// @notice Refund every position at its accepted principal.
    function voidMarket(uint256 marketId) external;

    /// @notice Pay a finalized position: settlement plus any outstanding refused remainder.
    function claim(uint256 positionId) external;

    /// @notice Withdraw the refused remainder of a partial fill on its own.
    function withdrawRefund(uint256 positionId) external;

    /// @notice Hand a position to another address, settlement rights and all.
    function transferPosition(uint256 positionId, address to) external;

    /// @notice Room a book still has to accept stake against it.
    function headroom(uint256 marketId, uint8 outcome) external view returns (uint256);

    /// @notice What `claim` would pay this position right now, payout only.
    function previewPayout(uint256 positionId) external view returns (uint256);

    function marketCount() external view returns (uint256);
    function positionCount() external view returns (uint256);

    function getMarket(uint256 marketId)
        external
        view
        returns (
            IERC20 token,
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
}
