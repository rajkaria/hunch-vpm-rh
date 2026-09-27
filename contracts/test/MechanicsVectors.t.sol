// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HunchBase} from "./utils/HunchBase.sol";
import {Json} from "./utils/Json.sol";
import {HunchVPM} from "../src/HunchVPM.sol";

/// @title Mechanics vectors for the TypeScript mirror (T8)
/// @notice Runs 21 hand-designed binary scenarios on HunchVPM and writes every observable
///         number to fixtures/mechanics-vectors.json, which packages/client's mechanics test
///         replays: partial fills (small κ), rationed same-vintage batches, same-vintage pairs
///         on one side and on opposite sides, an asymmetric seed clamp, κ = 1 (everything
///         refused), κ unbounded, fee on and off, UP / DOWN / VOID, dust and large amounts.
///         Each scenario runs on a fresh HunchVPM, so position ids start at 0 (the seed legs,
///         0 = UP and 1 = DOWN), then one id per entry in order. Every number is asserted
///         against the contract's own claim before it is written (net = gross − fee + refund;
///         Σ net + Σ fee + residue = everything escrowed).
/// @dev    Format (every integer a decimal string):
///         { suite, version, source, scenarios: [ { name, kappa, feeBps, seed: [up, down],
///           entries: [ {block, outcome, amount} ], result: "UP"|"DOWN"|"VOID", acceptedPool,
///           residue, feesTotal, positions: [ { id, isSeed, outcome, offered, accepted,
///           entryAcc, accruedBeforeSettle, payoutGross, fee, refund, netToOwner } ],
///           books: [ {principal, acc, capacity, vested} ] } ] }
///         `block` is relative: entries sharing it land in one block (one vintage). `books` and
///         `accruedBeforeSettle` are read after the last vintage is finalized, before settling.
contract MechanicsVectorsTest is HunchBase {
    string internal constant OUT = "./fixtures/mechanics-vectors.json";
    uint8 internal constant UP = 0;
    uint8 internal constant DOWN = 1;
    uint8 internal constant VOID = 2;
    uint256 internal constant UNBOUNDED = type(uint256).max;

    struct E {
        uint64 blk;
        uint8 outcome;
        uint256 amount;
    }

    E[] internal es;
    string[] internal out;

    function test_WriteMechanicsVectors() public {
        // 1-4: the worked example, fee off / on, both winners, void
        _workedEntries();
        _run("worked-example", 30, 0, 10 * USDG, 10 * USDG, UP);
        _workedEntries();
        _run("worked-example-fee-200", 30, 200, 10 * USDG, 10 * USDG, UP);
        _workedEntries();
        _run("worked-example-down-wins-fee-200", 30, 200, 10 * USDG, 10 * USDG, DOWN);
        _workedEntries();
        _run("worked-example-void-fee-200", 30, 200, 10 * USDG, 10 * USDG, VOID);

        // 5: the seed legs alone: the winning leg takes the losing leg, and pays the fee on it
        _run("seed-only-fee-200", 30, 200, 10 * USDG, 10 * USDG, UP);

        // 6: one late entry, nothing after it: exactly 1x (P4), zero fee
        _add(1, UP, 100 * USDG);
        _run("single-buzzer-entry-fee-200", 30, 200, 10 * USDG, 10 * USDG, UP);

        // 7: a partial fill: κ = 2, DOWN absorbs 20 in total, 10 used by the seed
        _add(1, UP, 30 * USDG);
        _add(2, DOWN, 5 * USDG);
        _run("partial-fill-kappa-2", 2, 0, 10 * USDG, 10 * USDG, UP);

        // 8: κ = 1: the seed exhausts every book, every entry is refused in full
        _add(1, UP, 5 * USDG);
        _add(2, DOWN, 5 * USDG);
        _run("kappa-1-everything-refused-fee-500", 1, 500, 10 * USDG, 10 * USDG, UP);

        // 9: two UP entries in one block share the vintage and the entry accumulator
        _add(1, UP, 40 * USDG);
        _add(1, UP, 60 * USDG);
        _add(2, DOWN, 50 * USDG);
        _run("same-vintage-pair-same-side-fee-200", 30, 200, 10 * USDG, 10 * USDG, UP);

        // 10: opposite sides in one block never vest to each other
        _add(1, UP, 30 * USDG);
        _add(1, DOWN, 30 * USDG);
        _add(2, UP, 10 * USDG);
        _run("same-vintage-opposing-pair-fee-150", 30, 150, 10 * USDG, 10 * USDG, DOWN);

        // 11: a rationed vintage: headroom 20, demand 40, pro-rata 15 / 5
        _add(1, UP, 30 * USDG);
        _add(1, UP, 10 * USDG);
        _add(2, DOWN, 25 * USDG);
        _run("rationed-vintage-kappa-3", 3, 0, 10 * USDG, 10 * USDG, UP);

        // 12: an asymmetric seed is clamped to κ times the other leg (1000 -> 300)
        _add(1, UP, 50 * USDG);
        _add(2, DOWN, 20 * USDG);
        _run("asymmetric-seed-clamp-fee-200", 30, 200, 10 * USDG, 1000 * USDG, DOWN);

        // 13: a whale at the bell is paid exactly 1x
        _add(1, DOWN, 100 * USDG);
        _add(2, UP, 100 * USDG);
        _add(3, UP, 100 * USDG);
        _run("late-whale-exactly-1x-fee-200", 30, 200, 10 * USDG, 10 * USDG, UP);

        // 14: dust: fees floor to zero
        _add(1, UP, 1);
        _add(2, DOWN, 1);
        _add(3, UP, 2);
        _run("dust-fee-floors-to-zero-fee-500", 30, 500, 1, 1, UP);

        // 15: large amounts (millions of USDG)
        _add(1, UP, 5_000_000 * USDG);
        _add(2, DOWN, 7_000_000 * USDG);
        _add(3, UP, 300_000 * USDG);
        _run("large-amounts-fee-200", 30, 200, 1_000_000 * USDG, 1_000_000 * USDG, DOWN);

        // 16: ten alternating entries, one block each
        for (uint64 i = 1; i <= 10; i++) {
            _add(i, uint8(i % 2), (i * 7 + 3) * USDG);
        }
        _run("ten-alternating-entries-fee-200", 30, 200, 10 * USDG, 10 * USDG, UP);

        // 17: void with partial fills: accepted principal and refused remainder both return
        _add(1, UP, 30 * USDG);
        _add(2, DOWN, 50 * USDG);
        _run("void-with-partial-fills-kappa-2-fee-200", 2, 200, 10 * USDG, 10 * USDG, VOID);

        // 18: bursts: several entries per block on both sides
        _add(1, UP, 100 * USDG);
        _add(1, DOWN, 100 * USDG);
        _add(1, UP, 50 * USDG);
        _add(2, DOWN, 100 * USDG);
        _add(2, DOWN, 20 * USDG);
        _add(3, UP, 100 * USDG);
        _add(3, DOWN, 1 * USDG);
        _run("bursts-fee-200", 30, 200, 10 * USDG, 10 * USDG, DOWN);

        // 19: DOWN wins after partial fills at κ = 2
        _add(1, DOWN, 40 * USDG);
        _add(2, UP, 15 * USDG);
        _add(3, DOWN, 10 * USDG);
        _run("down-wins-partial-fills-kappa-2-fee-150", 2, 150, 10 * USDG, 10 * USDG, DOWN);

        // 20: awkward amounts: floor residue and fee rounding
        _add(1, UP, 10_000_001);
        _add(2, DOWN, 3_333_333);
        _add(3, UP, 7_777_777);
        _add(4, DOWN, 1);
        _run("rounding-residue-fee-333", 30, 333, 3 * USDG, 7 * USDG, UP);

        // 21: κ unbounded: nothing is ever refused
        _add(1, UP, 1_000 * USDG);
        _add(2, DOWN, 5 * USDG);
        _run("kappa-unbounded", UNBOUNDED, 0, 10 * USDG, 10 * USDG, UP);

        string[] memory top = new string[](4);
        top[0] = Json.str("suite", "hunch-mechanics");
        top[1] = Json.str("version", "1");
        top[2] = Json.str(
            "source", "contracts/test/MechanicsVectors.t.sol on HunchVPM (every number read from the contract)"
        );
        top[3] = Json.raw("scenarios", Json.arr(out));
        vm.writeJson(Json.obj(top), OUT);
        assertEq(out.length, 21);
    }

    // ------------------------------------------------------------------ scenario runner

    function _add(uint64 blk, uint8 outcome, uint256 amount) internal {
        es.push(E(blk, outcome, amount));
    }

    function _workedEntries() internal {
        _add(1, UP, 20 * USDG);
        _add(2, DOWN, 30 * USDG);
        _add(3, DOWN, 40 * USDG);
        _add(4, UP, 50 * USDG);
        _add(5, DOWN, 10 * USDG);
    }

    struct P {
        address owner;
        bool isSeed;
        uint8 outcome;
        uint256 offered;
        uint256 accepted;
        uint256 entryAcc;
        uint256 accrued;
        uint256 gross;
        uint256 fee;
        uint256 refund;
        uint256 net;
    }

    /// @dev The scenario being run, kept in storage so the runner stays within the stack.
    struct Ctx {
        string name;
        uint256 kappa;
        uint16 feeBps;
        uint256 seedUp;
        uint256 seedDown;
        uint8 result;
        uint256 id;
        uint256 escrowed;
    }

    Ctx internal c;

    function _run(string memory name, uint256 kappa, uint16 feeBps, uint256 seedUp, uint256 seedDown, uint8 result)
        internal
    {
        c = Ctx(name, kappa, feeBps, seedUp, seedDown, result, 0, 0);
        vpm = new HunchVPM(guardian, treasury);
        vm.prank(creator);
        usdg.approve(address(vpm), type(uint256).max);
        uint256 base = block.number + 10;
        vm.roll(base);
        T = uint64(block.timestamp + 1 days);
        c.id = _createWith(_seed(seedUp, seedDown), kappa, feeBps, 0, 0);
        c.escrowed = usdg.balanceOf(address(vpm));
        for (uint256 i = 0; i < es.length; i++) {
            vm.roll(base + es[i].blk);
            _enter(address(uint160(0x10000 + i)), c.id, es[i].outcome, es[i].amount);
            c.escrowed += es[i].amount;
        }
        vm.roll(block.number + 1);
        vpm.finalizeVintage(c.id);

        P[] memory ps = _snapshot();
        string memory books = _books(c.id);

        vm.warp(T);
        vm.prank(resolver);
        if (result == VOID) vpm.voidMarket(c.id);
        else vpm.resolve(c.id, result);

        (uint256 totalOut, uint256 fees) = _claimAll(ps);
        (uint256 pool, uint256 residue) = _residue();
        assertEq(totalOut + fees + residue, c.escrowed, string.concat(c.name, ": conservation"));
        assertEq(usdg.balanceOf(address(vpm)), fees, string.concat(c.name, ": only fees remain"));

        out.push(_scenarioJson(pool, residue, fees, ps, books));
        delete es;
    }

    function _residue() internal returns (uint256 pool, uint256 residue) {
        uint256 paidOut;
        (pool, paidOut) = _pool(c.id);
        if (c.result == VOID) return (pool, 0);
        residue = pool - paidOut;
        uint256 before = usdg.balanceOf(residueOwner);
        vm.prank(residueOwner);
        vpm.claimResidue(c.id);
        assertEq(usdg.balanceOf(residueOwner) - before, residue, string.concat(c.name, ": residue"));
    }

    function _snapshot() internal view returns (P[] memory ps) {
        uint256 n = vpm.positionCount();
        ps = new P[](n);
        for (uint256 i = 0; i < n; i++) {
            (, address owner, uint8 outcome,,,,, uint128 offered, uint128 accepted, uint128 entryAcc) = vpm.positions(i);
            ps[i] = P(owner, i < 2, outcome, offered, accepted, entryAcc, vpm.accrued(i), 0, 0, 0, 0);
        }
    }

    function _claimAll(P[] memory ps) internal returns (uint256 totalOut, uint256 fees) {
        for (uint256 i = 0; i < ps.length; i++) {
            P memory p = ps[i];
            p.gross = c.result == VOID ? p.accepted : vpm.previewPayout(i);
            p.fee = vpm.previewFee(i);
            p.refund = p.isSeed ? 0 : p.offered - p.accepted;
            uint256 before = usdg.balanceOf(p.owner);
            vpm.claimFor(i);
            p.net = usdg.balanceOf(p.owner) - before;
            _check(p);
            totalOut += p.net;
            fees += p.fee;
        }
    }

    function _check(P memory p) internal view {
        assertEq(p.net, p.gross - p.fee + p.refund, string.concat(c.name, ": net = gross - fee + refund"));
        if (c.result != VOID && p.outcome == c.result) {
            assertEq(p.accrued, p.gross, string.concat(c.name, ": accrued == payout for a winner"));
            assertEq(p.fee, ((p.gross - p.accepted) * c.feeBps) / 10_000, string.concat(c.name, ": fee"));
        } else {
            assertEq(p.fee, 0, string.concat(c.name, ": no fee off the winning side"));
        }
    }

    function _books(uint256 id) internal view returns (string memory) {
        string[] memory bs = new string[](2);
        for (uint8 w = 0; w < 2; w++) {
            HunchVPM.Book memory b = vpm.getBook(id, w);
            string[] memory f = new string[](4);
            f[0] = Json.uintField("principal", b.principal);
            f[1] = Json.uintField("acc", b.acc);
            f[2] = Json.uintField("capacity", b.capacity);
            f[3] = Json.uintField("vested", b.vested);
            bs[w] = Json.obj(f);
        }
        return Json.arr(bs);
    }

    function _scenarioJson(uint256 pool, uint256 residue, uint256 fees, P[] memory ps, string memory books)
        internal
        view
        returns (string memory)
    {
        string[] memory seed = new string[](2);
        seed[0] = Json.num(c.seedUp);
        seed[1] = Json.num(c.seedDown);
        string[] memory entries = new string[](es.length);
        for (uint256 i = 0; i < es.length; i++) {
            string[] memory f = new string[](3);
            f[0] = Json.uintField("block", es[i].blk);
            f[1] = Json.uintField("outcome", es[i].outcome);
            f[2] = Json.uintField("amount", es[i].amount);
            entries[i] = Json.obj(f);
        }
        string[] memory positions = new string[](ps.length);
        for (uint256 i = 0; i < ps.length; i++) {
            positions[i] = _positionJson(i, ps[i]);
        }
        string[] memory s = new string[](12);
        s[0] = Json.str("name", c.name);
        s[1] = Json.uintField("kappa", c.kappa);
        s[2] = Json.uintField("feeBps", c.feeBps);
        s[3] = Json.raw("seed", Json.arr(seed));
        s[4] = Json.raw("entries", Json.arr(entries));
        s[5] = Json.str("result", c.result == UP ? "UP" : c.result == DOWN ? "DOWN" : "VOID");
        s[6] = Json.uintField("acceptedPool", pool);
        s[7] = Json.uintField("residue", residue);
        s[8] = Json.uintField("feesTotal", fees);
        s[9] = Json.raw("positions", Json.arr(positions));
        s[10] = Json.raw("books", books);
        s[11] =
            Json.str("note", "books and accruedBeforeSettle: after the last vintage is finalized, before settlement");
        return Json.obj(s);
    }

    function _positionJson(uint256 id, P memory p) internal pure returns (string memory) {
        string[] memory f = new string[](11);
        f[0] = Json.uintField("id", id);
        f[1] = Json.raw("isSeed", p.isSeed ? "true" : "false");
        f[2] = Json.uintField("outcome", p.outcome);
        f[3] = Json.uintField("offered", p.offered);
        f[4] = Json.uintField("accepted", p.accepted);
        f[5] = Json.uintField("entryAcc", p.entryAcc);
        f[6] = Json.uintField("accruedBeforeSettle", p.accrued);
        f[7] = Json.uintField("payoutGross", p.gross);
        f[8] = Json.uintField("fee", p.fee);
        f[9] = Json.uintField("refund", p.refund);
        f[10] = Json.uintField("netToOwner", p.net);
        return Json.obj(f);
    }
}
