// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./VestedParimutuel.sol";
import {IParimutuelSettler} from "./interfaces/IParimutuelSettler.sol";
import {FeedResolver} from "./FeedResolver.sol";

/// @dev The settler's vendored `IERC20` is deliberately minimal — transfer and transferFrom
///      only. The factory additionally has to approve the settler and sweep its own balance,
///      so it reads the token through this wider view of the same address.
interface IERC20Spend {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Open a market and pin down how it resolves, in one transaction
/// @notice A market whose resolution spec is registered in a later transaction has a window
///         in which stake can land against rules nobody has committed to yet. This contract
///         closes that window: the settler's market and the resolver's spec are created
///         together or not at all, and `MarketOpened` carries both ids so an indexer never
///         sees one without the other.
/// @dev    The factory is the settler's `msg.sender` during `create`, so it necessarily
///         owns the seed legs for the length of the call. It hands every one of them to the
///         opener before returning and refunds any part of the seed the settler refused, so
///         it holds no position and no balance afterwards — asserted in the tests.
contract MarketFactory {
    event MarketOpened(
        uint256 indexed marketId,
        address indexed settler,
        bytes32 indexed specId,
        address opener,
        uint256[] seed,
        uint256 kappa,
        uint64 resolutionTime
    );

    error BadSettler();
    error BadResolver();
    error TransferFailed();
    error ApprovalFailed();

    FeedResolver public immutable resolver;

    constructor(FeedResolver resolver_) {
        if (address(resolver_) == address(0)) revert BadResolver();
        resolver = resolver_;
    }

    /// @notice The market's own terms.
    /// @param settler        which settlement rule this market runs under
    /// @param token          the stake asset, pulled from the caller
    /// @param seed           offered amount per outcome
    /// @param kappa          capacity coefficient, ignored by settlers that do not ration
    /// @param resolutionTime the freeze, shared by the market and its spec
    /// @param voidTimeout    seconds after the freeze from which anyone may void
    /// @param residueOwner   who may sweep the residue
    struct Terms {
        IParimutuelSettler settler;
        IERC20 token;
        uint256[] seed;
        uint256 kappa;
        uint64 resolutionTime;
        uint64 voidTimeout;
        address residueOwner;
    }

    /// @notice How the market resolves.
    /// @param oracle       the IPriceOracle adapter the spec reads
    /// @param feedKey      adapter-defined feed identifier
    /// @param strike       threshold at 8 decimals
    /// @param direction    0 = above, 1 = below
    /// @param maxStaleness seconds beyond which the market voids instead of resolving
    struct Feed {
        address oracle;
        bytes32 feedKey;
        int256 strike;
        uint8 direction;
        uint64 maxStaleness;
    }

    /// @notice Open a market and register the spec it resolves against, atomically.
    function open(Terms calldata terms, Feed calldata feed) external returns (uint256 marketId, bytes32 specId) {
        if (address(terms.settler) == address(0)) revert BadSettler();

        uint256 offered;
        for (uint256 i = 0; i < terms.seed.length; i++) {
            offered += terms.seed[i];
        }

        // Take the whole offer, let the settler keep what it accepts, return the rest.
        if (!terms.token.transferFrom(msg.sender, address(this), offered)) revert TransferFailed();
        if (!IERC20Spend(address(terms.token)).approve(address(terms.settler), offered)) revert ApprovalFailed();

        uint256 firstSeedPosition = terms.settler.positionCount();
        marketId = terms.settler
            .create(
                terms.token,
                terms.seed,
                terms.kappa,
                terms.resolutionTime,
                terms.voidTimeout,
                address(resolver),
                terms.residueOwner
            );

        specId = resolver.register(
            FeedResolver.Spec({
                settler: address(terms.settler),
                marketId: marketId,
                oracle: feed.oracle,
                feedKey: feed.feedKey,
                strike: feed.strike,
                direction: feed.direction,
                resolutionTime: terms.resolutionTime,
                maxStaleness: feed.maxStaleness
            })
        );

        _handOver(terms, firstSeedPosition);

        emit MarketOpened(
            marketId, address(terms.settler), specId, msg.sender, terms.seed, terms.kappa, terms.resolutionTime
        );
    }

    /// @dev Give the opener the seed legs, drop the allowance, return whatever the settler
    ///      refused. Split out of `open` so neither function runs out of stack slots.
    function _handOver(Terms calldata terms, uint256 firstSeedPosition) internal {
        uint256 lastSeedPosition = terms.settler.positionCount();
        for (uint256 id = firstSeedPosition; id < lastSeedPosition; id++) {
            terms.settler.transferPosition(id, msg.sender);
        }

        if (!IERC20Spend(address(terms.token)).approve(address(terms.settler), 0)) revert ApprovalFailed();
        uint256 unused = IERC20Spend(address(terms.token)).balanceOf(address(this));
        if (unused != 0 && !terms.token.transfer(msg.sender, unused)) revert TransferFailed();
    }
}
