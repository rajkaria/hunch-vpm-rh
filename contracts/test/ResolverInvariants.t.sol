// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockSettler} from "../src/mocks/MockSettler.sol";

/// @notice A live feed as time passes: rounds are written at the current block time (as
///         Chainlink's are). Chainlink also moves the feed to new aggregators, and the
///         aggregators overlap in time (M-1): the next aggregator reports while it is only
///         proposed, the proxy then confirms it (its earlier prints appear as the new phase's
///         first rounds, with their original timestamps), and old aggregators may keep printing
///         after the switch. After the bell anyone tries to resolve with any pair of round ids,
///         including each older phase's own "last round at or before" pair. Every attempt is
///         rolled back, so the market stays open and the campaign keeps probing.
contract ResolverHandler is Test {
    StockRoundResolver public immutable resolver;
    MockAggregator public immutable feed;
    MockSettler public immutable settler;
    bytes32 public immutable specId;
    uint64 public immutable strikeTime;
    uint64 public immutable finalTime;

    /// @notice at most this many phases, so a proof never meets the resolver's span bound
    uint16 public constant MAX_PHASES = 6;

    struct Print {
        int256 answer;
        uint256 at;
    }

    /// @dev every round the proxy serves, in the order written (phases interleave)
    uint80[] public ids;
    uint256[] public ats;
    /// @dev prints of the proposed (not yet confirmed) aggregator
    Print[] internal proposed;
    /// @dev rounds written per phase (the mock counts only the current phase's)
    mapping(uint256 => uint64) public roundsIn;

    uint256 public attempts;
    uint256 public successes;
    uint256 public wrongPairAccepted; // INV-7 violation
    uint256 public rightPairRejected; // liveness violation
    uint256 public olderPhasePairsTried; // M-1 attack pairs attempted (all must fail)
    uint256 public overlapSwitches; // confirmations that brought earlier prints into view

    error Succeeded();

    constructor() {
        resolver = new StockRoundResolver();
        feed = new MockAggregator("Robinhood TSLA / USD");
        MockStockToken token = new MockStockToken("TSLA");
        settler = new MockSettler();
        strikeTime = uint64(block.timestamp + 2 hours);
        finalTime = uint64(block.timestamp + 10 hours);
        settler.setMarket(1, address(this), address(resolver), finalTime, 2);
        specId = resolver.register(
            StockRoundResolver.Spec({
                settler: address(settler),
                marketId: 1,
                feed: address(feed),
                stockToken: address(token),
                strikeTime: strikeTime,
                finalTime: finalTime,
                maxStrikeAge: type(uint32).max,
                maxFinalAge: type(uint32).max
            })
        );
    }

    /// @notice Time passes and, usually, the current aggregator prints (deviation or heartbeat).
    function tick(uint256 dt, uint256 price, bool print) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 hours));
        if (!print) return;
        uint256 phase = feed.phaseId();
        _record(feed.addRound(int256(bound(price, 1e8, 1e12)), block.timestamp), phase, block.timestamp);
    }

    /// @notice The next aggregator, proposed but not confirmed, prints now: the proxy does not
    ///         serve it yet.
    function proposedTick(uint256 price) external {
        proposed.push(Print(int256(bound(price, 1e8, 1e12)), block.timestamp));
    }

    /// @notice An older aggregator (one or two phases back) keeps printing after the switch.
    function oldTick(uint256 price, uint8 back) external {
        uint256 current = feed.phaseId();
        uint256 depth = 1 + (back % 2);
        if (current <= depth) return;
        uint256 phase = current - depth;
        uint80 rid = feed.roundId(uint16(phase), roundsIn[phase] + 1);
        feed.setRound(rid, int256(bound(price, 1e8, 1e12)), block.timestamp);
        _record(rid, phase, block.timestamp);
    }

    /// @notice The proxy confirms the proposed aggregator (rare): a new phase whose first
    ///         rounds are the prints it made while proposed (none, if it never printed).
    function newPhase(uint8 gate) external {
        if (gate % 8 != 0 || feed.phaseId() >= MAX_PHASES) return;
        uint256 phase = feed.startPhase();
        if (proposed.length > 0) overlapSwitches++;
        for (uint256 i = 0; i < proposed.length; i++) {
            _record(feed.addRound(proposed[i].answer, proposed[i].at), phase, proposed[i].at);
        }
        delete proposed;
    }

    /// @notice After the bell, try a pair: the right one, one near it, anything, nonsense, or
    ///         an older phase's own "last round at or before" pair (the M-1 attack).
    function tryPair(uint256 i, uint256 j, uint8 mode) external {
        if (block.timestamp <= finalTime || ids.length == 0) return;
        (bool hasS, uint80 bs) = _canonical(strikeTime);
        (bool hasF, uint80 bf) = _canonical(finalTime);
        uint80 s;
        uint80 f;
        mode = mode % 4;
        if (mode == 0 && hasS && hasF) {
            (s, f) = (bs, bf); // the right pair
        } else if (mode == 1 && hasS && hasF) {
            // one neighbour off on one side
            s = _near(bs, i);
            f = _near(bf, j);
        } else if (mode == 3) {
            uint256 phase = 1 + (j % feed.phaseId());
            (bool okS, uint80 qs) = _lastInPhase(phase, strikeTime);
            (bool okF, uint80 qf) = _lastInPhase(phase, finalTime);
            if (!okS || !okF || (qs == bs && qf == bf)) return;
            (s, f) = (qs, qf);
            olderPhasePairsTried++;
        } else {
            s = i % 5 == 0 ? uint80(i) : ids[i % ids.length];
            f = j % 5 == 0 ? uint80(j) : ids[j % ids.length];
        }
        bool right = hasS && hasF && s == bs && f == bf;
        attempts++;
        bool ok;
        try this.attempt(s, f) {}
        catch (bytes memory err) {
            ok = bytes4(err) == Succeeded.selector;
        }
        if (ok) successes++;
        if (ok && !right) wrongPairAccepted++;
        // Liveness is owed only once the proxy's current phase has printed: right after an
        // aggregator switch, before the new aggregator's first round, the proxy's latest round
        // is unreadable and every proof waits (documented in SECURITY.md and pinned by
        // test_ANewPhaseWithNoRoundsDelaysResolutionUntilItPrints).
        if (!ok && right && feed.phaseRounds(feed.phaseId()) > 0) rightPairRejected++;
    }

    function attempt(uint80 s, uint80 f) external {
        require(msg.sender == address(this));
        resolver.resolve(specId, s, f);
        revert Succeeded();
    }

    function _record(uint80 rid, uint256 phase, uint256 at) internal {
        ids.push(rid);
        ats.push(at);
        roundsIn[phase] = uint64(rid); // ids are written in order within a phase
    }

    /// @dev a round id one before, at, or one after `x` in its own phase
    function _near(uint80 x, uint256 r) internal pure returns (uint80) {
        uint256 d = r % 3;
        if (d == 0) return x - 1; // round 0 of a phase never exists
        if (d == 2) return x + 1;
        return x;
    }

    /// @dev The resolver's rule by brute force over the tape the proxy serves now: among
    ///      rounds with updatedAt ≤ t, the highest phase; within it, the last round.
    function _canonical(uint256 t) internal view returns (bool found, uint80 id) {
        for (uint256 x = 0; x < ids.length; x++) {
            if (ats[x] <= t && (!found || ids[x] >> 64 > id >> 64 || (ids[x] >> 64 == id >> 64 && ids[x] > id))) {
                found = true;
                id = ids[x];
            }
        }
    }

    function _lastInPhase(uint256 phase, uint256 t) internal view returns (bool found, uint80 id) {
        for (uint256 x = 0; x < ids.length; x++) {
            if (ids[x] >> 64 == phase && ats[x] <= t && ids[x] > id) {
                found = true;
                id = ids[x];
            }
        }
    }

    function tapeLength() external view returns (uint256) {
        return ids.length;
    }
}

/// @title INV-7 · Resolver soundness (docs/spec/03-contracts.md)
/// @notice `resolve` succeeds only with the unique pair in effect at the bells (the last round
///         at or before T of the highest phase with any round at or before T), and on a tape
///         whose current phase has printed that pair always succeeds.
contract ResolverInvariantsTest is StdInvariant, Test {
    ResolverHandler internal h;

    function setUp() public {
        vm.warp(1_790_000_000);
        h = new ResolverHandler();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ResolverHandler.tick.selector;
        selectors[1] = ResolverHandler.newPhase.selector;
        selectors[2] = ResolverHandler.tryPair.selector;
        selectors[3] = ResolverHandler.proposedTick.selector;
        selectors[4] = ResolverHandler.oldTick.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    function invariant_INV7_OnlyTheProvenPairResolves() public view {
        assertEq(h.wrongPairAccepted(), 0, "INV-7: a pair other than the rounds in effect at the bells resolved");
    }

    function invariant_INV7_TheProvenPairAlwaysResolves() public view {
        assertEq(h.rightPairRejected(), 0, "INV-7: the proven pair was refused");
    }

    /// @notice The campaign is not vacuous: a scripted pass prints across both bells, changes
    ///         phase, and lands both refusals and the one success.
    function test_TheResolverHandlerIsNotVacuous() public {
        for (uint256 i = 0; i < 12; i++) {
            h.tick(55 minutes, 180e8 + i * 1e8, i % 4 != 3);
            if (i == 5) h.newPhase(0);
        }
        for (uint256 i = 0; i < 30; i++) {
            h.tryPair(i * 7, i * 13, uint8(i));
        }
        assertGt(h.tapeLength(), 5);
        assertGt(h.successes(), 0, "the right pair resolved");
        assertGt(h.attempts() - h.successes(), 0, "wrong pairs were refused");
        invariant_INV7_OnlyTheProvenPairResolves();
        invariant_INV7_TheProvenPairAlwaysResolves();
    }

    /// @notice ... and it reaches the M-1 overlap: the next aggregator reports before the
    ///         strike while the old one keeps the proxy, the old one keeps printing after the
    ///         switch, and each phase's own pair is tried. Only the pair in effect resolves.
    function test_TheOverlapIsExercised() public {
        h.proposedTick(99.9e8);
        h.tick(1 hours, 100e8, true); // old aggregator, before the strike (at +2 h)
        h.proposedTick(100.4e8);
        h.tick(2 hours, 100.5e8, true); // old, after the strike
        h.proposedTick(99.9e8);
        h.tick(3 hours, 100.4e8, true); // old, before the close (at +10 h)
        h.tick(3 hours, 0, false);
        h.proposedTick(100.4e8);
        h.tick(2 hours, 100.9e8, true); // after the close
        h.newPhase(0); // confirmed after the close, with its earlier prints
        h.oldTick(101e8, 0); // the old aggregator prints once more
        h.tick(1 minutes, 101e8, true);
        for (uint256 i = 0; i < 24; i++) {
            h.tryPair(i, i + 1, uint8(i));
        }
        assertEq(h.overlapSwitches(), 1);
        assertGt(h.olderPhasePairsTried(), 0, "the old phase's own pair was tried");
        assertGt(h.successes(), 0, "the pair in effect resolved");
        invariant_INV7_OnlyTheProvenPairResolves();
        invariant_INV7_TheProvenPairAlwaysResolves();
    }
}
