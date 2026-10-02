// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockSettler} from "../src/mocks/MockSettler.sol";

/// @notice Shared fixture: a proxy-style feed, a Stock Token, a recording settler, and a
///         Tuesday session (09:30 → 16:00 ET) with a realistic, deviation-triggered round tape.
abstract contract ResolverBase is Test {
    StockRoundResolver internal resolver;
    MockAggregator internal feed;
    MockStockToken internal token;
    MockSettler internal settler;

    uint64 internal constant S = 1_790_688_600; // Tue 2026-09-29 09:30 ET (strike)
    uint64 internal constant F = 1_790_712_000; // Tue 2026-09-29 16:00 ET (final = freeze)
    uint32 internal constant AGE = 26 hours;
    uint256 internal constant MARKET = 7;

    error Succeeded();

    function setUp() public virtual {
        vm.warp(S - 1 days);
        resolver = new StockRoundResolver();
        feed = new MockAggregator("Robinhood NVDA / USD");
        token = new MockStockToken("NVDA");
        settler = new MockSettler();
        settler.setMarket(MARKET, address(this), address(resolver), F, 2);
    }

    function _spec(uint32 strikeAge, uint32 finalAge) internal view returns (StockRoundResolver.Spec memory) {
        return StockRoundResolver.Spec({
            settler: address(settler),
            marketId: MARKET,
            feed: address(feed),
            stockToken: address(token),
            strikeTime: S,
            finalTime: F,
            maxStrikeAge: strikeAge,
            maxFinalAge: finalAge
        });
    }

    function _register() internal returns (bytes32) {
        return resolver.register(_spec(AGE, AGE));
    }

    /// @dev Resolve and roll back, reporting success; the market stays unsettled.
    function attempt(bytes32 specId, uint80 s, uint80 f) external {
        resolver.resolve(specId, s, f);
        revert Succeeded();
    }

    function _resolves(bytes32 specId, uint80 s, uint80 f) internal returns (bool) {
        try this.attempt(specId, s, f) {
            return false; // unreachable
        } catch (bytes memory err) {
            return bytes4(err) == Succeeded.selector;
        }
    }

    function _settlerState() internal view returns (uint8 status, uint8 winner) {
        (,,,, status, winner) = settler.markets(MARKET);
    }
}

/// @title T5 · StockRoundResolver: only the price in effect at each bell settles a market
contract StockRoundResolverTest is ResolverBase {
    uint80 internal r1;
    uint80 internal r2;
    uint80 internal r3;
    uint80 internal r4;
    uint80 internal r5;
    bytes32 internal specId;

    function setUp() public override {
        super.setUp();
        r1 = feed.addRound(180e8, S - 3 hours); // overnight print
        r2 = feed.addRound(181e8, S - 10 minutes); // pre-market: the price in effect at 09:30
        r3 = feed.addRound(183e8, S + 1 hours);
        r4 = feed.addRound(185e8, F - 2 hours); // the price in effect at 16:00
        r5 = feed.addRound(186e8, F + 5 minutes); // after the bell
        specId = _register();
        vm.warp(F + 60);
    }

    // ================================================================== register

    function test_RegisterStoresAnImmutableSpec() public view {
        assertEq(specId, keccak256(abi.encode(_spec(AGE, AGE))), "specId = hash of the spec");
        assertEq(resolver.specIdOf(address(settler), MARKET), specId);
        StockRoundResolver.Spec memory s = resolver.getSpec(specId);
        assertEq(s.feed, address(feed));
        assertEq(s.stockToken, address(token));
        assertEq(s.strikeTime, S);
        assertEq(s.finalTime, F);
        assertEq(s.maxStrikeAge, AGE);
        assertFalse(resolver.settled(specId));
    }

    function test_RegisterEmitsTheWholeSpec() public {
        settler.setMarket(8, address(this), address(resolver), F, 2);
        StockRoundResolver.Spec memory s = _spec(AGE, 1 hours);
        s.marketId = 8;
        vm.expectEmit(address(resolver));
        emit StockRoundResolver.Registered(
            keccak256(abi.encode(s)), address(settler), 8, address(feed), address(token), S, F, AGE, 1 hours
        );
        resolver.register(s);
    }

    function test_RegisterRejectsBadSpecs() public {
        settler.setMarket(9, address(this), address(resolver), F, 2);
        StockRoundResolver.Spec memory s = _spec(AGE, AGE);
        s.marketId = 9;

        StockRoundResolver.Spec memory bad = _copy(s);
        bad.feed = address(0);
        vm.expectRevert(StockRoundResolver.ZeroAddress.selector);
        resolver.register(bad);
        bad = _copy(s);
        bad.stockToken = address(0);
        vm.expectRevert(StockRoundResolver.ZeroAddress.selector);
        resolver.register(bad);
        bad = _copy(s);
        bad.settler = address(0);
        vm.expectRevert(StockRoundResolver.ZeroAddress.selector);
        resolver.register(bad);
        bad = _copy(s);
        bad.strikeTime = F;
        vm.expectRevert(StockRoundResolver.BadTimes.selector);
        resolver.register(bad);
        bad = _copy(s);
        bad.finalTime = F + 1;
        bad.strikeTime = S;
        vm.expectRevert(StockRoundResolver.WrongFinalTime.selector);
        resolver.register(bad);

        settler.setMarket(9, address(this), address(0xBEEF), F, 2);
        vm.expectRevert(StockRoundResolver.WrongResolver.selector);
        resolver.register(s);
        settler.setMarket(9, address(this), address(resolver), F, 3);
        vm.expectRevert(StockRoundResolver.NotBinary.selector);
        resolver.register(s);
        settler.setMarket(9, address(this), address(resolver), F, 2);
        settler.setStatus(9, 2);
        vm.expectRevert(StockRoundResolver.MarketNotOpen.selector);
        resolver.register(s);
        settler.setStatus(9, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(StockRoundResolver.NotCreator.selector);
        resolver.register(s);

        resolver.register(s);
        vm.expectRevert(StockRoundResolver.AlreadyRegistered.selector);
        resolver.register(s);
        bad = _copy(s);
        bad.feed = address(0xFEED); // a second, different spec for the same market
        vm.expectRevert(StockRoundResolver.AlreadyRegistered.selector);
        resolver.register(bad);
    }

    // ================================================================== resolve

    function test_ResolvesUpFromTheUniqueProvenPair() public {
        vm.expectEmit(address(resolver));
        emit StockRoundResolver.Resolved(specId, MARKET, 0, r2, 181e8, S - 10 minutes, r4, 185e8, F - 2 hours);
        vm.prank(address(0xCAFE)); // anyone
        resolver.resolve(specId, r2, r4);
        (uint8 status, uint8 winner) = _settlerState();
        assertEq(status, 1, "resolved");
        assertEq(winner, 0, "UP");
        assertTrue(resolver.settled(specId));
    }

    function test_ResolvesDown() public {
        feed.setRound(r4, 175e8, F - 2 hours);
        resolver.resolve(specId, r2, r4);
        (uint8 status, uint8 winner) = _settlerState();
        assertEq(status, 1);
        assertEq(winner, 1, "DOWN");
    }

    function test_EqualAnswersAreFlatAndVoid() public {
        feed.setRound(r4, 181e8, F - 2 hours);
        vm.expectEmit(address(resolver));
        emit StockRoundResolver.Resolved(specId, MARKET, 2, r2, 181e8, S - 10 minutes, r4, 181e8, F - 2 hours);
        resolver.resolve(specId, r2, r4);
        (uint8 status,) = _settlerState();
        assertEq(status, 2, "FLAT voids: every bet refunded");
    }

    /// @dev The price never moved 0.5%: the same round is in effect at both bells.
    function test_TheSameRoundIsFlatAndVoids() public {
        MockAggregator quiet = new MockAggregator("quiet");
        uint80 only = quiet.addRound(181e8, S - 1 hours);
        quiet.addRound(182e8, F + 1 hours);
        settler.setMarket(11, address(this), address(resolver), F, 2);
        StockRoundResolver.Spec memory s = _spec(AGE, AGE);
        s.marketId = 11;
        s.feed = address(quiet);
        bytes32 id = resolver.register(s);
        vm.warp(F + 2 hours);
        resolver.resolve(id, only, only);
        (,,,, uint8 status,) = settler.markets(11);
        assertEq(status, 2);
    }

    function test_NobodyCanResolveAtOrBeforeTheBell() public {
        vm.warp(F);
        vm.expectRevert(StockRoundResolver.TooEarly.selector);
        resolver.resolve(specId, r2, r4);
        vm.warp(F + 1);
        resolver.resolve(specId, r2, r4);
    }

    function test_OffByOneRoundsRevertBadProof() public {
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r1, r4); // r2 is also at or before the strike
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r3, r4); // r3 is after the strike
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r2, r3); // r4 is also at or before the bell
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r2, r5); // r5 is after the bell
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r4, r2); // final before strike
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r2, r5 + 10); // a round that does not exist
        uint80 noPhase = feed.roundId(2, 1);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, noPhase, noPhase); // a phase that does not exist
        resolver.resolve(specId, r2, r4);
    }

    /// @dev Round x + 1 absent is accepted only when x is the proxy's latest round.
    function test_AMissingNextRoundIsAcceptedOnlyForTheLatestRound() public {
        // nothing printed since before the bell: the final round is the proxy's latest round
        MockAggregator tape = new MockAggregator("tape");
        tape.addRound(181e8, S - 10 minutes);
        uint80 last = tape.addRound(185e8, F - 2 hours);
        bytes32 id = _registerOn(12, address(tape));
        assertTrue(_resolves(id, last - 1, last), "latest round, no successor: proven");

        // a hole: the round after x is missing but x is NOT the latest round
        MockAggregator holey = new MockAggregator("holey");
        uint80 s = holey.addRound(181e8, S - 10 minutes);
        uint80 f = holey.addRound(185e8, F - 2 hours);
        holey.addRound(186e8, F + 5 minutes);
        holey.addRound(187e8, F + 10 minutes);
        holey.deleteRound(f + 1);
        bytes32 id2 = _registerOn(13, address(holey));
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(id2, s, f);
    }

    function test_MissingRoundsReadTheSameWhetherTheyRevertOrReturnZeros() public {
        feed.setZeroForMissing(true);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r2, r5 + 10);
        resolver.resolve(specId, r2, r4);
    }

    /// @dev A new phase that started before the bell: the old phase's last round cannot prove
    ///      itself across the boundary, and the new phase's round proves normally.
    function test_APhaseBoundaryBeforeTheBellReverts() public {
        MockAggregator px = new MockAggregator("phased");
        uint80 s = px.addRound(181e8, S - 10 minutes);
        uint80 lastOfPhase1 = px.addRound(184e8, S + 2 hours);
        px.startPhase();
        uint80 firstOfPhase2 = px.addRound(185e8, F - 1 hours);
        px.addRound(186e8, F + 1 hours);
        bytes32 id = _registerOn(14, address(px));
        vm.warp(F + 2 hours);
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, s, lastOfPhase1);
        assertTrue(_resolves(id, s, firstOfPhase2), "the new phase's round is the one in effect");
    }

    /// @dev A new phase that started AFTER the bell: the old phase's last round is still the
    ///      price in effect at the bell, and it proves.
    function test_APhaseStartedAfterTheBellDoesNotBlock() public {
        MockAggregator px = new MockAggregator("phased later");
        uint80 s = px.addRound(181e8, S - 10 minutes);
        uint80 f = px.addRound(184e8, F - 30 minutes);
        px.startPhase();
        px.addRound(186e8, F + 1 hours);
        bytes32 id = _registerOn(15, address(px));
        vm.warp(F + 2 hours);
        resolver.resolve(id, s, f);
        (,,,, uint8 status, uint8 winner) = settler.markets(15);
        assertEq(status, 1);
        assertEq(winner, 0);
    }

    /// @dev Right after the proxy switches to a new aggregator that has not printed yet, the
    ///      old phase's last round cannot be proven (it could be a hole). Resolution waits for
    ///      the new aggregator's first round, which is after the bell, and then succeeds.
    function test_ANewPhaseWithNoRoundsDelaysResolutionUntilItPrints() public {
        MockAggregator px = new MockAggregator("switching");
        uint80 s = px.addRound(181e8, S - 10 minutes);
        uint80 f = px.addRound(184e8, F - 30 minutes);
        px.startPhase(); // no rounds in phase 2 yet
        bytes32 id = _registerOn(16, address(px));
        vm.warp(F + 1 hours);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(id, s, f);
        (uint8 st,,,,) = resolver.preview(id, s, f);
        assertEq(st, 5, "BADPROOF until the new aggregator prints");
        px.addRound(185e8, block.timestamp); // its first print, after the bell
        resolver.resolve(id, s, f);
        (,,,, uint8 status, uint8 winner) = settler.markets(16);
        assertEq(status, 1);
        assertEq(winner, 0);
    }

    function test_GarbageAnswersRevertBadAnswer() public {
        feed.setRound(r2, 7_424_400_000_000_000_000, S - 10 minutes); // 18-decimal garbage (SPY rounds 1-7)
        vm.expectRevert(StockRoundResolver.BadAnswer.selector);
        resolver.resolve(specId, r2, r4);
        feed.setRound(r2, 1e14, S - 10 minutes); // just outside the band
        vm.expectRevert(StockRoundResolver.BadAnswer.selector);
        resolver.resolve(specId, r2, r4);
        feed.setRound(r2, 0, S - 10 minutes);
        vm.expectRevert(StockRoundResolver.BadAnswer.selector);
        resolver.resolve(specId, r2, r4);
        feed.setRound(r2, -1, S - 10 minutes);
        vm.expectRevert(StockRoundResolver.BadAnswer.selector);
        resolver.resolve(specId, r2, r4);
        feed.setRound(r2, 1e14 - 1, S - 10 minutes); // inside the band
        resolver.resolve(specId, r2, r4);
    }

    /// @notice L-3 of the second review: a garbage answer on the round IN EFFECT at a bell used
    ///         to fail the proof before uniqueness was checked, so neither `resolve` nor
    ///         `voidStale` could ever run and the market waited 72 h for the settler timeout.
    ///         The round is now proven first; its garbage answer then refunds at once.
    function test_AProvenGarbageAnswerVoidsThroughVoidBadAnswer() public {
        feed.setRound(r4, 7_424_400_000_000_000_000, F - 2 hours); // the final round in effect is garbage
        vm.expectRevert(StockRoundResolver.BadAnswer.selector);
        resolver.resolve(specId, r2, r4);
        vm.expectRevert(StockRoundResolver.BadAnswer.selector);
        resolver.voidStale(specId, r2, r4);
        (uint8 st,,,,) = resolver.preview(specId, r2, r4);
        assertEq(st, resolver.STATUS_BAD_ANSWER());

        vm.expectEmit(address(resolver));
        emit StockRoundResolver.VoidedBadAnswer(specId, MARKET, r2, r4);
        vm.prank(makeAddr("anyone"));
        resolver.voidBadAnswer(specId, r2, r4);
        assertTrue(resolver.settled(specId));
        (uint8 status,) = _settlerState();
        assertEq(status, 2, "voided: everyone refunded");
        vm.expectRevert(StockRoundResolver.AlreadySettled.selector);
        resolver.voidBadAnswer(specId, r2, r4);
    }

    function test_VoidBadAnswerNeedsTheRoundsInEffectAndAGarbageAnswer() public {
        vm.expectRevert(StockRoundResolver.NotBadAnswer.selector);
        resolver.voidBadAnswer(specId, r2, r4); // both answers sane: resolve instead

        // Garbage on a round that is NOT in effect proves nothing: nobody can pick a bad round.
        feed.setRound(r1, -1, S - 3 hours);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.voidBadAnswer(specId, r1, r4);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(specId, r1, r4);
        (uint8 st,,,,) = resolver.preview(specId, r1, r4);
        assertEq(st, resolver.STATUS_BAD_PROOF());
        feed.setRound(r5, 0, F + 5 minutes);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.voidBadAnswer(specId, r2, r5); // after the bell

        feed.setRound(r2, 0, S - 10 minutes); // the strike round in effect is garbage
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.voidBadAnswer(specId, r4, r2); // final before strike
        vm.warp(F);
        vm.expectRevert(StockRoundResolver.TooEarly.selector);
        resolver.voidBadAnswer(specId, r2, r4);
        vm.warp(F + 60);
        resolver.voidBadAnswer(specId, r2, r4);
        (uint8 status,) = _settlerState();
        assertEq(status, 2);
        vm.expectRevert(StockRoundResolver.AlreadySettled.selector);
        resolver.resolve(specId, r2, r4);
    }

    // ================================================================== staleness

    function test_AStaleStrikeCannotResolveOnlyVoidStale() public {
        bytes32 id = _registerTight(20, 5 minutes, AGE); // strike round is 10 min old
        vm.expectRevert(StockRoundResolver.Stale.selector);
        resolver.resolve(id, r2, r4);
        vm.expectEmit(address(resolver));
        emit StockRoundResolver.VoidedStale(id, 20, r2, r4);
        resolver.voidStale(id, r2, r4);
        (,,,, uint8 status,) = settler.markets(20);
        assertEq(status, 2, "voided: everyone refunded");
        assertTrue(resolver.settled(id));
    }

    function test_AStaleFinalCannotResolveOnlyVoidStale() public {
        bytes32 id = _registerTight(21, AGE, 1 hours); // final round is 2 h old
        vm.expectRevert(StockRoundResolver.Stale.selector);
        resolver.resolve(id, r2, r4);
        resolver.voidStale(id, r2, r4);
        (,,,, uint8 status,) = settler.markets(21);
        assertEq(status, 2);
    }

    function test_AgeBoundsAreInclusive() public {
        bytes32 id = _registerTight(22, 10 minutes, 2 hours); // exactly the ages of r2 and r4
        vm.expectRevert(StockRoundResolver.NotStale.selector);
        resolver.voidStale(id, r2, r4);
        resolver.resolve(id, r2, r4);
    }

    function test_VoidStaleNeedsTheSameProofsAndARealViolation() public {
        vm.expectRevert(StockRoundResolver.NotStale.selector);
        resolver.voidStale(specId, r2, r4); // fresh: nobody can void a market with a good answer
        bytes32 id = _registerTight(23, 5 minutes, AGE);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.voidStale(id, r1, r4); // stale is not enough: the rounds must be proven
        vm.warp(F);
        vm.expectRevert(StockRoundResolver.TooEarly.selector);
        resolver.voidStale(id, r2, r4);
    }

    // ================================================================== oracle pause

    function test_AnOraclePauseBlocksResolution() public {
        token.setOraclePaused(true);
        vm.expectRevert(StockRoundResolver.OraclePaused.selector);
        resolver.resolve(specId, r2, r4);
        token.setOraclePaused(false);
        resolver.resolve(specId, r2, r4);
    }

    function test_VoidPausedOnlyAfter24HoursAndOnlyWhilePaused() public {
        token.setOraclePaused(true);
        vm.warp(F + 24 hours - 1);
        vm.expectRevert(StockRoundResolver.TooEarly.selector);
        resolver.voidPaused(specId);
        vm.warp(F + 24 hours);
        token.setOraclePaused(false);
        vm.expectRevert(StockRoundResolver.NotPaused.selector);
        resolver.voidPaused(specId);
        token.setOraclePaused(true);
        vm.expectEmit(address(resolver));
        emit StockRoundResolver.VoidedPaused(specId, MARKET);
        resolver.voidPaused(specId);
        (uint8 status,) = _settlerState();
        assertEq(status, 2);
    }

    function test_AnUnreadablePauseFlagCountsAsPaused() public {
        token.setUnreadable(true);
        vm.expectRevert(StockRoundResolver.OraclePaused.selector);
        resolver.resolve(specId, r2, r4);
        vm.warp(F + 24 hours);
        resolver.voidPaused(specId);
    }

    // ================================================================== once only

    function test_AMarketSettlesOnce() public {
        resolver.resolve(specId, r2, r4);
        vm.expectRevert(StockRoundResolver.AlreadySettled.selector);
        resolver.resolve(specId, r2, r4);
        vm.expectRevert(StockRoundResolver.AlreadySettled.selector);
        resolver.voidStale(specId, r2, r4);
        token.setOraclePaused(true);
        vm.warp(F + 2 days);
        vm.expectRevert(StockRoundResolver.AlreadySettled.selector);
        resolver.voidPaused(specId);
        assertEq(settler.calls(), 1, "the settler was called exactly once");
    }

    function test_UnknownSpecsRevert() public {
        vm.expectRevert(StockRoundResolver.UnknownSpec.selector);
        resolver.resolve(bytes32(uint256(1)), r2, r4);
        vm.expectRevert(StockRoundResolver.UnknownSpec.selector);
        resolver.voidStale(bytes32(uint256(1)), r2, r4);
        vm.expectRevert(StockRoundResolver.UnknownSpec.selector);
        resolver.voidPaused(bytes32(uint256(1)));
    }

    // ================================================================== preview

    function test_PreviewReportsEveryStatusWithoutReverting() public {
        uint8 st;
        int256 sa;
        uint256 sat;
        int256 fa;
        uint256 fat;
        (st, sa, sat, fa, fat) = resolver.preview(specId, r2, r4);
        assertEq(st, 1, "UP");
        assertEq(sa, 181e8);
        assertEq(sat, S - 10 minutes);
        assertEq(fa, 185e8);
        assertEq(fat, F - 2 hours);
        (st,,,,) = resolver.preview(specId, r1, r4);
        assertEq(st, 5, "BADPROOF: off by one");
        (st,,,,) = resolver.preview(specId, r4, r2);
        assertEq(st, 5, "BADPROOF: final before strike");
        (st,,,,) = resolver.preview(bytes32(uint256(1)), r2, r4);
        assertEq(st, 5, "BADPROOF: unknown spec");
        (st,,,,) = resolver.preview(specId, type(uint80).max, type(uint80).max);
        assertEq(st, 5, "BADPROOF: absurd ids");

        bytes32 tight = _registerTight(30, 5 minutes, AGE);
        (st,,,,) = resolver.preview(tight, r2, r4);
        assertEq(st, 4, "STALE");

        token.setOraclePaused(true);
        (st,,,,) = resolver.preview(specId, r2, r4);
        assertEq(st, 6, "PAUSED");
        token.setOraclePaused(false);

        feed.setRound(r4, 170e8, F - 2 hours);
        (st,,,,) = resolver.preview(specId, r2, r4);
        assertEq(st, 2, "DOWN");
        feed.setRound(r4, 181e8, F - 2 hours);
        (st,,,,) = resolver.preview(specId, r2, r4);
        assertEq(st, 3, "FLAT");
        feed.setRound(r2, -5, S - 10 minutes);
        (st,,,,) = resolver.preview(specId, r2, r4);
        assertEq(st, 7, "BADANSWER: the proven strike round's answer is garbage");
        (st,,,,) = resolver.preview(specId, r1, r4);
        assertEq(st, 5, "BADPROOF: r1 is not the round in effect at the strike");
        feed.setRound(r2, 181e8, S - 10 minutes);

        vm.warp(F);
        (st,,,,) = resolver.preview(specId, r2, r4);
        assertEq(st, 0, "not ready at the bell itself");
    }

    function test_PreviewNeverRevertsEvenOnAFeedThatReverts() public {
        StockRoundResolver.Spec memory s = _spec(AGE, AGE);
        s.marketId = 31;
        s.feed = address(new RevertingFeed());
        settler.setMarket(31, address(this), address(resolver), F, 2);
        bytes32 id = resolver.register(s);
        (uint8 st,,,,) = resolver.preview(id, r2, r4);
        assertEq(st, 5);
        s.marketId = 32;
        s.feed = address(0xDEAD); // no code at all
        settler.setMarket(32, address(this), address(resolver), F, 2);
        id = resolver.register(s);
        (st,,,,) = resolver.preview(id, r2, r4);
        assertEq(st, 5);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(id, r2, r4);
    }

    // ================================================================== helpers

    function _registerOn(uint256 marketId, address feed_) internal returns (bytes32) {
        settler.setMarket(marketId, address(this), address(resolver), F, 2);
        StockRoundResolver.Spec memory s = _spec(AGE, AGE);
        s.marketId = marketId;
        s.feed = feed_;
        return resolver.register(s);
    }

    function _registerTight(uint256 marketId, uint32 strikeAge, uint32 finalAge) internal returns (bytes32) {
        settler.setMarket(marketId, address(this), address(resolver), F, 2);
        StockRoundResolver.Spec memory s = _spec(strikeAge, finalAge);
        s.marketId = marketId;
        return resolver.register(s);
    }

    function _copy(StockRoundResolver.Spec memory s) internal pure returns (StockRoundResolver.Spec memory c) {
        c = StockRoundResolver.Spec(
            s.settler, s.marketId, s.feed, s.stockToken, s.strikeTime, s.finalTime, s.maxStrikeAge, s.maxFinalAge
        );
    }
}

/// @dev A feed whose every call reverts with data, to show `preview` swallows it.
contract RevertingFeed {
    fallback() external {
        revert("broken feed");
    }
}

/// @title T5 property · the only pair that resolves is the brute-force pair
/// @notice For random round tapes (random gaps including equal timestamps, an optional phase
///         change, OCR1- or OCR2-style missing rounds) and random bells, a brute-force scan
///         finds the last round at or before each bell. `resolve` must succeed with exactly
///         that pair and revert with every other candidate: every existing round, the next
///         nonexistent id, and the first id of the next phase. The second property does the
///         same on OVERLAPPING phases (M-1), where the brute force is the resolver's rule: the
///         last round at or before T of the highest phase that has any round at or before T.
contract ResolverPropertyTest is ResolverBase {
    struct R {
        uint80 id;
        uint256 at;
    }

    /// @dev a round of the multi-phase tape: its id, updatedAt and phase
    struct PR {
        uint80 id;
        uint256 at;
        uint256 phase;
    }

    R[] internal tape;
    PR[] internal multi;

    function testFuzz_OnlyTheBruteForcePairResolves(uint256 entropy) public {
        uint256 e = entropy;
        uint256 n = 2 + _draw(e, 1, 24);
        uint256 phaseAt = _draw(e, 2, 3) == 0 ? _draw(e, 3, n) : type(uint256).max; // a third change phase
        feed.setZeroForMissing(_draw(e, 4, 2) == 0);
        uint256 t = S - 1 days;
        for (uint256 i = 0; i < n; i++) {
            if (i == phaseAt) feed.startPhase();
            t += _draw(e, 100 + i, 5) == 0 ? 0 : _draw(e, 200 + i, 4 hours); // some equal timestamps
            uint80 id = feed.addRound(int256(100e8 + _draw(e, 300 + i, 50e8)), t);
            tape.push(R(id, t));
        }
        // bells: anywhere from before the first round to after the last
        uint256 span = t - (S - 1 days) + 2 hours;
        uint64 strike = uint64(S - 1 days - 1 hours + _draw(e, 5, span));
        uint64 fin = uint64(strike + 1 + _draw(e, 6, span));
        settler.setMarket(MARKET, address(this), address(resolver), fin, 2);
        StockRoundResolver.Spec memory s = _spec(type(uint32).max, type(uint32).max);
        s.strikeTime = strike;
        s.finalTime = fin;
        bytes32 id = resolver.register(s);
        vm.warp((fin > t ? fin : t) + 1);

        (bool hasS, uint80 bs) = _brute(strike);
        (bool hasF, uint80 bf) = _brute(fin);
        uint80[] memory cands = _candidates();
        if (hasS && hasF) {
            assertTrue(_resolves(id, bs, bf), "the brute-force pair must resolve");
            for (uint256 i = 0; i < cands.length; i++) {
                if (cands[i] != bs) assertFalse(_resolves(id, cands[i], bf), "a wrong strike round resolved");
                if (cands[i] != bf) assertFalse(_resolves(id, bs, cands[i]), "a wrong final round resolved");
            }
        } else {
            // no round at or before a bell: nothing can resolve it
            for (uint256 i = 0; i < cands.length; i++) {
                for (uint256 j = 0; j < cands.length; j++) {
                    assertFalse(_resolves(id, cands[i], cands[j]), "resolved without a round in effect");
                }
            }
        }
    }

    /// @notice Up to four phases, each an aggregator with its own tape that starts anywhere in
    ///         a 30 h window, so phases overlap in time in any order (a later phase may have
    ///         printed before an earlier one), and any phase may have no rounds at all (an
    ///         aggregator the proxy skipped over, or one that has not printed yet). When the
    ///         current phase has printed, the canonical pair resolves and every other candidate
    ///         reverts, including each older phase's own "last round at or before" pair (the
    ///         M-1 attack). When it has not, nothing resolves yet.
    function testFuzz_OnlyTheCanonicalPairResolvesOnOverlappingPhases(uint256 entropy) public {
        feed.setZeroForMissing(_draw(entropy, 1, 2) == 0);
        uint256 phases = 1 + _draw(entropy, 2, 4);
        (uint256 lo, uint256 hi) = _multiTape(entropy, phases);
        uint256 span = hi - lo + 4 hours;
        uint64 strike = uint64(lo - 1 hours + _draw(entropy, 5, span));
        uint64 fin = uint64(strike + 1 + _draw(entropy, 6, span));
        settler.setMarket(MARKET, address(this), address(resolver), fin, 2);
        StockRoundResolver.Spec memory s = _spec(type(uint32).max, type(uint32).max);
        s.strikeTime = strike;
        s.finalTime = fin;
        bytes32 id = resolver.register(s);
        vm.warp((fin > hi ? fin : hi) + 1);
        _checkMulti(id, phases, strike, fin);
    }

    /// @dev Phase p's aggregator: 0..8 rounds (0 = it never printed) from a random start.
    function _multiTape(uint256 e, uint256 phases) internal returns (uint256 lo, uint256 hi) {
        lo = S - 1 days;
        hi = lo;
        for (uint256 p = 1; p <= phases; p++) {
            if (p > 1) feed.startPhase();
            uint256 last = _phaseTape(e, p, lo + _draw(e, 20 + p, 30 hours));
            if (last > hi) hi = last;
        }
    }

    function _phaseTape(uint256 e, uint256 p, uint256 t) internal returns (uint256) {
        uint256 n = _draw(e, 10 + p, 9);
        for (uint256 i = 0; i < n; i++) {
            uint256 salt = 100 * p + i;
            t += _draw(e, 1_000 + salt, 4) == 0 ? 0 : _draw(e, 2_000 + salt, 3 hours);
            multi.push(PR(feed.addRound(int256(100e8 + _draw(e, 3_000 + salt, 50e8)), t), t, p));
        }
        return t;
    }

    function _checkMulti(bytes32 id, uint256 phases, uint64 strike, uint64 fin) internal {
        (bool hasS, uint80 bs) = _canonical(strike);
        (bool hasF, uint80 bf) = _canonical(fin);
        uint80[] memory cands = _multiCandidates(phases);
        if (!(hasS && hasF)) {
            for (uint256 i = 0; i < cands.length; i++) {
                for (uint256 j = 0; j < cands.length; j++) {
                    assertFalse(_resolves(id, cands[i], cands[j]), "resolved without a round in effect");
                }
            }
            return;
        }
        bool printed = feed.phaseRounds(uint16(phases)) > 0; // the proxy's current phase
        assertEq(_resolves(id, bs, bf), printed, "the canonical pair resolves once the current phase printed");
        for (uint256 i = 0; i < cands.length; i++) {
            if (cands[i] != bs) assertFalse(_resolves(id, cands[i], bf), "a wrong strike round resolved");
            if (cands[i] != bf) assertFalse(_resolves(id, bs, cands[i]), "a wrong final round resolved");
        }
        _checkPhasePairs(id, phases, strike, fin, bs, bf);
    }

    /// @dev Each phase's own "last round at or before" pair: what an overlap used to let a
    ///      caller pick. Only the canonical one may resolve.
    function _checkPhasePairs(bytes32 id, uint256 phases, uint64 strike, uint64 fin, uint80 bs, uint80 bf) internal {
        for (uint256 q = 1; q <= phases; q++) {
            (bool okS, uint80 qs) = _lastInPhase(q, strike);
            (bool okF, uint80 qf) = _lastInPhase(q, fin);
            if (okS && okF && (qs != bs || qf != bf)) {
                assertFalse(_resolves(id, qs, qf), "an older phase's pair resolved");
            }
        }
    }

    /// @dev The resolver's rule by brute force: among rounds with updatedAt ≤ t, the highest
    ///      phase; within it, the last round (id order is time order inside a phase).
    function _canonical(uint256 t) internal view returns (bool found, uint80 id) {
        uint256 best;
        for (uint256 i = 0; i < multi.length; i++) {
            if (multi[i].at <= t && (multi[i].phase > best || (multi[i].phase == best && multi[i].id > id))) {
                found = true;
                best = multi[i].phase;
                id = multi[i].id;
            }
        }
    }

    function _lastInPhase(uint256 phase, uint256 t) internal view returns (bool found, uint80 id) {
        for (uint256 i = 0; i < multi.length; i++) {
            if (multi[i].phase == phase && multi[i].at <= t && multi[i].id > id) {
                found = true;
                id = multi[i].id;
            }
        }
    }

    /// @dev Every round, the id after each phase's last round (or its round 1 if it has none),
    ///      the first id of the phase above the current one, and round 0 of phase 1.
    function _multiCandidates(uint256 phases) internal view returns (uint80[] memory c) {
        c = new uint80[](multi.length + phases + 2);
        for (uint256 i = 0; i < multi.length; i++) {
            c[i] = multi[i].id;
        }
        for (uint256 p = 1; p <= phases; p++) {
            c[multi.length + p - 1] = feed.roundId(uint16(p), feed.phaseRounds(uint16(p)) + 1);
        }
        c[multi.length + phases] = feed.roundId(uint16(phases + 1), 1);
        c[multi.length + phases + 1] = feed.roundId(1, 0);
    }

    /// @dev The last round (in id order, which is time order) with updatedAt ≤ t.
    function _brute(uint256 t) internal view returns (bool found, uint80 id) {
        for (uint256 i = 0; i < tape.length; i++) {
            if (tape[i].at <= t) {
                found = true;
                id = tape[i].id;
            }
        }
    }

    function _candidates() internal view returns (uint80[] memory c) {
        c = new uint80[](tape.length + 3);
        for (uint256 i = 0; i < tape.length; i++) {
            c[i] = tape[i].id;
        }
        uint80 last = tape[tape.length - 1].id;
        c[tape.length] = last + 1; // does not exist
        c[tape.length + 1] = feed.roundId(feed.phaseId() + 1, 1); // a phase that does not exist
        c[tape.length + 2] = feed.roundId(1, 0); // round 0 of phase 1: never a real round
    }

    function _draw(uint256 e, uint256 salt, uint256 modulo) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(e, salt))) % modulo;
    }
}
