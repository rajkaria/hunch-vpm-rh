// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {HunchMarketFactory} from "../src/HunchMarketFactory.sol";
import {IERC20Like} from "../src/interfaces/IERC20Like.sol";
import {IHunchSettler} from "../src/interfaces/IHunchSettler.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

/// @title T6 · HunchMarketFactory: one transaction lists a market, and nobody can change it
contract HunchMarketFactoryTest is Test {
    HunchVPM internal vpm;
    StockRoundResolver internal resolver;
    HunchMarketFactory internal factory;
    MockUSDG internal usdg;
    MockAggregator internal nvdaFeed;
    MockStockToken internal nvda;

    address internal safe = makeAddr("safe");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal constant S = 1_790_688_600; // Tue 2026-09-29 09:30 ET
    uint64 internal constant F = 1_790_712_000; // Tue 2026-09-29 16:00 ET
    uint32 internal constant AGE = 26 hours;
    uint128 internal constant SEED = 10e6;

    function setUp() public {
        vm.warp(S - 5 minutes); // listed by 09:25 ET
        vm.roll(23_000_000);
        usdg = new MockUSDG();
        // D10: the settler names its factory, deployed two contracts later (DeployRH does the same)
        vpm = new HunchVPM(safe, safe, vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2), address(0));
        resolver = new StockRoundResolver();
        factory = new HunchMarketFactory(vpm, resolver, IERC20Like(address(usdg)), safe, safe);
        assertEq(vpm.factory(), address(factory), "D10 wiring");
        nvdaFeed = new MockAggregator("Robinhood NVDA / USD");
        nvda = new MockStockToken("NVDA");
        vm.startPrank(safe);
        factory.setFeed(address(nvdaFeed), address(nvda), "NVDA", AGE, AGE, true);
        factory.setOpener(keeper, true);
        vm.stopPrank();
        usdg.mint(keeper, 1_000e6);
        vm.prank(keeper);
        usdg.approve(address(factory), type(uint256).max);
    }

    function _daily() internal view returns (HunchMarketFactory.UpDown memory) {
        return HunchMarketFactory.UpDown({
            feed: address(nvdaFeed),
            strikeTime: S,
            finalTime: F,
            maxStrikeAge: 0,
            maxFinalAge: 0,
            seedPerLeg: SEED,
            minEntry: 1e6,
            maxEntry: 100e6
        });
    }

    function _open(HunchMarketFactory.UpDown memory p) internal returns (uint256 id, bytes32 specId) {
        vm.prank(keeper);
        (id, specId) = factory.openUpDown(p);
        _assertFactoryHoldsNothing();
    }

    function _assertFactoryHoldsNothing() internal view {
        assertEq(usdg.balanceOf(address(factory)), 0, "the factory holds no USDG");
        assertEq(usdg.allowance(address(factory), address(vpm)), 0, "the factory's allowance is zeroed");
        for (uint256 i = 0; i < vpm.positionCount(); i++) {
            (, address owner,,,,,,,,) = vpm.positions(i);
            assertTrue(owner != address(factory), "the factory owns no position");
        }
    }

    // ================================================================== constructor / owner

    function test_ConstructorWiresEverythingAndNamesTheOwner() public {
        assertEq(address(factory.settler()), address(vpm));
        assertEq(address(factory.resolver()), address(resolver));
        assertEq(address(factory.usdg()), address(usdg));
        assertEq(factory.treasury(), safe);
        assertEq(factory.owner(), safe);
        assertEq(factory.pendingOwner(), address(0));
        assertEq(factory.KAPPA(), 30);
        assertEq(factory.FEE_BPS(), 200);
        assertEq(factory.VOID_TIMEOUT(), 72 hours);
        assertEq(factory.MAX_WINDOW(), 8 days);

        vm.expectEmit();
        emit HunchMarketFactory.OwnershipTransferred(address(0), safe);
        new HunchMarketFactory(vpm, resolver, IERC20Like(address(usdg)), safe, safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        new HunchMarketFactory(HunchVPM(address(0)), resolver, IERC20Like(address(usdg)), safe, safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        new HunchMarketFactory(vpm, StockRoundResolver(address(0)), IERC20Like(address(usdg)), safe, safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        new HunchMarketFactory(vpm, resolver, IERC20Like(address(0)), safe, safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        new HunchMarketFactory(vpm, resolver, IERC20Like(address(usdg)), address(0), safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        new HunchMarketFactory(vpm, resolver, IERC20Like(address(usdg)), safe, address(0));
    }

    function test_OwnershipMovesInTwoSteps() public {
        address next = makeAddr("next safe");
        vm.prank(stranger);
        vm.expectRevert(HunchMarketFactory.NotOwner.selector);
        factory.transferOwnership(next);

        vm.expectEmit(address(factory));
        emit HunchMarketFactory.OwnershipTransferStarted(safe, next);
        vm.prank(safe);
        factory.transferOwnership(next);
        assertEq(factory.owner(), safe, "nothing changes until accepted");
        assertEq(factory.pendingOwner(), next);

        vm.prank(stranger);
        vm.expectRevert(HunchMarketFactory.NotPendingOwner.selector);
        factory.acceptOwnership();

        vm.expectEmit(address(factory));
        emit HunchMarketFactory.OwnershipTransferred(safe, next);
        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
        assertEq(factory.pendingOwner(), address(0));

        vm.prank(safe);
        vm.expectRevert(HunchMarketFactory.NotOwner.selector);
        factory.setOpener(stranger, true);
    }

    function test_APendingTransferCanBeCancelled() public {
        vm.startPrank(safe);
        factory.transferOwnership(stranger);
        factory.transferOwnership(address(0));
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(HunchMarketFactory.NotPendingOwner.selector);
        factory.acceptOwnership();
        assertEq(factory.owner(), safe);
    }

    function test_OnlyTheOwnerManagesFeedsAndOpeners() public {
        vm.startPrank(stranger);
        vm.expectRevert(HunchMarketFactory.NotOwner.selector);
        factory.setFeed(address(nvdaFeed), address(nvda), "NVDA", AGE, AGE, true);
        vm.expectRevert(HunchMarketFactory.NotOwner.selector);
        factory.setOpener(stranger, true);
        vm.stopPrank();
        vm.prank(keeper); // an opener is not an owner either
        vm.expectRevert(HunchMarketFactory.NotOwner.selector);
        factory.setOpener(stranger, true);
    }

    function test_SetFeedValidatesAndEnumerates() public {
        MockAggregator tslaFeed = new MockAggregator("Robinhood TSLA / USD");
        MockStockToken tsla = new MockStockToken("TSLA");
        vm.startPrank(safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        factory.setFeed(address(0), address(tsla), "TSLA", AGE, AGE, true);
        vm.expectRevert(HunchMarketFactory.BadFeedConfig.selector);
        factory.setFeed(address(tslaFeed), address(0), "TSLA", AGE, AGE, true);
        vm.expectRevert(HunchMarketFactory.BadFeedConfig.selector);
        factory.setFeed(address(tslaFeed), address(tsla), "TSLA", 0, AGE, true);
        vm.expectRevert(HunchMarketFactory.BadFeedConfig.selector);
        factory.setFeed(address(tslaFeed), address(tsla), "TSLA", AGE, 0, true);
        vm.expectRevert(HunchMarketFactory.BadFeedConfig.selector);
        factory.setFeed(address(tslaFeed), address(tsla), "", AGE, AGE, true);

        vm.expectEmit(address(factory));
        emit HunchMarketFactory.FeedSet(address(tslaFeed), address(tsla), "TSLA", AGE, 2 hours, true);
        factory.setFeed(address(tslaFeed), address(tsla), "TSLA", AGE, 2 hours, true);
        factory.setFeed(address(tslaFeed), address(tsla), "TSLA", AGE, 2 hours, false); // delist
        vm.stopPrank();

        (address stockToken, uint32 strikeAge, uint32 finalAge, bool allowed, string memory ticker) =
            factory.feeds(address(tslaFeed));
        assertEq(stockToken, address(tsla));
        assertEq(strikeAge, AGE);
        assertEq(finalAge, 2 hours);
        assertFalse(allowed);
        assertEq(ticker, "TSLA");
        assertEq(factory.feedCount(), 2, "listed once, however often it is set");
        assertEq(factory.feedAt(0), address(nvdaFeed));
        assertEq(factory.feedAt(1), address(tslaFeed));
    }

    function test_SetOpener() public {
        vm.startPrank(safe);
        vm.expectRevert(HunchMarketFactory.ZeroAddress.selector);
        factory.setOpener(address(0), true);
        vm.expectEmit(address(factory));
        emit HunchMarketFactory.OpenerSet(keeper, false);
        factory.setOpener(keeper, false);
        vm.stopPrank();
        assertFalse(factory.openers(keeper));
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.NotOpener.selector);
        factory.openUpDown(_daily());
    }

    // ================================================================== openUpDown: gates

    function test_OnlyAnOpenerCanList() public {
        usdg.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdg.approve(address(factory), type(uint256).max);
        vm.expectRevert(HunchMarketFactory.NotOpener.selector);
        factory.openUpDown(_daily());
        vm.stopPrank();
        vm.prank(safe); // not even the owner
        vm.expectRevert(HunchMarketFactory.NotOpener.selector);
        factory.openUpDown(_daily());
    }

    function test_OnlyAnAllowListedFeed() public {
        HunchMarketFactory.UpDown memory p = _daily();
        p.feed = address(new MockAggregator("unknown"));
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.FeedNotAllowed.selector);
        factory.openUpDown(p);

        vm.prank(safe);
        factory.setFeed(address(nvdaFeed), address(nvda), "NVDA", AGE, AGE, false);
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.FeedNotAllowed.selector);
        factory.openUpDown(_daily());
    }

    function test_TimesAreChecked() public {
        HunchMarketFactory.UpDown memory p = _daily();
        p.strikeTime = F;
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.BadTimes.selector);
        factory.openUpDown(p);

        vm.warp(F);
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.BadTimes.selector);
        factory.openUpDown(_daily()); // at or after the bell: too late to list

        // The strike bell must still be ahead: nobody bets on a strike price already known.
        vm.warp(S);
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.BadTimes.selector);
        factory.openUpDown(_daily());
        vm.warp(S + 1 hours);
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.BadTimes.selector);
        factory.openUpDown(_daily());
        vm.warp(S - 5 minutes);

        p = _daily();
        p.finalTime = p.strikeTime + 8 days + 1;
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.WindowTooLong.selector);
        factory.openUpDown(p);
        p.finalTime = p.strikeTime + 8 days; // exactly eight days is allowed
        _open(p);
        vm.warp(S - 1); // one second before the strike bell is still in time
        _open(_daily());
    }

    function test_SeedIsAtLeastOneUsdgPerLeg() public {
        HunchMarketFactory.UpDown memory p = _daily();
        p.seedPerLeg = 1e6 - 1;
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.SeedTooSmall.selector);
        factory.openUpDown(p);
        p.seedPerLeg = 1e6;
        _open(p);
    }

    /// @dev An opener may only TIGHTEN an age bound: 0 takes the feed's, a looser one reverts.
    function test_OpenersMayOnlyTightenAgeBounds() public {
        HunchMarketFactory.UpDown memory p = _daily();
        p.maxStrikeAge = AGE + 1;
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.BoundTooLoose.selector);
        factory.openUpDown(p);
        p = _daily();
        p.maxFinalAge = AGE + 1;
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.BoundTooLoose.selector);
        factory.openUpDown(p);

        // the refund drill: a 1 h final bound on a Saturday-morning bell
        p = _daily();
        p.maxFinalAge = 1 hours;
        (, bytes32 tight) = _open(p);
        StockRoundResolver.Spec memory s = resolver.getSpec(tight);
        assertEq(s.maxStrikeAge, AGE, "0 took the feed's bound");
        assertEq(s.maxFinalAge, 1 hours, "the tighter bound was kept");
        (,,,,, uint32 strikeAge, uint32 finalAge,,,,,) = factory.listings(factory.listingCount() - 1);
        assertEq(strikeAge, AGE);
        assertEq(finalAge, 1 hours);
    }

    function test_InvertedEntryBoundsRevertAtomically() public {
        HunchMarketFactory.UpDown memory p = _daily();
        p.minEntry = 50e6;
        p.maxEntry = 10e6;
        uint256 before = usdg.balanceOf(keeper);
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.InvalidEntryBounds.selector);
        factory.openUpDown(p);
        assertEq(usdg.balanceOf(keeper), before, "nothing moved");
        assertEq(vpm.marketCount(), 0);
    }

    /// @dev I-3 (independent review): every listed market has an entry floor of at least 1 USDG
    ///      and a cap, so filling a vintage (D9: 200 entries a block) costs real capital.
    function test_EveryListedMarketHasAnEntryFloorAndACap() public {
        assertEq(factory.MIN_ENTRY(), 1e6);
        HunchMarketFactory.UpDown memory p = _daily();
        p.minEntry = 1e6 - 1;
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.EntryBoundsTooLoose.selector);
        factory.openUpDown(p);
        p.minEntry = 0; // "no floor" is not allowed
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.EntryBoundsTooLoose.selector);
        factory.openUpDown(p);
        p = _daily();
        p.maxEntry = 0; // "no cap" is not allowed
        vm.prank(keeper);
        vm.expectRevert(HunchMarketFactory.EntryBoundsTooLoose.selector);
        factory.openUpDown(p);
        assertEq(vpm.marketCount(), 0, "nothing listed");

        p = _daily();
        p.minEntry = 1e6; // the tightest allowed: exactly 1 USDG, min = max
        p.maxEntry = 1e6;
        (uint256 id,) = _open(p);
        (, uint128 minEntry, uint128 maxEntry) = vpm.marketTerms(id);
        assertEq(abi.encode(minEntry, maxEntry), abi.encode(uint128(1e6), uint128(1e6)));
    }

    // ================================================================== openUpDown: effects

    function test_OpenListsAMarketWithTheVenueTermsInOneTransaction() public {
        vm.expectEmit(true, false, true, true, address(factory));
        emit HunchMarketFactory.MarketOpened(0, bytes32(0), address(nvdaFeed), "NVDA", S, F, SEED, 1e6, 100e6);
        (uint256 id, bytes32 specId) = _open(_daily());
        _assertVenueMarket(id);
        _assertSpec(id, specId);
        _assertSeedLegsWithTheOpener(id);
        _assertListing(id, specId);
    }

    /// @dev κ 30, fee 2%, 72 h void timeout, the resolver, the treasury as residue owner, caps.
    function _assertVenueMarket(uint256 id) internal view {
        (
            IERC20 token,
            address creator,
            address res,
            address residueOwner,
            uint64 resolutionTime,
            uint64 voidTimeout,
            uint8 n,,,
            uint256 kappa,
            uint256 pool,
        ) = vpm.getMarket(id);
        assertEq(address(token), address(usdg));
        assertEq(creator, address(factory));
        assertEq(res, address(resolver));
        assertEq(residueOwner, safe);
        assertEq(resolutionTime, F);
        assertEq(voidTimeout, 72 hours);
        assertEq(n, 2);
        assertEq(kappa, 30);
        assertEq(pool, 2 * SEED);
        (uint16 feeBps, uint128 minEntry, uint128 maxEntry) = vpm.marketTerms(id);
        assertEq(feeBps, 200);
        assertEq(minEntry, 1e6);
        assertEq(maxEntry, 100e6);
    }

    /// @dev This feed, its Stock Token, the two bells, the feed's bounds.
    function _assertSpec(uint256 id, bytes32 specId) internal view {
        StockRoundResolver.Spec memory s = resolver.getSpec(specId);
        assertEq(s.settler, address(vpm));
        assertEq(s.marketId, id);
        assertEq(s.feed, address(nvdaFeed));
        assertEq(s.stockToken, address(nvda));
        assertEq(s.strikeTime, S);
        assertEq(s.finalTime, F);
        assertEq(s.maxStrikeAge, AGE);
        assertEq(s.maxFinalAge, AGE);
        assertEq(resolver.specIdOf(address(vpm), id), specId);
        assertEq(specId, keccak256(abi.encode(s)));
    }

    function _assertSeedLegsWithTheOpener(uint256 id) internal view {
        uint256[] memory legs = vpm.marketPositions(id, 0, 2);
        for (uint256 i = 0; i < 2; i++) {
            (, address owner, uint8 outcome,,,,, uint128 offered, uint128 accepted,) = vpm.positions(legs[i]);
            assertEq(owner, keeper, "the opener owns the seed legs it paid for");
            assertEq(outcome, i);
            assertEq(offered, SEED);
            assertEq(accepted, SEED);
        }
        assertEq(usdg.balanceOf(keeper), 1_000e6 - 2 * SEED, "the opener paid exactly 2 x seed");
        assertEq(usdg.balanceOf(address(vpm)), 2 * SEED);
    }

    /// @dev The listing, readable with view calls only.
    function _assertListing(uint256 id, bytes32 specId) internal view {
        assertEq(factory.listingCount(), 1);
        assertEq(factory.listingIndexOf(id), 1);
        assertEq(factory.listingIndexOf(id + 1), 0, "not from this factory");
        (, bytes memory got) = address(factory).staticcall(abi.encodeCall(factory.listings, (0)));
        bytes memory want = abi.encode(
            id,
            specId,
            address(nvdaFeed),
            S,
            F,
            AGE,
            AGE,
            SEED,
            uint128(1e6),
            uint128(100e6),
            keeper,
            uint64(block.timestamp)
        );
        assertEq(got, want, "listing(0)");
    }

    /// @dev Somebody sends USDG to the factory: the next listing hands it to the opener, so
    ///      the factory still ends the call empty.
    function test_TheFactoryEndsEveryCallEmptyEvenAfterADonation() public {
        usdg.mint(address(factory), 3e6);
        uint256 before = usdg.balanceOf(keeper);
        _open(_daily());
        assertEq(usdg.balanceOf(keeper), before - 2 * SEED + 3e6);
    }

    function test_ManyListingsEnumerate() public {
        MockAggregator tslaFeed = new MockAggregator("Robinhood TSLA / USD");
        MockStockToken tsla = new MockStockToken("TSLA");
        vm.prank(safe);
        factory.setFeed(address(tslaFeed), address(tsla), "TSLA", AGE, AGE, true);
        (uint256 a,) = _open(_daily());
        HunchMarketFactory.UpDown memory p = _daily();
        p.feed = address(tslaFeed);
        (uint256 b,) = _open(p);
        p.finalTime = F + 3 days; // the weekly
        (uint256 c,) = _open(p);
        assertEq(factory.listingCount(), 3);
        assertEq(factory.listingIndexOf(a), 1);
        assertEq(factory.listingIndexOf(b), 2);
        assertEq(factory.listingIndexOf(c), 3);
        (,, address feedB,,,,,,,,,) = factory.listings(1);
        assertEq(feedB, address(tslaFeed));
    }

    /// @dev Neither the owner nor the opener can change a listed market: re-configuring the feed
    ///      leaves every existing spec exactly as it was.
    function test_NobodyCanChangeAListedMarket() public {
        (uint256 id, bytes32 specId) = _open(_daily());
        bytes memory before = abi.encode(resolver.getSpec(specId));
        vm.prank(safe);
        factory.setFeed(address(nvdaFeed), address(0xBEEF), "XXX", 1, 1, true);
        assertEq(abi.encode(resolver.getSpec(specId)), before, "the spec is immutable");
        (uint16 feeBps, uint128 minEntry, uint128 maxEntry) = vpm.marketTerms(id);
        assertEq(abi.encode(feeBps, minEntry, maxEntry), abi.encode(uint16(200), uint128(1e6), uint128(100e6)));
        StockRoundResolver.Spec memory spec = resolver.getSpec(specId);
        vm.expectRevert(StockRoundResolver.NotCreator.selector);
        resolver.register(spec); // nor register a second spec for it
        vm.prank(address(factory));
        vm.expectRevert(StockRoundResolver.AlreadyRegistered.selector);
        resolver.register(spec); // not even as its creator
    }

    /// @dev HunchVPM does not inherit IHunchSettler (it stays line-for-line comparable to the
    ///      reference), so this is what keeps the resolver's view of it honest.
    function test_TheResolversSettlerInterfaceMatchesHunchVPM() public pure {
        assertEq(IHunchSettler.getMarket.selector, HunchVPM.getMarket.selector);
        assertEq(IHunchSettler.resolve.selector, HunchVPM.resolve.selector);
        assertEq(IHunchSettler.voidMarket.selector, HunchVPM.voidMarket.selector);
    }

    // ================================================================== end to end

    /// @dev List, bet, ring the bell, resolve from two proven rounds, deliver every claim:
    ///      the opener recycles the seed, the treasury gets fees and residue, nothing is left.
    function test_EndToEndListBetResolveDeliver() public {
        (uint256 id, bytes32 specId) = _open(_daily());
        uint80 strike = nvdaFeed.addRound(181e8, S - 10 minutes); // $181.00 at 8 decimals
        _bet(alice, id, 0, 40e6);
        _bet(bob, id, 1, 60e6);
        nvdaFeed.addRound(183e8, S + 3 hours);
        uint80 fin = nvdaFeed.addRound(18_450_000_000, F - 20 minutes); // $184.50: UP
        vm.warp(F + 60);
        (uint8 status,,,,) = resolver.preview(specId, strike, fin);
        assertEq(status, 1, "UP");
        vm.prank(stranger);
        resolver.resolve(specId, strike, fin);

        uint256[] memory all = vpm.marketPositions(id, 0, 10);
        for (uint256 i = 0; i < all.length; i++) {
            vpm.claimFor(all[i]);
        }
        vm.prank(safe);
        vpm.claimResidue(id);
        vpm.sweepFees(IERC20(address(usdg)));
        assertEq(usdg.balanceOf(address(vpm)), 0, "every unit delivered");
        assertGt(usdg.balanceOf(alice), 40e6, "UP won");
        assertEq(usdg.balanceOf(bob), 0);
        assertGt(usdg.balanceOf(safe), 0, "fees and residue to the Safe");
        assertEq(usdg.balanceOf(keeper) + usdg.balanceOf(alice) + usdg.balanceOf(safe), 1_000e6 + 100e6, "conservation");
    }

    function _bet(address who, uint256 id, uint8 outcome, uint256 amount) internal {
        vm.roll(block.number + 1);
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(vpm), amount);
        vpm.enter(id, outcome, amount);
        vm.stopPrank();
    }
}
