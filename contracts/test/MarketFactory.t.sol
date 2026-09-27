// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {ClassicParimutuel} from "../src/ClassicParimutuel.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {FeedResolver} from "../src/FeedResolver.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";

/// @notice The factory exists to close a window, so the tests are mostly about what it
///         must NOT keep: no position, no balance, no allowance, no privileged key. The
///         atomicity claim is checked by asserting the spec is readable in the same
///         transaction that opened the market.
contract MarketFactoryTest is Test {
    VestedParimutuel internal vpm;
    ClassicParimutuel internal classic;
    MockERC20 internal token;
    MockOracle internal oracle;
    FeedResolver internal resolver;
    MarketFactory internal factory;

    bytes32 internal constant FEED = keccak256("ETH/USD");
    int256 internal constant STRIKE = 4_500_00000000;

    address internal opener = address(0x09E4);
    address internal counterparty = address(0xC0);
    uint64 internal freeze;

    function setUp() public {
        vpm = new VestedParimutuel();
        classic = new ClassicParimutuel();
        token = new MockERC20();
        oracle = new MockOracle();
        resolver = new FeedResolver();
        factory = new MarketFactory(resolver);
        freeze = uint64(block.timestamp + 1 days);
    }

    function _terms(IParimutuelSettler settler, uint256 a, uint256 b)
        internal
        view
        returns (MarketFactory.Terms memory)
    {
        uint256[] memory seed = new uint256[](2);
        seed[0] = a;
        seed[1] = b;
        return MarketFactory.Terms({
            settler: settler,
            token: IERC20(address(token)),
            seed: seed,
            kappa: 30,
            resolutionTime: freeze,
            voidTimeout: 7 days,
            residueOwner: opener
        });
    }

    function _feed() internal pure returns (MarketFactory.Feed memory) {
        return
            MarketFactory.Feed({oracle: address(0), feedKey: FEED, strike: STRIKE, direction: 0, maxStaleness: 1 hours});
    }

    function _open(IParimutuelSettler settler, uint256 a, uint256 b) internal returns (uint256, bytes32) {
        token.mint(opener, a + b);
        MarketFactory.Feed memory feed = _feed();
        feed.oracle = address(oracle);
        vm.startPrank(opener);
        token.approve(address(factory), type(uint256).max);
        (uint256 marketId, bytes32 specId) = factory.open(_terms(settler, a, b), feed);
        vm.stopPrank();
        return (marketId, specId);
    }

    // ------------------------------------------------------------- atomicity

    function test_TheMarketAndItsSpecExistTogether() public {
        (uint256 marketId, bytes32 specId) = _open(IParimutuelSettler(address(vpm)), 100e6, 100e6);

        (address settler, uint256 specMarketId,,, int256 strike, uint8 direction, uint64 resolutionTime,) =
            resolver.specs(specId);

        assertEq(settler, address(vpm), "spec points at the settler");
        assertEq(specMarketId, marketId, "spec points at the market");
        assertEq(strike, STRIKE, "strike");
        assertEq(direction, 0, "direction");
        assertEq(resolutionTime, freeze, "the spec and the market share one freeze");

        (,, address marketResolver,,,,,,,,,) = IParimutuelSettler(address(vpm)).getMarket(marketId);
        assertEq(marketResolver, address(resolver), "the market resolves through the feed, not a person");
    }

    function test_ItWorksForEitherSettler() public {
        (uint256 marketId,) = _open(IParimutuelSettler(address(classic)), 100e6, 100e6);
        (,, address marketResolver,,,,,,,,,) = IParimutuelSettler(address(classic)).getMarket(marketId);
        assertEq(marketResolver, address(resolver), "the classic pool resolves the same way");
    }

    // ------------------------------------------------------------- custody

    function test_TheOpenerKeepsTheSeedLegs() public {
        _open(IParimutuelSettler(address(vpm)), 100e6, 100e6);

        // Positions 0 and 1 are the seed legs. Only their owner can claim them, so a
        // successful claim by the opener after settlement is the ownership proof.
        _settle();

        uint256 before = token.balanceOf(opener);
        vm.startPrank(opener);
        vpm.claim(0);
        vm.stopPrank();
        assertGt(token.balanceOf(opener), before, "the opener, not the factory, owns the seed");
    }

    function test_TheFactoryKeepsNothing() public {
        _open(IParimutuelSettler(address(vpm)), 100e6, 100e6);
        assertEq(token.balanceOf(address(factory)), 0, "no balance");
    }

    function test_ARefusedSeedLegIsReturnedToTheOpener() public {
        // kappa = 30, so a 1 : 100 seed cannot be accepted in full: the settler clamps it
        // and the factory must hand back what was refused rather than sitting on it.
        token.mint(opener, 101e6);
        MarketFactory.Feed memory feed = _feed();
        feed.oracle = address(oracle);

        vm.startPrank(opener);
        token.approve(address(factory), type(uint256).max);
        uint256 before = token.balanceOf(opener);
        factory.open(_terms(IParimutuelSettler(address(vpm)), 1e6, 100e6), feed);
        vm.stopPrank();

        uint256 spent = before - token.balanceOf(opener);
        assertLt(spent, 101e6, "the clamp refused part of the seed");
        assertEq(token.balanceOf(address(factory)), 0, "and the factory returned it rather than keeping it");
    }

    function test_TheFactoryCannotResolveAnythingItOpened() public {
        (uint256 marketId,) = _open(IParimutuelSettler(address(vpm)), 100e6, 100e6);
        vm.warp(freeze);
        vm.prank(address(factory));
        vm.expectRevert(VestedParimutuel.NotResolver.selector);
        vpm.resolve(marketId, 0);
    }

    // ------------------------------------------------------------- end to end

    function test_OpenedMarketsSettleThroughTheFeed() public {
        (uint256 marketId, bytes32 specId) = _open(IParimutuelSettler(address(vpm)), 100e6, 100e6);
        _settleSpec(specId);

        (,,,,,,, uint8 status, uint8 winner,,,) = IParimutuelSettler(address(vpm)).getMarket(marketId);
        assertEq(status, uint8(IParimutuelSettler.Status.Resolved), "settled");
        assertEq(winner, 0, "above the strike");
    }

    function _settle() internal {
        token.mint(counterparty, 50e6);
        vm.roll(block.number + 1);
        vm.startPrank(counterparty);
        token.approve(address(vpm), type(uint256).max);
        vpm.enter(0, 1, 50e6);
        vm.stopPrank();

        vm.roll(block.number + 1);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp);
        bytes32 specId = resolver.specIdOf(
            FeedResolver.Spec({
                settler: address(vpm),
                marketId: 0,
                oracle: address(oracle),
                feedKey: FEED,
                strike: STRIKE,
                direction: 0,
                resolutionTime: freeze,
                maxStaleness: 1 hours
            })
        );
        resolver.resolve(specId);
    }

    function _settleSpec(bytes32 specId) internal {
        token.mint(counterparty, 50e6);
        vm.roll(block.number + 1);
        vm.startPrank(counterparty);
        token.approve(address(vpm), type(uint256).max);
        vpm.enter(0, 1, 50e6);
        vm.stopPrank();

        vm.roll(block.number + 1);
        vm.warp(freeze);
        oracle.set(FEED, STRIKE + 1, block.timestamp);
        resolver.resolve(specId);
    }
}
