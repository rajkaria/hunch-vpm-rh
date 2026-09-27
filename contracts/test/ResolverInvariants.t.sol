// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";
import {MockSettler} from "../src/mocks/MockSettler.sol";

/// @notice A live feed as time passes: rounds are written at the current block time (as
///         Chainlink's are), the proxy sometimes moves to a new phase, and after the bell
///         anyone tries to resolve with any pair of round ids. Every attempt is rolled back, so
///         the market stays open and the campaign keeps probing.
contract ResolverHandler is Test {
    StockRoundResolver public immutable resolver;
    MockAggregator public immutable feed;
    MockSettler public immutable settler;
    bytes32 public immutable specId;
    uint64 public immutable strikeTime;
    uint64 public immutable finalTime;

    uint80[] public ids;
    uint256[] public ats;

    uint256 public attempts;
    uint256 public successes;
    uint256 public wrongPairAccepted; // INV-7 violation
    uint256 public rightPairRejected; // liveness violation on a clean tape

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

    /// @notice Time passes and, usually, the feed prints (deviation or heartbeat).
    function tick(uint256 dt, uint256 price, bool print) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 hours));
        if (!print) return;
        uint80 id = feed.addRound(int256(bound(price, 1e8, 1e12)), block.timestamp);
        ids.push(id);
        ats.push(block.timestamp);
    }

    /// @notice The proxy points at a new aggregator (rare). The tape stays "clean": the proxy
    ///         never switches again before the current aggregator has printed. (A proxy that
    ///         skips over an aggregator that never printed leaves a gap the resolver refuses to
    ///         cross; the settler's 72 h void timeout is the backstop, see SECURITY.md.)
    function newPhase(uint8 gate) external {
        if (gate % 8 == 0 && feed.phaseRounds(feed.phaseId()) > 0) feed.startPhase();
    }

    /// @notice After the bell, try a pair: near the right answer, or anywhere, or nonsense.
    function tryPair(uint256 i, uint256 j, uint8 mode) external {
        if (block.timestamp <= finalTime || ids.length == 0) return;
        (bool hasS, uint256 bs) = _lastAtOrBefore(strikeTime);
        (bool hasF, uint256 bf) = _lastAtOrBefore(finalTime);
        uint80 s;
        uint80 f;
        mode = mode % 3;
        if (mode == 0 && hasS && hasF) {
            (s, f) = (ids[bs], ids[bf]); // the right pair
        } else if (mode == 1 && hasS && hasF) {
            // one neighbour off on one side
            s = ids[_near(bs, i)];
            f = ids[_near(bf, j)];
        } else {
            s = i % 5 == 0 ? uint80(i) : ids[i % ids.length];
            f = j % 5 == 0 ? uint80(j) : ids[j % ids.length];
        }
        bool right = hasS && hasF && s == ids[bs] && f == ids[bf];
        attempts++;
        bool ok;
        try this.attempt(s, f) {}
        catch (bytes memory err) {
            ok = bytes4(err) == Succeeded.selector;
        }
        if (ok) successes++;
        if (ok && !right) wrongPairAccepted++;
        // Liveness is owed only once the proxy's current phase has printed: right after an
        // aggregator switch, the old phase's last round cannot yet be told apart from a hole,
        // so resolution waits for the new aggregator's first round (documented in SECURITY.md
        // and pinned by test_ANewPhaseWithNoRoundsDelaysResolutionUntilItPrints).
        if (!ok && right && feed.phaseRounds(feed.phaseId()) > 0) rightPairRejected++;
    }

    function attempt(uint80 s, uint80 f) external {
        require(msg.sender == address(this));
        resolver.resolve(specId, s, f);
        revert Succeeded();
    }

    function _near(uint256 k, uint256 r) internal view returns (uint256) {
        uint256 d = r % 3; // 0: k-1, 1: k, 2: k+1
        if (d == 0) return k == 0 ? k : k - 1;
        if (d == 2) return k + 1 < ids.length ? k + 1 : k;
        return k;
    }

    /// @dev Brute force over the tape: the last round written at or before t.
    function _lastAtOrBefore(uint256 t) internal view returns (bool found, uint256 k) {
        for (uint256 x = 0; x < ats.length; x++) {
            if (ats[x] <= t) {
                found = true;
                k = x;
            }
        }
    }

    function tapeLength() external view returns (uint256) {
        return ids.length;
    }
}

/// @title INV-7 · Resolver soundness (docs/spec/03-contracts.md)
/// @notice `resolve` succeeds only with the unique "last round at or before T" pair, and on a
///         clean tape that pair always succeeds.
contract ResolverInvariantsTest is StdInvariant, Test {
    ResolverHandler internal h;

    function setUp() public {
        vm.warp(1_790_000_000);
        h = new ResolverHandler();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = ResolverHandler.tick.selector;
        selectors[1] = ResolverHandler.newPhase.selector;
        selectors[2] = ResolverHandler.tryPair.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    function invariant_INV7_OnlyTheProvenPairResolves() public view {
        assertEq(h.wrongPairAccepted(), 0, "INV-7: a pair other than the last rounds at or before the bells resolved");
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
}
