// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @title Differential test against the paper's conformance vectors
/// @notice Replays every vector of ../sim/vpm-vectors.json through the contract:
///         `seed: true` events become the `create` call (vintage 0); consecutive
///         non-seed events sharing `v` are entered in ONE block (one vintage); events
///         without `v` each get their own block; the market is then frozen, resolved to
///         the vector's winner, and every position is claimed through the token path.
///         Asserted per vector:
///           * `voided`      — exactly (a voided vector must make `create` revert);
///           * `accepted[i]` — exactly, for every event;
///           * `payouts[i]`  — for every winning-side event, within the suite's (≥ 1.2)
///                             P8 tolerance: 1 + the number of later-vintage opposing
///                             events with accepted > 0 on that vector (the runner's
///                             `compareVector` rule, reproduced in `_laterOpposing`);
///           * no overpayment — Σ payouts ≤ accepted pool (never conformant otherwise);
///           * conservation  — Σ claims + Σ refunds + residue == every unit escrowed.
///         The pre-1.2 "±1 unit per position" reading is still tallied, informationally
///         only (the reference's per-event largest-remainder allocation drifts by up to
///         one unit per opposing event, which is why the suite moved to the P8 rule).
contract VectorsTest is Test {
    string constant VECTORS = "./test/vectors/vpm-vectors.json";

    VestedParimutuel vpm;
    MockERC20 token;

    struct Ev {
        uint8 outcome;
        uint256 cents;
        uint256 t; // a label, except under `freezeAt` (suite >= 1.2) where it is the entry time
        bool seed;
        bool hasV;
        uint256 v;
    }

    uint256 constant NO_POSITION = type(uint256).max; // refused by the freeze: never entered

    struct Vec {
        string name;
        string[] outcomes;
        uint8 winner;
        bool expVoided;
        uint256 kappa;
        bool hasFreeze; // vector-level `freezeAt` (suite >= 1.2): entries with t >= freezeAt are refused
        uint256 freezeAt;
        Ev[] ev;
        uint256[] seed;
        uint256[] expAccepted;
        uint256[] expPayouts; // 0 where the vector has null (non-winning side)
        uint256[] order; // vintage rank per event: 0 = seed, then 1, 2, ... by run of `v` (or singleton)
    }

    // tallies (storage, so the per-vector external calls can accumulate)
    uint256 public vectorsRun;
    uint256 public vectorsVoided;
    uint256 public vectorsSettled;
    uint256 public winningPositions;
    uint256 public strictVectors; // informational: vectors meeting the pre-1.2 ±1 reading
    uint256 public strictMisses;  // informational: winning positions with |Δ| > 1
    uint256 public worstDelta;
    string public worstAt;
    string[] public strictFailures;

    function setUp() public {
        token = new MockERC20();
        vpm = new VestedParimutuel();
        token.mint(address(this), 1e30);
        token.approve(address(vpm), type(uint256).max);
        vm.warp(1_000_000);
        vm.roll(100);
    }

    // ------------------------------------------------------------------ the test

    function test_ReplayAllVectors() public {
        string memory json = vm.readFile(VECTORS);
        assertEq(vm.parseJsonString(json, ".suite"), "vpm-conformance", "wrong vectors file");
        string memory version = vm.parseJsonString(json, ".version");
        string memory hash = _hex12(sha256(bytes(json))); // same 12-hex prefix the JS runner prints

        // Each vector object sits at indent 2 in the pretty-printed file; splitting on
        // "\n  {" / "\n  }" yields one small JSON document per vector, which keeps every
        // cheatcode call cheap. (The events inside are at indent 4, so no collision.)
        string[] memory chunks = vm.split(json, "\n  {");
        uint256 count = chunks.length - 1;
        for (uint256 i = 0; i < count; i++) {
            string[] memory body = vm.split(chunks[i + 1], "\n  }");
            this.replayVector(string.concat("{", body[0], "\n}")); // own frame: memory resets per vector
        }

        console.log("");
        console.log(
            string.concat(
                "vpm-conformance v", version, " (vectors sha256 ", hash, "): ", vm.toString(vectorsRun), "/", vm.toString(count),
                " vectors replayed on-chain (", vm.toString(vectorsSettled), " settled, ", vm.toString(vectorsVoided),
                " voided) -- voided + accepted[] EXACT on all; payouts within the suite's P8 tolerance on all ",
                vm.toString(winningPositions), " winning positions; no vector overpays its accepted pool"
            )
        );
        console.log(
            string.concat(
                "informational, pre-1.2 +/-1-unit reading: ", vm.toString(strictVectors), "/", vm.toString(count), " vectors; ",
                vm.toString(strictMisses), " winning positions off by >1; worst |delta| = ", vm.toString(worstDelta),
                " at ", worstAt
            )
        );
        for (uint256 i = 0; i < strictFailures.length; i++) console.log(string.concat("  (info) >1 unit: ", strictFailures[i]));

        assertGe(count, 106, "the published suite has at least the 106 v1.1.1 vectors");
        assertEq(vectorsRun, count, "every vector must replay");
        assertEq(vectorsSettled + vectorsVoided, count, "every vector settled or voided");
    }

    // ------------------------------------------------------------------ one vector

    function replayVector(string calldata doc) external {
        require(msg.sender == address(this), "internal");
        Vec memory V = _parse(doc);
        vectorsRun += 1;

        // §12: the freeze is fixed at creation. Under `freezeAt` the log's `t` is real time
        // (seconds after creation) and the market freezes at creation + freezeAt.
        uint64 resolutionTime = uint64(block.timestamp + (V.hasFreeze ? V.freezeAt : 1 days));
        if (V.expVoided) {
            vm.expectRevert();
            vpm.create(IERC20(address(token)), V.seed, V.kappa, resolutionTime, 1 days, address(this), address(this));
            vectorsVoided += 1;
            strictVectors += 1; // nothing to pay: trivially within the rule
            return;
        }
        uint256 balBefore = token.balanceOf(address(this));
        uint256[] memory pid = _createAndEnter(V, resolutionTime);
        uint256 escrowed = balBefore - token.balanceOf(address(this));

        // freeze + resolve
        vm.roll(block.number + 1);
        vm.warp(resolutionTime);
        uint256 marketId = _marketOf(pid[0]); // pid[0] is always a seed leg (the log's seed prefix)
        vm.expectRevert(VestedParimutuel.Frozen.selector);
        vpm.enter(marketId, 0, 1); // §12: an entry at the resolution timestamp is refused in full
        vpm.resolve(marketId, V.winner);

        uint256 returned = _claimAll(V, pid);
        _residueAndConservation(V, marketId, returned, escrowed);
        vectorsSettled += 1;
    }

    function _createAndEnter(Vec memory V, uint64 resolutionTime) internal returns (uint256[] memory pid) {
        uint256 firstPos = vpm.positionCount();
        uint256 t0 = block.timestamp;
        uint256 marketId =
            vpm.create(IERC20(address(token)), V.seed, V.kappa, resolutionTime, 1 days, address(this), address(this));
        uint256 m = V.ev.length;
        pid = new uint256[](m);
        bool inRun = false;
        uint256 runV = 0;
        for (uint256 j = 0; j < m; j++) {
            if (V.ev[j].seed) {
                pid[j] = firstPos + V.ev[j].outcome; // create pushes one seed position per outcome
                continue;
            }
            // consecutive non-seed events sharing `v` share a block (one vintage)
            bool sameVintage = V.ev[j].hasV && inRun && V.ev[j].v == runV;
            if (!sameVintage) vm.roll(block.number + 1);
            inRun = V.ev[j].hasV;
            runV = V.ev[j].v;
            if (V.hasFreeze) {
                vm.warp(t0 + V.ev[j].t);
                if (V.ev[j].t >= V.freezeAt) {
                    // refused in full: no position, no claim, no capacity (§12)
                    vm.expectRevert(VestedParimutuel.Frozen.selector);
                    vpm.enter(marketId, V.ev[j].outcome, V.ev[j].cents);
                    pid[j] = NO_POSITION;
                    continue;
                }
            }
            pid[j] = vpm.enter(marketId, V.ev[j].outcome, V.ev[j].cents);
        }
    }

    function _claimAll(Vec memory V, uint256[] memory pid) internal returns (uint256 returned) {
        bool strict = true;
        for (uint256 j = 0; j < V.ev.length; j++) {
            if (pid[j] == NO_POSITION) {
                assertEq(V.expAccepted[j], 0, string.concat(V.name, ": frozen entry must be refused in full"));
                assertEq(V.expPayouts[j], 0, string.concat(V.name, ": frozen entry holds no claim"));
                continue;
            }
            (,,, bool finalized,,,, uint128 offered, uint128 accepted,) = vpm.positions(pid[j]);
            assertTrue(finalized, string.concat(V.name, ": position not finalized"));
            assertEq(accepted, V.expAccepted[j], string.concat(V.name, ": accepted[", vm.toString(j), "]"));

            uint256 before = token.balanceOf(address(this));
            vpm.claim(pid[j]);
            uint256 got = token.balanceOf(address(this)) - before;
            returned += got;
            // the seed's refused part was never pulled, so its refund is 0
            uint256 payout = got - (V.ev[j].seed ? 0 : offered - accepted);

            if (V.ev[j].outcome != V.winner) {
                assertEq(payout, 0, string.concat(V.name, ": losing position paid"));
                continue;
            }
            if (!_checkPayout(V, j, payout)) strict = false;
        }
        if (strict) strictVectors += 1;
    }

    function _checkPayout(Vec memory V, uint256 j, uint256 payout) internal returns (bool withinOne) {
        uint256 expPayout = V.expPayouts[j];
        uint256 delta = payout > expPayout ? payout - expPayout : expPayout - payout;
        winningPositions += 1;
        // suite ≥ 1.2 tolerance (P8): one unit per later-vintage opposing accepted event + one at claim
        uint256 bound = 1 + _laterOpposing(V, j);
        assertLe(
            delta,
            bound,
            string.concat(V.name, ": payouts[", vm.toString(j), "] = ", vm.toString(payout), " vs ", vm.toString(expPayout))
        );
        withinOne = delta <= 1;
        if (!withinOne) {
            strictMisses += 1;
            strictFailures.push(
                string.concat(
                    V.name, " payouts[", vm.toString(j), "]: contract ", vm.toString(payout), " vector ",
                    vm.toString(expPayout), " |delta| ", vm.toString(delta)
                )
            );
        }
        if (delta > worstDelta) {
            worstDelta = delta;
            worstAt = string.concat(V.name, " payouts[", vm.toString(j), "]");
        }
    }

    function _residueAndConservation(Vec memory V, uint256 marketId, uint256 returned, uint256 escrowed) internal {
        (,,,,,,,,,, uint256 acceptedPool, uint256 paidOut) = vpm.getMarket(marketId);
        assertLe(paidOut, acceptedPool, string.concat(V.name, ": overpayment is never conformant"));
        uint256 before = token.balanceOf(address(this));
        vpm.claimResidue(marketId);
        uint256 residue = token.balanceOf(address(this)) - before;
        assertEq(residue, acceptedPool - paidOut, string.concat(V.name, ": residue"));
        assertEq(returned + residue, escrowed, string.concat(V.name, ": conservation"));
    }

    // ------------------------------------------------------------------ parsing

    function _parse(string calldata doc) internal view returns (Vec memory V) {
        V.name = vm.parseJsonString(doc, ".name");
        V.outcomes = vm.parseJsonStringArray(doc, ".outcomes");
        V.winner = _outcomeIndex(V.outcomes, vm.parseJsonString(doc, ".winner"));
        V.expVoided = vm.parseJsonBool(doc, ".expect.voided");
        V.hasFreeze = vm.keyExistsJson(doc, ".freezeAt");
        if (V.hasFreeze) V.freezeAt = vm.parseJsonUint(doc, ".freezeAt");
        try this.readKappa(doc) returns (uint256 k) {
            V.kappa = k;
        } catch {
            V.kappa = 0; // non-integer κ (the 0.5 vector): below the κ ≥ 1 domain
        }
        uint256 m = 0;
        while (vm.keyExistsJson(doc, string.concat(".events[", vm.toString(m), "]"))) m++;
        V.ev = new Ev[](m);
        V.seed = new uint256[](V.outcomes.length);
        for (uint256 j = 0; j < m; j++) _parseEvent(doc, V, j);
        // vintage ranks, exactly as the runner groups them: seeds = 0; a run of
        // consecutive non-seed events sharing `v` is one vintage; no `v` = singleton
        V.order = new uint256[](m);
        {
            uint256 rank = 0;
            bool inRun = false;
            uint256 runV = 0;
            for (uint256 j = 0; j < m; j++) {
                if (V.ev[j].seed) continue;
                bool same = V.ev[j].hasV && inRun && V.ev[j].v == runV;
                if (!same) rank++;
                inRun = V.ev[j].hasV;
                runV = V.ev[j].v;
                V.order[j] = rank;
            }
        }
        if (!V.expVoided) {
            V.expAccepted = vm.parseJsonUintArray(doc, ".expect.accepted");
            assertEq(V.expAccepted.length, m, string.concat(V.name, ": accepted length"));
            V.expPayouts = new uint256[](m);
            for (uint256 j = 0; j < m; j++) {
                if (V.ev[j].outcome == V.winner) {
                    V.expPayouts[j] = vm.parseJsonUint(doc, string.concat(".expect.payouts[", vm.toString(j), "]"));
                }
            }
        }
    }

    function _parseEvent(string calldata doc, Vec memory V, uint256 j) internal view {
        string memory p = string.concat(".events[", vm.toString(j), "]");
        Ev memory e = V.ev[j];
        e.cents = vm.parseJsonUint(doc, string.concat(p, ".cents"));
        e.t = vm.parseJsonUint(doc, string.concat(p, ".t"));
        e.outcome = _outcomeIndex(V.outcomes, vm.parseJsonString(doc, string.concat(p, ".side")));
        e.seed = vm.keyExistsJson(doc, string.concat(p, ".seed"));
        e.hasV = vm.keyExistsJson(doc, string.concat(p, ".v"));
        if (e.hasV) e.v = vm.parseJsonUint(doc, string.concat(p, ".v"));
        if (e.seed) V.seed[e.outcome] += e.cents;
    }

    function readKappa(string calldata doc) external pure returns (uint256) {
        return vm.parseJsonUint(doc, ".kappa");
    }

    // ------------------------------------------------------------------ helpers

    function _hex12(bytes32 h) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(12);
        for (uint256 i = 0; i < 6; i++) {
            out[2 * i] = alphabet[uint8(h[i]) >> 4];
            out[2 * i + 1] = alphabet[uint8(h[i]) & 0x0f];
        }
        return string(out);
    }

    function _marketOf(uint256 positionId) internal view returns (uint256 marketId) {
        (uint64 id,,,,,,,,,) = vpm.positions(positionId);
        marketId = id;
    }

    function _outcomeIndex(string[] memory outcomes, string memory side) internal pure returns (uint8) {
        for (uint256 i = 0; i < outcomes.length; i++) {
            if (keccak256(bytes(outcomes[i])) == keccak256(bytes(side))) return uint8(i);
        }
        revert("unknown outcome");
    }

    /// @dev The runner's `later` count (vpm-conformance.mjs compareVector, suite ≥ 1.2):
    ///      non-seed events on the other side, in a strictly later vintage than event j,
    ///      with expected accepted > 0. Seeds rank below every vintage.
    function _laterOpposing(Vec memory V, uint256 j) internal pure returns (uint256 m) {
        for (uint256 k = 0; k < V.ev.length; k++) {
            if (V.ev[k].seed || V.ev[k].outcome == V.ev[j].outcome || V.expAccepted[k] == 0) continue;
            if (V.order[k] > V.order[j]) m++;
        }
    }
}
