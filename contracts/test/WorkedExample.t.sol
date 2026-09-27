// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HunchBase} from "./utils/HunchBase.sol";
import {Json} from "./utils/Json.sol";

/// @title T2w · The worked example of docs/spec/02-mechanism.md, pinned to the unit
/// @notice "Will NVDA finish the week UP?" κ = 30, seed 10 / 10 USDG, no fee. Mei UP 20
///         (Tue 09:35 ET), Dan DOWN 30 (Tue 12:00), Kim DOWN 40 (Thu 11:00), Ben UP 50
///         (Fri 15:55), Lee DOWN 10 (Fri 15:58), each in its own block; UP wins.
///         Every accumulator, entry accumulator and payout is asserted in exact base units,
///         the table's cents are asserted as the half-up rounding of those units, and the
///         whole table is written to fixtures/worked-example.json, which the website and the
///         TypeScript client import, so the numbers shown anywhere cannot drift from here.
contract WorkedExampleTest is HunchBase {
    string internal constant OUT = "./fixtures/worked-example.json";

    // 2026 build week, UTC (ET = UTC-4)
    uint256 internal constant OPEN = 1_790_688_300; // Tue 2026-09-29 09:25 ET: market listed
    uint256 internal constant FREEZE = 1_790_971_200; // Fri 2026-10-02 16:00 ET: closing bell
    uint256 internal constant BLOCK0 = 23_450_000; // an L1 block number at OPEN

    uint256 internal constant ONE = 1e18;
    uint256 internal constant CENT = 1e4; // USDG base units per cent

    struct Row {
        string who;
        string when;
        uint8 side;
        uint256 stake;
        uint256 time;
        uint256 blockNo;
        uint256 pid;
        uint256 accepted;
        uint256 entryAcc;
        uint256 accUpAfter;
        uint256 accDownAfter;
        uint256 payout;
        uint256 classic;
    }

    Row[] internal rows;
    uint256 internal marketId;

    function test_WorkedExampleIsPinnedToTheCent() public {
        vm.warp(OPEN);
        vm.roll(BLOCK0);
        T = uint64(FREEZE);
        marketId = _createWith(_seed(10 * USDG, 10 * USDG), 30, 0, 0, 0);
        uint256[] memory seeds = vpm.marketPositions(marketId, 0, 2);
        _row("Hunch seed", "open", 0, 10 * USDG, OPEN, seeds[0]);
        _row("Hunch seed", "open", 1, 10 * USDG, OPEN, seeds[1]);
        _assertAcc(ONE, ONE, "open: each seed leg vests 10 into the other's 10");

        _enterRow("Mei", "Tue 09:35", 0, 20, 1_790_688_900);
        _assertAcc(ONE, 3 * ONE, "Mei's 20 vests into DOWN (P = 10): A_DOWN 1.0 -> 3.0");
        _enterRow("Dan", "Tue 12:00", 1, 30, 1_790_697_600);
        _assertAcc(2 * ONE, 3 * ONE, "Dan's 30 vests into UP (P = 30): A_UP -> 2.0");
        _enterRow("Kim", "Thu 11:00", 1, 40, 1_790_866_800);
        _assertAcc(3_333_333_333_333_333_333, 3 * ONE, "Kim's 40 into UP (P = 30): A_UP -> 3.3333");
        _enterRow("Ben", "Fri 15:55", 0, 50, 1_790_970_900);
        _assertAcc(3_333_333_333_333_333_333, 3_625_000_000_000_000_000, "Ben's 50 into DOWN (P = 80)");
        _enterRow("Lee", "Fri 15:58", 1, 10, 1_790_971_080);
        _assertAcc(3_458_333_333_333_333_333, 3_625_000_000_000_000_000, "Lee's 10 into UP (P = 80)");

        // entry accumulators, the table's last column
        assertEq(rows[2].entryAcc, ONE, "Mei entered at A_UP = 1.0");
        assertEq(rows[3].entryAcc, 3 * ONE, "Dan at A_DOWN = 3.0");
        assertEq(rows[4].entryAcc, 3 * ONE, "Kim at A_DOWN = 3.0");
        assertEq(rows[5].entryAcc, 3_333_333_333_333_333_333, "Ben at A_UP = 3.3333");
        assertEq(rows[6].entryAcc, 3_625_000_000_000_000_000, "Lee at A_DOWN = 3.625");

        // NVDA closes up: UP wins
        vm.warp(FREEZE);
        vm.roll(block.number + 1);
        vm.prank(resolver);
        vpm.resolve(marketId, 0);
        (uint256 pool,) = _pool(marketId);
        assertEq(pool, 170 * USDG, "pool = 170 USDG, everything accepted");

        uint256 paid;
        for (uint256 i = 0; i < rows.length; i++) {
            Row storage r = rows[i];
            (address owner,,,,,) = _position(r.pid);
            uint256 before = usdg.balanceOf(owner);
            vpm.claimFor(r.pid);
            r.payout = usdg.balanceOf(owner) - before;
            r.classic = r.side == 0 ? (r.stake * 170) / 80 : 0; // 170 / 80 winning principal = 2.125x
            paid += r.payout;
        }

        // exact base units
        assertEq(rows[2].payout, 69_166_666, "Mei 20 * (1 + 3.458333 - 1.0)");
        assertEq(rows[5].payout, 56_250_000, "Ben 50 * (1 + 3.458333 - 3.333333)");
        assertEq(rows[0].payout, 44_583_333, "seed UP 10 * (1 + 3.458333 - 0)");
        assertEq(rows[1].payout + rows[3].payout + rows[4].payout + rows[6].payout, 0, "DOWN lost");

        // the table, to the cent (half-up rounding of the exact units)
        assertEq(_cents(rows[2].payout), 6917, "Mei 69.17");
        assertEq(_cents(rows[5].payout), 5625, "Ben 56.25");
        assertEq(_cents(rows[0].payout), 4458, "seed UP 44.58");
        assertEq((rows[2].payout * 100 + 10 * USDG) / (20 * USDG), 346, "Mei 3.46x (3.4583, half-up)");
        assertEq(rows[5].payout * 1000 / (50 * USDG), 1125, "Ben 1.125x exactly");
        assertEq(rows[2].classic, 42_500_000, "ordinary pool: Mei 42.50");
        assertEq(rows[5].classic, 106_250_000, "ordinary pool: Ben 106.25");
        assertEq(rows[0].classic, 21_250_000, "ordinary pool: seed 21.25");

        // total 170.00: payouts + the one unit of floor residue
        vm.prank(residueOwner);
        vpm.claimResidue(marketId);
        uint256 residue = usdg.balanceOf(residueOwner);
        assertEq(residue, 1, "floor dust: one base unit");
        assertEq(paid + residue, 170 * USDG, "total 170.00, conservation to the unit");
        assertEq(usdg.balanceOf(address(vpm)), 0, "nothing left behind");

        _write(residue);
    }

    // ------------------------------------------------------------------ helpers

    function _enterRow(string memory who, string memory when, uint8 side, uint256 stakeUsdg, uint256 time) internal {
        vm.warp(time);
        vm.roll(BLOCK0 + (time - OPEN) / 12); // one L1 block per ~12 s: every entry its own vintage
        uint256 pid = _enter(makeAddr(who), marketId, side, stakeUsdg * USDG);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(marketId); // so "accumulator after" is readable right away
        _row(who, when, side, stakeUsdg * USDG, time, pid);
    }

    function _row(string memory who, string memory when, uint8 side, uint256 stake, uint256 time, uint256 pid)
        internal
    {
        (,,,, uint128 accepted, uint128 entryAcc) = _position(pid);
        assertEq(accepted, stake, "kappa = 30 accepts every stake of this example in full");
        rows.push(
            Row({
                who: who,
                when: when,
                side: side,
                stake: stake,
                time: time,
                blockNo: time == OPEN ? BLOCK0 : BLOCK0 + (time - OPEN) / 12,
                pid: pid,
                accepted: accepted,
                entryAcc: entryAcc,
                accUpAfter: vpm.getBook(marketId, 0).acc,
                accDownAfter: vpm.getBook(marketId, 1).acc,
                payout: 0,
                classic: 0
            })
        );
    }

    function _assertAcc(uint256 up, uint256 down, string memory why) internal view {
        assertEq(vpm.getBook(marketId, 0).acc, up, string.concat("A_UP: ", why));
        assertEq(vpm.getBook(marketId, 1).acc, down, string.concat("A_DOWN: ", why));
    }

    function _cents(uint256 units) internal pure returns (uint256) {
        return (units + CENT / 2) / CENT;
    }

    function _write(uint256 residue) internal {
        string[] memory items = new string[](rows.length);
        for (uint256 i = 0; i < rows.length; i++) {
            Row storage r = rows[i];
            string[] memory f = new string[](16);
            f[0] = Json.str("who", r.who);
            f[1] = Json.str("when", r.when);
            f[2] = Json.str("side", r.side == 0 ? "UP" : "DOWN");
            f[3] = Json.uintField("stake", r.stake);
            f[4] = Json.uintField("accepted", r.accepted);
            f[5] = Json.uintField("timestamp", r.time);
            f[6] = Json.uintField("block", r.blockNo);
            f[7] = Json.uintField("positionId", r.pid);
            f[8] = Json.uintField("entryAcc", r.entryAcc);
            f[9] = Json.uintField("accUpAfter", r.accUpAfter);
            f[10] = Json.uintField("accDownAfter", r.accDownAfter);
            f[11] = Json.uintField("vpmPayout", r.payout);
            f[12] = Json.str("vpmPayoutUsdg", Json.fixedPoint(r.payout, 6));
            f[13] = Json.str("multiple", Json.fixedPoint((r.payout * 1e4) / r.stake, 4));
            f[14] = Json.uintField("classicPayout", r.classic);
            f[15] = Json.str("classicPayoutUsdg", Json.fixedPoint(r.classic, 6));
            items[i] = Json.obj(f);
        }
        string[] memory top = new string[](16);
        top[0] = Json.str(
            "source", "docs/spec/02-mechanism.md worked example, pinned by contracts/test/WorkedExample.t.sol"
        );
        top[1] = Json.str("label", "Illustration");
        top[2] = Json.str("question", "Will NVDA finish the week UP?");
        top[3] = Json.str("token", "USDG");
        top[4] = Json.uintField("decimals", 6);
        top[5] = Json.uintField("scale", ONE);
        top[6] = Json.uintField("kappa", 30);
        top[7] = Json.uintField("feeBps", 0);
        top[8] = Json.uintField("seedPerLeg", 10 * USDG);
        top[9] = Json.uintField("openedAt", OPEN);
        top[10] = Json.uintField("freezeAt", FREEZE);
        top[11] = Json.str("winner", "UP");
        top[12] = Json.uintField("pool", 170 * USDG);
        top[13] = Json.uintField("winningPrincipal", 80 * USDG);
        top[14] = Json.uintField("residue", residue);
        top[15] = Json.raw("rows", Json.arr(items));
        vm.writeJson(Json.obj(top), OUT);
    }
}
