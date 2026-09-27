// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {ForkBase} from "./ForkBase.sol";
import {RH, IChainlinkProxy} from "../../script/RH.sol";
import {StockRoundResolver} from "../../src/StockRoundResolver.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {MockSettler} from "../../src/mocks/MockSettler.sol";

/// @title  T5f: StockRoundResolver on the REAL Robinhood Chain feeds
/// @notice For each allow-listed ticker (NVDA, TSLA, AAPL, COIN): take the most recent
///         COMPLETED NYSE regular session before the fork block (09:30 to 16:00 ET, or the 13:00
///         early close; holidays and early closes from packages/client/src/calendar/nyse.json,
///         the calendar the keeper and the web use), find the strike and final rounds by a
///         brute-force walk down every real round of the feed's current phase, register a spec
///         over that session against a MockSettler, and check that the resolver's verdict equals
///         the one computed independently here: UP / DOWN / FLAT from the two answers, STALE past
///         the 26 h bounds, PAUSED while the Stock Token's oracle is paused. Off-by-one round
///         pairs around the true ones must preview as BADPROOF, on real data.
///
///         Recorded run (fork of chain 4663 at the latest block, Sun 2026-09-27 ~22:00 UTC, public
///         RPC; session Fri 2026-09-25, 09:30-16:00 EDT = 13:30-20:00 UTC; proxy round ids of
///         phase 1, answers with 8 decimals; `forge test -vv` prints the same for any fork):
///           NVDA  strike 18446744073709552716 = 225.57472086 (Fri 06:22:16 UTC)
///                 final  18446744073709552722 = 225.66018707 (Fri 19:56:05 UTC)  → UP
///           TSLA  strike 18446744073709552957 = 383.82840000 (Fri 13:26:48 UTC)
///                 final  18446744073709552983 = 371.74710000 (Fri 19:02:24 UTC)  → DOWN
///           AAPL  strike 18446744073709552284 = 336.30526799 (Thu 19:55:25 UTC)
///                 final  18446744073709552287 = 341.45318048 (Fri 19:49:25 UTC)  → UP
///           COIN  strike 18446744073709554707 = 199.92030000 (Fri 12:24:36 UTC)
///                 final  18446744073709554728 = 194.95499999 (Fri 19:40:14 UTC)  → DOWN
///         The strike is the price IN EFFECT at 09:30 ET: AAPL's last print before the open was
///         Thursday's (no 0.5 % move overnight), 17 h 35 min old, inside the 26 h bound.
///         Feeds: https://robinhoodchain.blockscout.com/address/0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
///         (NVDA), …/0x4A1166a659A55625345e9515b32adECea5547C38 (TSLA),
///         …/0x6B22A786bAa607d76728168703a39Ea9C99f2cD0 (AAPL),
///         …/0xA3a468A452940B7D6b69991207B508c609a98Ef2 (COIN).
contract ResolverForkTest is ForkBase {
    StockRoundResolver internal resolver;
    MockSettler internal settler;

    uint256 internal constant MAX_SCAN = 3000; // rounds walked per feed, at most
    uint256 internal constant DAY = 1 days;

    struct Session {
        uint256 open; // unix, 09:30 ET
        uint256 close; // unix, 16:00 ET (13:00 on an early close)
        string date; // ET calendar date, YYYY-MM-DD
    }

    struct Scan {
        uint80 strikeRound;
        int256 strikeAnswer;
        uint256 strikeAt;
        uint80 finalRound;
        int256 finalAnswer;
        uint256 finalAt;
        uint256 walked;
    }

    function setUp() public {
        if (!_forkOrSkip()) return;
        resolver = new StockRoundResolver();
        settler = new MockSettler();
    }

    function test_NVDA() public {
        _prove(0);
    }

    function test_TSLA() public {
        _prove(1);
    }

    function test_AAPL() public {
        _prove(2);
    }

    function test_COIN() public {
        _prove(3);
    }

    // ================================================================== the proof

    function _prove(uint256 i) internal {
        RH.Ticker memory t = RH.tickers()[i];
        Session memory s = _lastCompletedSession(block.timestamp);
        Scan memory sc = _scan(IChainlinkProxy(t.feed), s);

        // the resolver, fed nothing but the spec and the two round ids
        StockRoundResolver.Spec memory spec = StockRoundResolver.Spec({
            settler: address(settler),
            marketId: i,
            feed: t.feed,
            stockToken: t.stockToken,
            strikeTime: uint64(s.open),
            finalTime: uint64(s.close),
            maxStrikeAge: RH.MAX_AGE,
            maxFinalAge: RH.MAX_AGE
        });
        settler.setMarket(i, address(this), address(resolver), uint64(s.close), 2);
        bytes32 id = resolver.register(spec);

        uint8 expected = _expected(t, s, sc);
        (uint8 status, int256 sa, uint256 sAt, int256 fa, uint256 fAt) =
            resolver.preview(id, sc.strikeRound, sc.finalRound);
        _log(t, s, sc, expected);
        assertEq(status, expected, "preview disagrees with the brute-force verdict");
        assertEq(sa, sc.strikeAnswer, "strike answer");
        assertEq(sAt, sc.strikeAt, "strike time");
        assertEq(fa, sc.finalAnswer, "final answer");
        assertEq(fAt, sc.finalAt, "final time");
        _offByOne(id, sc);

        // settle for real and compare with what the settler was told
        if (expected == resolver.STATUS_UP() || expected == resolver.STATUS_DOWN()) {
            resolver.resolve(id, sc.strikeRound, sc.finalRound);
            (,,,, uint8 st, uint8 winner) = settler.markets(i);
            assertEq(st, 1, "settler resolved");
            assertEq(winner, expected == resolver.STATUS_UP() ? 0 : 1, "winner");
        } else if (expected == resolver.STATUS_FLAT()) {
            resolver.resolve(id, sc.strikeRound, sc.finalRound);
            (,,,, uint8 st,) = settler.markets(i);
            assertEq(st, 2, "FLAT voids");
        } else if (expected == resolver.STATUS_STALE()) {
            vm.expectRevert(StockRoundResolver.Stale.selector);
            resolver.resolve(id, sc.strikeRound, sc.finalRound);
            resolver.voidStale(id, sc.strikeRound, sc.finalRound);
            (,,,, uint8 st,) = settler.markets(i);
            assertEq(st, 2, "STALE voids through voidStale");
        } else {
            vm.expectRevert(StockRoundResolver.OraclePaused.selector);
            resolver.resolve(id, sc.strikeRound, sc.finalRound);
        }
        assertEq(settler.calls(), expected == resolver.STATUS_PAUSED() ? 0 : 1, "exactly one settlement call");
    }

    /// @dev The verdict from the two readings alone, the way a person would compute it.
    function _expected(RH.Ticker memory t, Session memory s, Scan memory sc) internal view returns (uint8) {
        if (IStockToken(t.stockToken).oraclePaused()) return resolver.STATUS_PAUSED();
        if (s.open - sc.strikeAt > RH.MAX_AGE || s.close - sc.finalAt > RH.MAX_AGE) return resolver.STATUS_STALE();
        if (sc.strikeRound == sc.finalRound || sc.finalAnswer == sc.strikeAnswer) return resolver.STATUS_FLAT();
        return sc.finalAnswer > sc.strikeAnswer ? resolver.STATUS_UP() : resolver.STATUS_DOWN();
    }

    /// @dev Every neighbour of the true pair is refused.
    function _offByOne(bytes32 id, Scan memory sc) internal view {
        uint8 bad = resolver.STATUS_BAD_PROOF();
        (uint8 a,,,,) = resolver.preview(id, sc.strikeRound - 1, sc.finalRound);
        assertEq(a, bad, "strike - 1 must not prove");
        (uint8 b,,,,) = resolver.preview(id, sc.strikeRound, sc.finalRound - 1);
        assertEq(b, bad, "final - 1 must not prove");
        (uint8 c,,,,) = resolver.preview(id, sc.strikeRound, sc.finalRound + 1);
        assertEq(c, bad, "final + 1 must not prove");
        if (sc.strikeRound + 1 <= sc.finalRound) {
            (uint8 d,,,,) = resolver.preview(id, sc.strikeRound + 1, sc.finalRound);
            assertEq(d, bad, "strike + 1 must not prove");
        }
    }

    // ================================================================== brute force

    /// @dev Walk down every round of the current phase from the latest: the final round is the
    ///      first with updatedAt ≤ close, the strike round the first with updatedAt ≤ open.
    ///      Checks on the way that updatedAt never increases going down (Chainlink's promise).
    function _scan(IChainlinkProxy feed, Session memory s) internal view returns (Scan memory sc) {
        (uint80 latest,,,,) = feed.latestRoundData();
        uint80 phaseBase = (latest >> 64) << 64;
        uint256 prevAt = type(uint256).max;
        for (uint80 id = latest; id > phaseBase; id--) {
            (, int256 answer,, uint256 at,) = feed.getRoundData(id);
            assertLe(at, prevAt, "updatedAt must not increase with the round id");
            prevAt = at;
            sc.walked++;
            if (sc.finalRound == 0 && at <= s.close) {
                (sc.finalRound, sc.finalAnswer, sc.finalAt) = (id, answer, at);
            }
            if (at <= s.open) {
                (sc.strikeRound, sc.strikeAnswer, sc.strikeAt) = (id, answer, at);
                return sc;
            }
            assertLt(sc.walked, MAX_SCAN, "walked too far without reaching the strike time");
        }
        revert("the session starts before the feed's current phase: pick another session");
    }

    // ================================================================== NYSE calendar

    /// @dev The latest regular session whose close is strictly before `nowTs` (the resolver
    ///      needs block.timestamp > finalTime).
    function _lastCompletedSession(uint256 nowTs) internal view returns (Session memory s) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory cal = vm.readFile("../packages/client/src/calendar/nyse.json");
        uint256 day = (nowTs - 5 hours) / DAY; // the ET date today, give or take the DST hour
        for (uint256 back = 0; back < 20; back++) {
            uint256 d = day - back;
            uint256 wd = (d + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
            if (wd == 0 || wd == 6) continue;
            (uint256 y, uint256 m, uint256 dd) = _civil(d);
            string memory date = _iso(y, m, dd);
            string memory yk = string.concat(".years.", vm.toString(y));
            assertTrue(vm.keyExistsJson(cal, yk), string.concat("nyse.json has no year ", vm.toString(y)));
            if (_listed(cal, string.concat(yk, ".holidays"), date)) continue;
            uint256 offset = _edt(y, m, dd) ? 4 hours : 5 hours;
            uint256 closeHour = _listed(cal, string.concat(yk, ".earlyCloses"), date) ? 13 hours : 16 hours;
            uint256 open = d * DAY + 9 hours + 30 minutes + offset;
            uint256 close = d * DAY + closeHour + offset;
            if (close < nowTs) return Session({open: open, close: close, date: date});
        }
        revert("no completed session in the last 20 days");
    }

    function _listed(string memory cal, string memory key, string memory date) internal view returns (bool found) {
        for (uint256 i = 0;; i++) {
            string memory k = string.concat(key, "[", vm.toString(i), "]");
            if (!vm.keyExistsJson(cal, k)) return false;
            if (keccak256(bytes(vm.parseJsonString(cal, string.concat(k, ".date")))) == keccak256(bytes(date))) {
                return true;
            }
        }
    }

    /// @dev US daylight time: from the second Sunday of March to the first Sunday of November
    ///      (the switch happens at 02:00, never during a session).
    function _edt(uint256 y, uint256 m, uint256 d) internal pure returns (bool) {
        if (m < 3 || m > 11) return false;
        if (m > 3 && m < 11) return true;
        if (m == 3) return d >= _nthSunday(y, 3, 2);
        return d < _nthSunday(y, 11, 1);
    }

    function _nthSunday(uint256 y, uint256 m, uint256 n) internal pure returns (uint256) {
        uint256 first = _days(y, m, 1);
        uint256 wd = (first + 4) % 7;
        return 1 + (7 - wd) % 7 + (n - 1) * 7;
    }

    /// @dev Days since 1970-01-01 → (year, month, day), proleptic Gregorian (H. Hinnant).
    function _civil(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    function _days(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = m > 2 ? m - 3 : m + 9;
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    function _iso(uint256 y, uint256 m, uint256 d) internal pure returns (string memory) {
        return string.concat(vm.toString(y), "-", _two(m), "-", _two(d));
    }

    function _two(uint256 x) internal pure returns (string memory) {
        return x < 10 ? string.concat("0", vm.toString(x)) : vm.toString(x);
    }

    function _log(RH.Ticker memory t, Session memory s, Scan memory sc, uint8 verdict) internal view {
        string[7] memory names = ["NOT_READY", "UP", "DOWN", "FLAT", "STALE", "BAD_PROOF", "PAUSED"];
        console.log(
            string.concat(
                "fork block ",
                vm.toString(block.number),
                " (",
                vm.toString(block.timestamp),
                ") ",
                t.ticker,
                " session ",
                s.date,
                " (open ",
                vm.toString(s.open),
                ", close ",
                vm.toString(s.close),
                "), walked ",
                vm.toString(sc.walked),
                " rounds"
            )
        );
        console.log(
            string.concat(
                "  strike round ",
                vm.toString(uint256(sc.strikeRound)),
                " answer ",
                vm.toString(sc.strikeAnswer),
                " at ",
                vm.toString(sc.strikeAt)
            )
        );
        console.log(
            string.concat(
                "  final  round ",
                vm.toString(uint256(sc.finalRound)),
                " answer ",
                vm.toString(sc.finalAnswer),
                " at ",
                vm.toString(sc.finalAt),
                "  => ",
                names[verdict]
            )
        );
    }
}
