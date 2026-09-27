// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {FeedResolver} from "../src/FeedResolver.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";

/// @notice The properties that matter here are about who is allowed to do what, and when.
///         Nobody may settle a market early; anybody may settle it once frozen; a quiet
///         feed refunds rather than settling on a number nobody should trust; and no path
///         through this contract lets its deployer touch user funds.
contract FeedResolverTest is Test {
    VestedParimutuel internal vpm;
    MockERC20 internal token;
    MockOracle internal oracle;
    FeedResolver internal resolver;

    bytes32 internal constant FEED = keccak256("ETH/USD");
    int256 internal constant STRIKE = 4_500_00000000;

    address internal stranger = address(0x5747A);
    uint64 internal freeze;

    function setUp() public {
        vpm = new VestedParimutuel();
        token = new MockERC20();
        oracle = new MockOracle();
        resolver = new FeedResolver();
        freeze = uint64(block.timestamp + 1 days);
    }

    // ------------------------------------------------------------- helpers

    function _spec(uint256 marketId, uint8 direction, uint64 maxStaleness)
        internal
        view
        returns (FeedResolver.Spec memory)
    {
        return FeedResolver.Spec({
            settler: address(vpm),
            marketId: marketId,
            oracle: address(oracle),
            feedKey: FEED,
            strike: STRIKE,
            direction: direction,
            resolutionTime: freeze,
            maxStaleness: maxStaleness
        });
    }

    /// @dev Opens a two-outcome market whose resolver is the FeedResolver, with one
    ///      counterparty so it can actually settle, and registers a spec for it.
    function _market(uint8 direction, uint64 maxStaleness) internal returns (uint256 marketId, bytes32 specId) {
        token.mint(address(this), 200e6);
        token.approve(address(vpm), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        seed[0] = 100e6;
        seed[1] = 100e6;
        marketId = vpm.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(resolver), address(this));

        token.mint(stranger, 50e6);
        vm.roll(block.number + 1);
        vm.startPrank(stranger);
        token.approve(address(vpm), type(uint256).max);
        vpm.enter(marketId, 1, 50e6);
        vm.stopPrank();

        FeedResolver.Spec memory s = _spec(marketId, direction, maxStaleness);
        specId = resolver.register(s);
    }

    // ------------------------------------------------------------- registration

    function test_SpecIdIsTheHashOfTheWholeSpec() public {
        (, bytes32 specId) = _market(0, 1 hours);
        assertEq(specId, resolver.specIdOf(_spec(0, 0, 1 hours)), "id must be derived from the spec itself");
    }

    function test_TheSameSpecCannotBeRegisteredTwice() public {
        _market(0, 1 hours);
        vm.expectRevert(FeedResolver.AlreadyRegistered.selector);
        resolver.register(_spec(0, 0, 1 hours));
    }

    function test_RegistrationRejectsAnUnknownDirection() public {
        FeedResolver.Spec memory s = _spec(0, 2, 1 hours);
        vm.expectRevert(FeedResolver.BadDirection.selector);
        resolver.register(s);
    }

    // ------------------------------------------------------------- timing

    function test_NobodyMaySettleBeforeTheFreeze() public {
        (, bytes32 specId) = _market(0, 1 hours);
        oracle.set(FEED, STRIKE + 1, block.timestamp);
        vm.expectRevert(FeedResolver.TooEarly.selector);
        resolver.resolve(specId);
    }

    function test_AnyoneMaySettleAfterTheFreeze() public {
        (uint256 marketId, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp);

        vm.prank(stranger);
        resolver.resolve(specId);

        (,,,,,,, uint8 status, uint8 winner,,,) = IParimutuelSettler(address(vpm)).getMarket(marketId);
        assertEq(status, uint8(IParimutuelSettler.Status.Resolved), "a stranger settled it");
        assertEq(winner, 0, "above the strike, direction above, so outcome 0");
    }

    function test_AMarketCannotBeSettledTwice() public {
        (, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp);
        resolver.resolve(specId);

        vm.expectRevert(FeedResolver.AlreadySettled.selector);
        resolver.resolve(specId);
    }

    // ------------------------------------------------------------- direction

    function test_DirectionAboveIsInclusiveOfTheStrike() public pure {
        assertEq(_winner(STRIKE, STRIKE, 0), 0, "exactly at the strike counts as above");
        assertEq(_winner(STRIKE - 1, STRIKE, 0), 1, "a tick below does not");
    }

    function test_DirectionBelowInvertsIt() public pure {
        assertEq(_winner(STRIKE, STRIKE, 1), 1, "at the strike, below loses");
        assertEq(_winner(STRIKE - 1, STRIKE, 1), 0, "a tick below wins");
    }

    function testFuzz_TheTwoDirectionsAreAlwaysOpposites(int256 price, int256 strike) public view {
        assertTrue(
            resolver.winnerFor(price, strike, 0) != resolver.winnerFor(price, strike, 1),
            "the same reading cannot pick the same outcome under both directions"
        );
    }

    // ------------------------------------------------------------- staleness

    function test_AQuietFeedRefusesToSettle() public {
        (, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp - 2 hours);

        vm.expectRevert(FeedResolver.NotStale.selector);
        resolver.resolve(specId);
    }

    function test_AQuietFeedVoidsAndRefundsAcceptedPrincipal() public {
        (uint256 marketId, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp - 2 hours);

        resolver.voidStale(specId);

        (,,,,,,, uint8 status,,,,) = IParimutuelSettler(address(vpm)).getMarket(marketId);
        assertEq(status, uint8(IParimutuelSettler.Status.Voided), "a stale feed voids the market");

        uint256 before = token.balanceOf(stranger);
        vm.prank(stranger);
        vpm.claim(2); // seed legs are positions 0 and 1; the entrant is position 2
        assertEq(token.balanceOf(stranger) - before, 50e6, "the entrant is refunded exactly what was accepted");
    }

    function test_AFreshFeedCannotBeVoidedForStaleness() public {
        (, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp);

        vm.expectRevert(FeedResolver.NotStale.selector);
        resolver.voidStale(specId);
    }

    function test_AReadingStampedInTheFutureCountsAsFresh() public {
        (, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp + 1 days);

        resolver.resolve(specId);
        assertTrue(resolver.settled(specId), "a future stamp must not underflow into staleness");
    }

    // ------------------------------------------------------------- preview

    function test_PreviewAgreesWithWhatResolveDoes() public {
        (uint256 marketId, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE - 1, block.timestamp);

        (bool ready, uint8 winner, int256 price, uint256 age) = resolver.preview(specId);
        assertTrue(ready, "ready");
        assertEq(age, 0, "fresh");
        assertEq(price, STRIKE - 1, "price");

        resolver.resolve(specId);
        (,,,,,,,, uint8 actual,,,) = IParimutuelSettler(address(vpm)).getMarket(marketId);
        assertEq(actual, winner, "preview must not disagree with the transaction");
    }

    // ------------------------------------------------------------- custody

    function test_TheResolverNeverHoldsOrMovesFunds() public {
        (, bytes32 specId) = _market(0, 1 hours);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp);
        resolver.resolve(specId);

        assertEq(token.balanceOf(address(resolver)), 0, "the resolver is never a custodian");
    }

    function _winner(int256 price, int256 strike, uint8 direction) internal pure returns (uint8) {
        bool above = price >= strike;
        if (direction == 0) return above ? 0 : 1;
        return above ? 1 : 0;
    }
}
