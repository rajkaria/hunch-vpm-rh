// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HunchVPM} from "../src/HunchVPM.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {HunchMarketFactory} from "../src/HunchMarketFactory.sol";
import {IERC20Like} from "../src/interfaces/IERC20Like.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockSettler} from "../src/mocks/MockSettler.sol";

/// @title M-1 · Overlapping feed phases: exactly one pair of rounds proves, whoever calls
/// @notice When Chainlink moves a feed to a new aggregator, the new one is already reporting
///         before the proxy confirms it (it is proposed with live data) and the old one keeps
///         its rounds, often printing for a while longer. After the switch the proxy serves
///         both histories, as phase p and phase p + 1, and for a bell inside the overlap both
///         phases have a "last round at or before T". The independent review (2026-09-28, M-1)
///         showed that the resolver accepted either, so the caller could choose the outcome
///         (flip UP to DOWN) or void a good market as FLAT.
///
///         The resolver now takes the round in effect at T in the HIGHEST phase that has any
///         round at or before T, and checks every phase above the round's own up to the
///         proxy's current phase. These tests turn the reviewer's proofs of concept into
///         permanent checks, with honest 0.5%-deviation tapes of the same price:
///           * the outcome-flip pair and the FLAT-void pair revert, and so does every other
///             candidate pair; exactly one pair proves, and it resolves;
///           * three overlapping phases (a middle aggregator that printed only after the bell,
///             or never), which a check of phase p + 1 alone would not catch;
///           * the span bound, and `preview` agreeing with `resolve` on every pair.
contract PhaseOverlapTest is Test {
    uint64 internal constant S = 1_790_688_600; // Tue 2026-09-29 09:30 ET (strike)
    uint64 internal constant F = 1_790_712_000; // Tue 2026-09-29 16:00 ET (final = freeze)
    uint32 internal constant AGE = 26 hours;

    struct Print {
        int256 answer;
        uint256 at;
    }

    StockRoundResolver internal resolver;
    MockSettler internal settler;
    MockStockToken internal stock;
    MockAggregator internal feed;
    uint256 internal nextMarket = 100;

    /// @dev prints of an aggregator the proxy does not serve yet (proposed, not confirmed)
    Print[] internal pending;

    error Succeeded();

    function setUp() public {
        vm.warp(S - 7 hours);
        vm.roll(23_000_000);
        resolver = new StockRoundResolver();
        settler = new MockSettler();
        stock = new MockStockToken("XYZ");
        feed = new MockAggregator("XYZ / USD proxy");
    }

    // ================================================================== the reviewer's tapes

    /// @dev The flip tape (AuditPhaseOverlap). Old aggregator (phase 1): 100.00 at S-1h, 100.50
    ///      at S+1h, 99.89 at S+3h, 100.39 at F-1h, 100.90 at F+30m. New aggregator (proposed,
    ///      confirmed at F+1h as phase 2): 99.90 at S-3h, 100.40 at S-5m, 99.89 at S+3h+10s,
    ///      100.39 at F-1h+10s, 100.90 at F+30m+10s. The old tape says UP (100.00 -> 100.39),
    ///      the new one DOWN (100.40 -> 100.39).
    function _flipTapeOldPhase() internal returns (uint80 oS, uint80 oF) {
        _newPrint(S - 3 hours, 99.9e8);
        oS = _oldPrint(S - 1 hours, 100.0e8);
        _newPrint(S - 5 minutes, 100.4e8);
        _oldPrint(S + 1 hours, 100.5e8);
        _oldPrint(S + 3 hours, 99.89e8);
        _newPrint(S + 3 hours + 10, 99.89e8);
        oF = _oldPrint(F - 1 hours, 100.39e8);
        _newPrint(F - 1 hours + 10, 100.39e8);
        _oldPrint(F + 30 minutes, 100.9e8);
        _newPrint(F + 30 minutes + 10, 100.9e8);
    }

    /// @notice The reviewer's flip, now: after the confirmation exactly one pair proves (the
    ///         new aggregator's, DOWN), and the UP bettor's old-phase pair reverts
    ///         `PhaseBoundary`, as does the mixed pair.
    function test_TheOutcomeFlipPairRevertsAndOnlyTheCanonicalPairProves() public {
        (uint80 oS, uint80 oF) = _flipTapeOldPhase();
        vm.warp(F + 1 hours);
        uint80[] memory n = _confirm();
        (uint80 nS, uint80 nF) = (n[1], n[3]);
        vm.warp(F + 1 hours + 1 minutes);
        bytes32 id = _register(AGE, AGE);

        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, oS, oF); // the UP bettor's pair: phase 2 had rounds before both bells
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, oS, nF); // mixed: the strike round is not the one in effect
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(id, nS, oF); // final before strike in id order

        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1, "exactly one pair proves");
        assertEq(abi.encode(s, f), abi.encode(nS, nF), "the highest phase with a round at or before each bell");
        (uint8 st,,,,) = resolver.preview(id, nS, nF);
        assertEq(st, resolver.STATUS_DOWN());
        resolver.resolve(id, nS, nF);
        (,,,, uint8 status, uint8 winner) = settler.markets(nextMarket - 1);
        assertEq(abi.encode(status, winner), abi.encode(uint8(1), uint8(1)), "resolved DOWN");
    }

    /// @notice Before the confirmation the proxy serves only the old aggregator, and exactly one
    ///         pair proves: the old one (UP). The confirmation after the bell brings rounds
    ///         written before the bell into view, so from that moment the new pair is the one
    ///         in effect; the first settlement is final. (The keeper resolves about a minute
    ///         after the bell; a migration that close to a bell is the accepted residual.)
    function test_AConfirmationAfterTheBellMovesTheProvenPairAndTheFirstSettlementIsFinal() public {
        (uint80 oS, uint80 oF) = _flipTapeOldPhase();
        vm.warp(F + 1 minutes);
        bytes32 id = _register(AGE, AGE);
        bytes32 twin = _register(AGE, AGE); // the same spec on a second market, left open
        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1);
        assertEq(abi.encode(s, f), abi.encode(oS, oF), "before the confirmation: the old aggregator's pair");
        resolver.resolve(id, oS, oF); // UP
        (,,,, uint8 status, uint8 winner) = settler.markets(nextMarket - 2);
        assertEq(abi.encode(status, winner), abi.encode(uint8(1), uint8(0)), "resolved UP");

        vm.warp(F + 1 hours);
        uint80[] memory n = _confirm();
        vm.warp(F + 1 hours + 1 minutes);
        (count, s, f) = _provable(twin);
        assertEq(count, 1, "still exactly one pair");
        assertEq(abi.encode(s, f), abi.encode(n[1], n[3]), "now the new aggregator's pair");
        vm.expectRevert(StockRoundResolver.AlreadySettled.selector);
        resolver.resolve(id, n[1], n[3]);
    }

    /// @notice The reviewer's full flow with the real contracts: a market listed by the factory,
    ///         two bets, the migration, and a loser who tries the pair he likes. It reverts; the
    ///         one proven pair settles the market and the right side is paid.
    function test_EndToEndTheLoserCannotPickThePhase() public {
        MockUSDG usdg = new MockUSDG();
        address safe = makeAddr("safe");
        HunchVPM vpm = new HunchVPM(safe, safe);
        StockRoundResolver res = new StockRoundResolver();
        HunchMarketFactory factory = new HunchMarketFactory(vpm, res, IERC20Like(address(usdg)), safe, safe);
        vm.startPrank(safe);
        factory.setFeed(address(feed), address(stock), "XYZ", AGE, AGE, true);
        factory.setOpener(address(this), true);
        vm.stopPrank();
        usdg.mint(address(this), 20e6);
        usdg.approve(address(factory), type(uint256).max);
        (uint256 mid, bytes32 specId) = factory.openUpDown(
            HunchMarketFactory.UpDown({
                feed: address(feed),
                strikeTime: S,
                finalTime: F,
                maxStrikeAge: 0,
                maxFinalAge: 0,
                seedPerLeg: 10e6,
                minEntry: 1e6,
                maxEntry: 100e6
            })
        );
        address up = makeAddr("up bettor");
        address down = makeAddr("down bettor");
        _bet(vpm, usdg, down, mid, 1, 100e6);
        _bet(vpm, usdg, up, mid, 0, 100e6);

        (uint80 oS, uint80 oF) = _flipTapeOldPhase();
        vm.warp(F + 1 hours);
        uint80[] memory n = _confirm();
        vm.warp(F + 1 hours + 1 minutes);

        vm.prank(up); // the old tape says UP: the UP bettor tries it
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        res.resolve(specId, oS, oF);
        vm.prank(up);
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        res.voidStale(specId, oS, oF);

        vm.prank(down);
        res.resolve(specId, n[1], n[3]);
        (,,,,,,, HunchVPM.Status status, uint8 winner,,,) = vpm.getMarket(mid);
        assertEq(uint8(status), 1);
        assertEq(winner, 1, "DOWN, per the aggregator in effect at both bells");
        uint256[] memory all = vpm.marketPositions(mid, 0, 100);
        for (uint256 i = 0; i < all.length; i++) {
            vpm.claimFor(all[i]);
        }
        assertEq(usdg.balanceOf(up), 0);
        assertGt(usdg.balanceOf(down), 189e6);
    }

    /// @notice The FLAT-void attempt: the old aggregator did not print between the bells (its
    ///         one round would make the market FLAT and refund everyone) while the new one did
    ///         (UP). The old single-round pair, and `voidStale` with it, revert; the new pair
    ///         resolves UP.
    function test_TheFlatVoidPairReverts() public {
        uint80 oS = _oldPrint(S - 1 hours, 100.0e8);
        _newPrint(S - 3 hours, 99.9e8);
        _newPrint(S - 5 minutes, 100.4e8);
        _newPrint(S + 2 hours, 100.91e8);
        _oldPrint(F + 30 minutes, 101.01e8); // the old aggregator's next print is after the bell
        _newPrint(F + 30 minutes + 10, 101.01e8);
        vm.warp(F + 1 hours);
        uint80[] memory n = _confirm();
        vm.warp(F + 1 hours + 1 minutes);
        bytes32 id = _register(AGE, AGE);
        bytes32 tight = _register(AGE, 1 hours); // the old round is 7 h old at the bell

        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, oS, oS); // would be FLAT: void, everyone refunded
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.voidStale(tight, oS, oS); // would void as stale

        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1);
        assertEq(abi.encode(s, f), abi.encode(n[1], n[2]));
        resolver.resolve(id, n[1], n[2]);
        (,,,, uint8 status, uint8 winner) = settler.markets(nextMarket - 2);
        assertEq(abi.encode(status, winner), abi.encode(uint8(1), uint8(0)), "resolved UP");
    }

    /// @notice The reviewer's second tape under the rule: the new aggregator printed before the
    ///         strike and not again until after the close, so one round is in effect at both
    ///         bells and the market is FLAT (void). That is the rule's answer, not the caller's
    ///         choice: it is the only pair that proves.
    function test_WhenTheNewestAggregatorWasQuietTheOnlyProvenPairIsFlat() public {
        _newPrint(S - 3 hours, 99.9e8);
        _oldPrint(S - 1 hours, 100.0e8);
        _newPrint(S - 5 minutes, 100.4e8);
        _oldPrint(S + 2 hours, 100.5e8);
        _oldPrint(F + 30 minutes, 101.01e8);
        _newPrint(F + 30 minutes + 10, 101.01e8);
        vm.warp(F + 1 hours);
        uint80[] memory n = _confirm();
        vm.warp(F + 1 hours + 1 minutes);
        bytes32 id = _register(AGE, AGE);
        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1);
        assertEq(abi.encode(s, f), abi.encode(n[1], n[1]));
        (uint8 st,,,,) = resolver.preview(id, n[1], n[1]);
        assertEq(st, resolver.STATUS_FLAT());
    }

    // ================================================================== three phases

    /// @notice Phase 1 (old) keeps printing through the day; phase 2 was confirmed but printed
    ///         only after the close; phase 3 was reporting since before the open. The round in
    ///         effect is phase 3's. Checking only phase p + 1 would accept phase 1's pair too
    ///         (phase 2's first round is after both bells); the resolver checks every phase up
    ///         to the current one.
    function test_ThreeOverlappingPhasesStillProveExactlyOnePair() public {
        feed.addRound(100.0e8, S - 2 hours); // phase 1
        feed.addRound(100.6e8, S + 2 hours);
        feed.addRound(99.9e8, F - 30 minutes);
        feed.addRound(100.4e8, F + 20 minutes);
        feed.startPhase(); // phase 2: first print after the close
        feed.addRound(100.45e8, F + 40 minutes);
        feed.startPhase(); // phase 3: printing since before the open
        uint80 s3 = feed.addRound(100.2e8, S - 1 hours);
        uint80 f3 = feed.addRound(100.8e8, S + 4 hours);
        feed.addRound(100.3e8, F + 45 minutes);
        vm.warp(F + 1 hours);
        bytes32 id = _register(AGE, AGE);

        (uint80 p1S, uint80 p1F) = (feed.roundId(1, 1), feed.roundId(1, 3));
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, p1S, p1F); // phase 1's own "last at or before" pair: DOWN
        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1);
        assertEq(abi.encode(s, f), abi.encode(s3, f3));
        resolver.resolve(id, s3, f3);
        (,,,, uint8 status, uint8 winner) = settler.markets(nextMarket - 1);
        assertEq(abi.encode(status, winner), abi.encode(uint8(1), uint8(0)), "UP per phase 3");
    }

    /// @notice The same with a middle aggregator that never printed at all (the proxy skipped
    ///         over it): phase 3's pair is the only one.
    function test_ASkippedAggregatorDoesNotReopenAnOlderPhase() public {
        uint80 a = feed.addRound(100.0e8, S - 2 hours); // phase 1
        feed.addRound(100.6e8, F - 1 hours);
        uint80 b = feed.roundId(1, 2);
        feed.addRound(100.9e8, F + 10 minutes);
        feed.startPhase(); // phase 2: nothing, ever
        feed.startPhase(); // phase 3
        uint80 s3 = feed.addRound(100.1e8, S - 30 minutes);
        uint80 f3 = feed.addRound(99.5e8, F - 45 minutes);
        feed.addRound(99.7e8, F + 30 minutes);
        vm.warp(F + 1 hours);
        bytes32 id = _register(AGE, AGE);
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, a, b);
        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1);
        assertEq(abi.encode(s, f), abi.encode(s3, f3));
    }

    /// @notice An old phase whose aggregator stopped before the bell, with later phases that
    ///         only printed after it: the old phase's last round is the one in effect, proven
    ///         across every later phase (the migration-after-the-bell case, F5).
    function test_AnOldPhasesLastRoundProvesAcrossLaterPhasesThatPrintedAfterTheBell() public {
        uint80 s1 = feed.addRound(100.0e8, S - 2 hours);
        uint80 f1 = feed.addRound(101.0e8, F - 2 hours); // phase 1 stops here
        feed.startPhase();
        feed.addRound(101.2e8, F + 10 minutes);
        feed.startPhase();
        feed.addRound(101.3e8, F + 20 minutes);
        vm.warp(F + 1 hours);
        bytes32 id = _register(AGE, AGE);
        (uint256 count, uint80 s, uint80 f) = _provable(id);
        assertEq(count, 1);
        assertEq(abi.encode(s, f), abi.encode(s1, f1));
    }

    // ================================================================== the span bound

    /// @notice A round up to MAX_PHASE_SPAN phases below the current one proves; one more and it
    ///         is refused with `PhaseBoundary` (bounded reads). `preview` reports BADPROOF and
    ///         never reverts.
    function test_TheSpanBoundRefusesARoundTooManyPhasesDown() public {
        uint256 span = resolver.MAX_PHASE_SPAN();
        assertEq(span, 8);
        uint80 s1 = feed.addRound(100.0e8, S - 2 hours);
        uint80 f1 = feed.addRound(101.0e8, F - 2 hours);
        for (uint256 i = 0; i < span; i++) {
            feed.startPhase();
            feed.addRound(int256(102e8 + i * 1e8), F + 10 minutes + i);
        }
        vm.warp(F + 1 hours);
        bytes32 id = _register(AGE, AGE);
        (uint8 st,,,,) = resolver.preview(id, s1, f1);
        assertEq(st, resolver.STATUS_UP(), "exactly MAX_PHASE_SPAN phases above: proven");

        feed.startPhase();
        feed.addRound(111e8, F + 30 minutes);
        (st,,,,) = resolver.preview(id, s1, f1);
        assertEq(st, resolver.STATUS_BAD_PROOF(), "one phase more: refused");
        vm.expectRevert(StockRoundResolver.PhaseBoundary.selector);
        resolver.resolve(id, s1, f1);
    }

    /// @notice A round claimed in a phase above the proxy's current one, or read while the
    ///         proxy's latest round is unreadable, proves nothing.
    function test_ARoundAboveTheCurrentPhaseOrAnUnreadableProxyProvesNothing() public {
        uint80 s1 = feed.addRound(100.0e8, S - 2 hours);
        uint80 f1 = feed.addRound(101.0e8, F - 2 hours);
        feed.addRound(101.5e8, F + 10 minutes);
        uint80 ghost = feed.roundId(2, 1);
        feed.setRound(ghost, 99e8, F - 1 hours); // readable, but phase 2 is not the proxy's
        vm.warp(F + 1 hours);
        bytes32 id = _register(AGE, AGE);
        vm.expectRevert(StockRoundResolver.BadProof.selector);
        resolver.resolve(id, s1, ghost);
        assertTrue(_resolves(id, s1, f1), "phase 1 is current: its pair proves");

        feed.startPhase(); // the proxy moves to phase 2; latestRoundData reverts until it prints
        (uint8 st,,,,) = resolver.preview(id, s1, f1);
        assertEq(st, resolver.STATUS_BAD_PROOF(), "pending until the current phase prints");
        assertFalse(_resolves(id, s1, f1));
    }

    // ================================================================== helpers

    function _oldPrint(uint256 at, int256 answer) internal returns (uint80) {
        vm.warp(at);
        return feed.addRound(answer, at);
    }

    function _newPrint(uint256 at, int256 answer) internal {
        vm.warp(at);
        pending.push(Print({answer: answer, at: at}));
    }

    /// @dev `confirmAggregator`: the proxy serves the proposed aggregator as the next phase,
    ///      whose rounds 1..k are the prints it made while it was only proposed.
    function _confirm() internal returns (uint80[] memory ids) {
        feed.startPhase();
        ids = new uint80[](pending.length);
        for (uint256 i = 0; i < pending.length; i++) {
            ids[i] = feed.addRound(pending[i].answer, pending[i].at);
        }
        delete pending;
    }

    function _register(uint32 strikeAge, uint32 finalAge) internal returns (bytes32) {
        uint256 id = nextMarket++;
        settler.setMarket(id, address(this), address(resolver), F, 2);
        return resolver.register(
            StockRoundResolver.Spec({
                settler: address(settler),
                marketId: id,
                feed: address(feed),
                stockToken: address(stock),
                strikeTime: S,
                finalTime: F,
                maxStrikeAge: strikeAge,
                maxFinalAge: finalAge
            })
        );
    }

    function _bet(HunchVPM vpm, MockUSDG usdg, address who, uint256 id, uint8 outcome, uint256 amount) internal {
        vm.roll(block.number + 1);
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(vpm), amount);
        vpm.enter(id, outcome, amount);
        vm.stopPrank();
    }

    /// @dev Every round id of every phase up to the current one, plus the id after each phase's
    ///      last round, the first id of the next phase, and round 0 of phase 1.
    function _candidates() internal view returns (uint80[] memory c) {
        uint16 phases = feed.phaseId();
        uint256 total = 2;
        for (uint16 p = 1; p <= phases; p++) {
            total += feed.phaseRounds(p) + 1;
        }
        c = new uint80[](total);
        uint256 k;
        for (uint16 p = 1; p <= phases; p++) {
            uint64 rounds = feed.phaseRounds(p);
            for (uint64 r = 1; r <= rounds + 1; r++) {
                c[k++] = feed.roundId(p, r);
            }
        }
        c[k++] = feed.roundId(phases + 1, 1);
        c[k++] = feed.roundId(1, 0);
    }

    /// @dev How many candidate pairs `resolve` accepts (each attempt rolled back), and the last
    ///      one; also checks that `preview` agrees with `resolve` on every pair.
    function _provable(bytes32 specId) internal returns (uint256 count, uint80 s, uint80 f) {
        uint80[] memory c = _candidates();
        for (uint256 i = 0; i < c.length; i++) {
            for (uint256 j = 0; j < c.length; j++) {
                bool ok = _resolves(specId, c[i], c[j]);
                (uint8 st,,,,) = resolver.preview(specId, c[i], c[j]);
                assertEq(ok, st >= 1 && st <= 3, "preview agrees with resolve");
                if (ok) {
                    count++;
                    (s, f) = (c[i], c[j]);
                }
            }
        }
    }

    /// @dev Resolve and roll back, reporting success.
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
}
