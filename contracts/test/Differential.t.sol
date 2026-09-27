// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20 as RefIERC20} from "../src/reference/VestedParimutuel.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @title T3 · HunchVPM ≡ the reference, exactly
/// @notice With fee 0, no entry bounds and entries unpaused, HunchVPM must behave exactly
///         like the vendored reference settler. Two drivers prove it:
///           1. all 118 published conformance vectors, replayed on both settlers side by
///              side: every create/entry revert, every position (all ten fields), every book,
///              every claim amount and the residue must be IDENTICAL (not within tolerance);
///           2. fuzzed sequences (random outcome counts, κ, seeds, amounts, block gaps,
///              refund withdrawals, transfers, then resolve / resolver void / timeout void),
///              where each HunchVPM call randomly takes the product path (`claimFor`,
///              `withdrawRefundFor`, and signed `enterWithAuthorization` relayed by a third
///              party) while the reference takes its own; after every step the full state and
///              every revert (success flag and revert data) must match.
///         So D2 and D5 are proven to change who may call, never what the mechanism does.
contract DifferentialTest is Test {
    string internal constant VECTORS = "./test/vectors/vpm-vectors.json";
    uint256 internal constant UNBOUNDED = type(uint256).max;

    VestedParimutuel internal ref;
    HunchVPM internal hun;
    MockUSDG internal tokR; // the reference's token
    MockUSDG internal tokH; // HunchVPM's token (EIP-3009 capable)

    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal resolver = makeAddr("resolver");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256[] internal pks; // bettors' keys, so HunchVPM entries can be signed
    address[] internal actors;

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(23_000_000);
        ref = new VestedParimutuel();
        hun = new HunchVPM(guardian, treasury);
        tokR = new MockUSDG();
        tokH = new MockUSDG();
        for (uint256 i = 0; i < 6; i++) {
            uint256 pk = uint256(keccak256(abi.encode("bettor", i))) >> 8;
            pks.push(pk);
            actors.push(vm.addr(pk));
        }
        _fundBoth(address(this), 1e36);
    }

    // ================================================================== driver 1: the 118 vectors

    struct Ev {
        uint8 outcome;
        uint256 cents;
        uint256 t;
        bool seed;
        bool hasV;
        uint256 v;
    }

    struct Vec {
        string name;
        uint8 n;
        uint8 winner;
        bool expVoided;
        uint256 kappa;
        bool hasFreeze;
        uint256 freezeAt;
        Ev[] ev;
        uint256[] seed;
    }

    uint256 public vectorsRun;
    uint256 public claimsCompared;

    function test_AllPublishedVectorsMatchTheReferenceExactly() public {
        string memory json = vm.readFile(VECTORS);
        string[] memory chunks = vm.split(json, "\n  {");
        uint256 count = chunks.length - 1;
        for (uint256 i = 0; i < count; i++) {
            string[] memory body = vm.split(chunks[i + 1], "\n  }");
            this.replayVector(string.concat("{", body[0], "\n}"));
        }
        console.log(
            string.concat(
                "differential: ",
                vm.toString(vectorsRun),
                " vectors; ",
                vm.toString(claimsCompared),
                " claims identical to the unit on HunchVPM and the reference"
            )
        );
        assertEq(vectorsRun, 118, "suite 1.2.0 has 118 vectors");
    }

    function replayVector(string calldata doc) external {
        require(msg.sender == address(this), "internal");
        Vec memory V = _parse(doc);
        vectorsRun += 1;
        Run memory r;
        r.n = V.n;
        r.freeze = uint64(block.timestamp + (V.hasFreeze ? V.freezeAt : 1 days));
        if (!_createVector(V, r)) return;
        _enterVector(V, r);

        vm.roll(block.number + 1);
        vm.warp(r.freeze);
        vm.startPrank(resolver);
        ref.resolve(r.idR, V.winner);
        hun.resolve(r.idH, V.winner);
        vm.stopPrank();
        _assertSameState(r.idR, r.idH, r.firstR, r.firstH, V.name);

        uint256 positions = ref.positionCount() - r.firstR;
        for (uint256 k = 0; k < positions; k++) {
            uint256 before = tokR.balanceOf(address(this));
            ref.claim(r.firstR + k);
            uint256 gotR = tokR.balanceOf(address(this)) - before;
            before = tokH.balanceOf(address(this));
            hun.claim(r.firstH + k);
            uint256 gotH = tokH.balanceOf(address(this)) - before;
            assertEq(gotH, gotR, string.concat(V.name, ": claim of position ", vm.toString(k)));
            claimsCompared += 1;
        }
        uint256 bR = tokR.balanceOf(address(this));
        ref.claimResidue(r.idR);
        uint256 bH = tokH.balanceOf(address(this));
        hun.claimResidue(r.idH);
        assertEq(
            tokH.balanceOf(address(this)) - bH, tokR.balanceOf(address(this)) - bR, string.concat(V.name, ": residue")
        );
        _assertSameState(r.idR, r.idH, r.firstR, r.firstH, V.name);
    }

    function _createVector(Vec memory V, Run memory r) internal returns (bool created) {
        (bool okR, bytes memory retR) = address(ref)
            .call(
                abi.encodeCall(
                    VestedParimutuel.create,
                    (RefIERC20(address(tokR)), V.seed, V.kappa, r.freeze, 1 days, resolver, address(this))
                )
            );
        (bool okH, bytes memory retH) = address(hun)
            .call(
                abi.encodeCall(
                    HunchVPM.create,
                    (IERC20(address(tokH)), V.seed, V.kappa, r.freeze, 1 days, resolver, address(this), 0, 0, 0)
                )
            );
        assertEq(okH, okR, string.concat(V.name, ": create success differs"));
        assertEq(retH, retR, string.concat(V.name, ": create result or revert differs"));
        assertEq(okR, !V.expVoided, string.concat(V.name, ": voided vector"));
        if (!okR) return false;
        r.idR = abi.decode(retR, (uint256));
        r.idH = abi.decode(retH, (uint256));
        r.firstR = ref.positionCount() - V.n;
        r.firstH = hun.positionCount() - V.n;
        return true;
    }

    /// @dev The vendored runner's grouping: consecutive non-seed events sharing `v` share a
    ///      block (one vintage); under `freezeAt` the event time is real and late ones refuse.
    function _enterVector(Vec memory V, Run memory r) internal {
        uint256 t0 = block.timestamp;
        bool inRun;
        uint256 runV;
        for (uint256 j = 0; j < V.ev.length; j++) {
            Ev memory e = V.ev[j];
            if (e.seed) continue;
            if (!(e.hasV && inRun && e.v == runV)) vm.roll(block.number + 1);
            inRun = e.hasV;
            runV = e.v;
            if (V.hasFreeze) vm.warp(t0 + e.t);
            _enterBoth(address(this), r.idR, r.idH, e.outcome, e.cents, string.concat(V.name, ": entry"));
        }
    }

    // ================================================================== driver 2: fuzzed sequences

    struct Run {
        uint256 idR;
        uint256 idH;
        uint256 firstR;
        uint256 firstH;
        uint8 n;
        uint64 freeze;
        uint256 entropy;
        uint256 salt;
    }

    /// @notice What the fuzz driver actually exercised; see test_TheFuzzDriverIsNotVacuous.
    struct Stats {
        uint256 entries;
        uint256 relayed;
        uint256 refusedEntries;
        uint256 frozenRefusals;
        uint256 partialFills;
        uint256 refundsFor;
        uint256 claimsFor;
        uint256 voids;
        uint256 threeWay;
    }

    Stats public stats;

    /// forge-config: default.fuzz.runs = 1000
    /// forge-config: ci.fuzz.runs = 10000
    function testFuzz_RandomSequencesMatchTheReference(uint256 entropy) public {
        Run memory r;
        r.entropy = entropy;
        if (!_createBoth(r)) return; // both refused the same seed with the same error
        uint256 steps = 1 + _pick(r, 24);
        for (uint256 s = 0; s < steps; s++) {
            uint256 op = _pick(r, 20);
            if (op < 14) _fuzzEnter(r);
            else if (op < 16) _fuzzWithdrawRefund(r);
            else if (op < 18) _fuzzFinalize(r);
            else if (op < 19) _fuzzTransfer(r);
            else _fuzzWarp(r);
            _assertSameState(r.idR, r.idH, r.firstR, r.firstH, "after a step");
        }
        _settleBoth(r);
        _drainBoth(r);
    }

    function _createBoth(Run memory r) internal returns (bool created) {
        r.n = _pick(r, 5) == 0 ? 3 : 2; // mostly binary, sometimes 3-way
        uint256[8] memory kappas = [uint256(1), 2, 3, 5, 9, 30, 100, UNBOUNDED];
        uint256 kappa = kappas[_pick(r, 8)];
        uint256[] memory seed = new uint256[](r.n);
        for (uint256 o = 0; o < r.n; o++) {
            seed[o] = _amount(r);
        }
        r.freeze = uint64(block.timestamp + 1 days);
        (bool okR, bytes memory retR) = address(ref)
            .call(
                abi.encodeCall(
                    VestedParimutuel.create,
                    (RefIERC20(address(tokR)), seed, kappa, r.freeze, 1 hours, resolver, address(this))
                )
            );
        (bool okH, bytes memory retH) = address(hun)
            .call(
                abi.encodeCall(
                    HunchVPM.create,
                    (IERC20(address(tokH)), seed, kappa, r.freeze, 1 hours, resolver, address(this), 0, 0, 0)
                )
            );
        assertEq(okH, okR, "create success");
        assertEq(retH, retR, "create result");
        if (!okR) return false;
        r.idR = abi.decode(retR, (uint256));
        r.idH = abi.decode(retH, (uint256));
        r.firstR = ref.positionCount() - r.n;
        r.firstH = hun.positionCount() - r.n;
        if (r.n == 3) stats.threeWay++;
        return true;
    }

    /// @dev resolve (70%), resolver void (15%), timeout void by anyone (15%), always in a later
    ///      block than the last entry: the only case the reference was written for (on Ethereum
    ///      a post-freeze transaction is always in a later block). Settling in the SAME block,
    ///      which Robinhood Chain's L1 block numbers allow, is where HunchVPM deliberately
    ///      differs (D8); SameBlockSettlement.t.sol covers it.
    function _settleBoth(Run memory r) internal {
        uint256 how = _pick(r, 20);
        vm.roll(block.number + 1 + _pick(r, 3));
        if (how < 14) {
            vm.warp(r.freeze + _pick(r, 3600));
            uint8 winner = uint8(_pick(r, r.n));
            vm.startPrank(resolver);
            ref.resolve(r.idR, winner);
            hun.resolve(r.idH, winner);
            vm.stopPrank();
        } else if (how < 17) {
            stats.voids++;
            vm.warp(r.freeze);
            vm.startPrank(resolver);
            ref.voidMarket(r.idR);
            hun.voidMarket(r.idH);
            vm.stopPrank();
        } else {
            stats.voids++;
            vm.warp(uint256(r.freeze) + 1 hours);
            vm.startPrank(stranger);
            ref.voidMarket(r.idR);
            hun.voidMarket(r.idH);
            vm.stopPrank();
        }
        _assertSameState(r.idR, r.idH, r.firstR, r.firstH, "settled");
    }

    /// @dev Every claim in a random order, the owner path on the reference against a random
    ///      mix of `claim` and `claimFor` on HunchVPM, then the residue.
    function _drainBoth(Run memory r) internal {
        uint256 count = ref.positionCount() - r.firstR;
        uint256 offset = _pick(r, count);
        for (uint256 k = 0; k < count; k++) {
            (,,,,,, uint64 vintage, uint128 offered, uint128 accepted,) = ref.positions(r.firstR + k);
            if (vintage != 0 && accepted < offered) stats.partialFills++;
            _claimBoth(r, (k + offset) % count);
        }
        (bool okR, bytes memory retR) = address(ref).call(abi.encodeCall(ref.claimResidue, (r.idR)));
        (bool okH, bytes memory retH) = address(hun).call(abi.encodeCall(hun.claimResidue, (r.idH)));
        assertEq(okH, okR, "claimResidue success");
        assertEq(retH, retR, "claimResidue revert");
        _assertSameState(r.idR, r.idH, r.firstR, r.firstH, "drained");
        assertEq(tokH.balanceOf(address(hun)), tokR.balanceOf(address(ref)), "identical escrow left");
    }

    /// @notice The fuzz driver is not vacuous: over 64 fixed seeds it takes every path it
    ///         claims to take, and each of those paths matched the reference.
    function test_TheFuzzDriverIsNotVacuous() public {
        for (uint256 i = 0; i < 64; i++) {
            testFuzz_RandomSequencesMatchTheReference(uint256(keccak256(abi.encode("seed", i))));
        }
        (
            uint256 entries,
            uint256 relayed,
            uint256 refused,
            uint256 frozen,
            uint256 partialFills,
            uint256 refundsFor,
            uint256 claimsFor,
            uint256 voids,
            uint256 threeWay
        ) = this.stats();
        console.log("entries", entries, "relayed", relayed);
        console.log("refused", refused, "after the freeze", frozen);
        console.log("partial fills", partialFills, "refunds delivered by a third party", refundsFor);
        console.log("claims delivered by a third party", claimsFor, "voids", voids);
        console.log("three-outcome markets", threeWay);
        assertGt(entries, 100);
        assertGt(relayed, 50, "signed, relayed entries");
        assertGt(refused, 0, "invalid / frozen entries refused alike");
        assertGt(frozen, 0, "post-freeze entries refused alike");
        assertGt(partialFills, 10, "Rule 2 partial fills");
        assertGt(refundsFor, 0, "withdrawRefundFor");
        assertGt(claimsFor, 50, "claimFor");
        assertGt(voids, 0, "void paths");
        assertGt(threeWay, 0, "3-outcome markets");
    }

    // ------------------------------------------------------------------ fuzz steps

    function _fuzzEnter(Run memory r) internal {
        if (_pick(r, 3) != 0) vm.roll(block.number + 1 + _pick(r, 2)); // a third stay in the vintage
        uint256 a = _pick(r, actors.length);
        uint8 outcome = uint8(_pick(r, r.n + (_pick(r, 16) == 0 ? 1 : 0))); // rarely an invalid outcome
        uint256 amount = _pick(r, 32) == 0 ? 0 : _amount(r); // rarely a zero amount
        address who = actors[a];
        tokR.mint(who, amount);
        vm.prank(who);
        (bool okR, bytes memory retR) = address(ref).call(abi.encodeCall(ref.enter, (r.idR, outcome, amount)));

        bool okH;
        bytes memory retH;
        bool relayed = _pick(r, 2) == 0;
        if (!relayed) {
            tokH.mint(who, amount);
            vm.prank(who);
            (okH, retH) = address(hun).call(abi.encodeCall(hun.enter, (r.idH, outcome, amount)));
        } else {
            // the same entry, signed by the bettor and relayed by a third party (D5)
            (okH, retH) = _relay(r, a, outcome, amount);
        }
        assertEq(okH, okR, "enter success");
        assertEq(retH, retR, "enter result or revert");
        if (okR) {
            stats.entries++;
            if (relayed) stats.relayed++;
        } else {
            stats.refusedEntries++;
            if (bytes4(retR) == VestedParimutuel.Frozen.selector) stats.frozenRefusals++;
        }
    }

    function _relay(Run memory r, uint256 a, uint8 outcome, uint256 amount)
        internal
        returns (bool ok, bytes memory ret)
    {
        address who = actors[a];
        tokH.mint(who, amount);
        bytes32 salt = bytes32(++r.salt);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _sign(pks[a], hun.enterNonce(r.idH, outcome, amount, salt), amount, vb);
        vm.prank(relayer);
        (ok, ret) = address(hun)
            .call(abi.encodeCall(hun.enterWithAuthorization, (who, r.idH, outcome, amount, 0, vb, salt, sig)));
    }

    /// @dev USDG's ReceiveWithAuthorization(from, to = HunchVPM, value, 0, validBefore, nonce).
    function _sign(uint256 pk, bytes32 nonce, uint256 amount, uint256 validBefore)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                tokH.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), vm.addr(pk), address(hun), amount, 0, validBefore, nonce
            )
        );
        (uint8 v, bytes32 rr, bytes32 ss) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", tokH.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(rr, ss, v);
    }

    function _fuzzWithdrawRefund(Run memory r) internal {
        uint256 count = ref.positionCount() - r.firstR;
        uint256 k = _pick(r, count);
        (, address owner,,,,,,,,) = ref.positions(r.firstR + k);
        uint256 bR = tokR.balanceOf(owner);
        vm.prank(owner);
        (bool okR, bytes memory retR) = address(ref).call(abi.encodeCall(ref.withdrawRefund, (r.firstR + k)));
        uint256 bH = tokH.balanceOf(owner);
        bool viaFor = _pick(r, 2) == 0;
        vm.prank(viaFor ? stranger : owner);
        (bool okH, bytes memory retH) = viaFor
            ? address(hun).call(abi.encodeCall(hun.withdrawRefundFor, (r.firstH + k)))
            : address(hun).call(abi.encodeCall(hun.withdrawRefund, (r.firstH + k)));
        assertEq(okH, okR, "withdrawRefund success");
        assertEq(retH, retR, "withdrawRefund revert");
        if (okH && viaFor) stats.refundsFor++;
        assertEq(tokH.balanceOf(owner) - bH, tokR.balanceOf(owner) - bR, "refund amount, to the owner");
    }

    function _fuzzFinalize(Run memory r) internal {
        if (_pick(r, 2) == 0) vm.roll(block.number + 1);
        ref.finalizeVintage(r.idR);
        hun.finalizeVintage(r.idH);
    }

    function _fuzzTransfer(Run memory r) internal {
        uint256 count = ref.positionCount() - r.firstR;
        uint256 k = _pick(r, count);
        (, address owner,,,,,,,,) = ref.positions(r.firstR + k);
        address to = actors[_pick(r, actors.length)];
        vm.prank(owner);
        ref.transferPosition(r.firstR + k, to);
        vm.prank(owner);
        hun.transferPosition(r.firstH + k, to);
    }

    /// @dev Time passes; one warp in eight jumps to the freeze, after which every entry must
    ///      be refused by both settlers alike.
    function _fuzzWarp(Run memory r) internal {
        if (_pick(r, 8) == 0) {
            vm.warp(r.freeze);
            return;
        }
        uint256 target = block.timestamp + _pick(r, 6 hours);
        if (target > r.freeze) target = r.freeze;
        vm.warp(target);
    }

    function _claimBoth(Run memory r, uint256 k) internal {
        (, address owner,,,,,,,,) = ref.positions(r.firstR + k);
        uint256 bR = tokR.balanceOf(owner);
        vm.prank(owner);
        (bool okR, bytes memory retR) = address(ref).call(abi.encodeCall(ref.claim, (r.firstR + k)));
        uint256 bH = tokH.balanceOf(owner);
        bool viaFor = _pick(r, 2) == 0;
        vm.prank(viaFor ? stranger : owner);
        (bool okH, bytes memory retH) = viaFor
            ? address(hun).call(abi.encodeCall(hun.claimFor, (r.firstH + k)))
            : address(hun).call(abi.encodeCall(hun.claim, (r.firstH + k)));
        assertEq(okH, okR, "claim success");
        assertEq(retH, retR, "claim revert");
        if (okH && viaFor) stats.claimsFor++;
        assertEq(tokH.balanceOf(owner) - bH, tokR.balanceOf(owner) - bR, "claim amount, to the owner");
    }

    // ------------------------------------------------------------------ shared

    function _enterBoth(address who, uint256 idR, uint256 idH, uint8 outcome, uint256 amount, string memory what)
        internal
    {
        vm.prank(who);
        (bool okR, bytes memory retR) = address(ref).call(abi.encodeCall(ref.enter, (idR, outcome, amount)));
        vm.prank(who);
        (bool okH, bytes memory retH) = address(hun).call(abi.encodeCall(hun.enter, (idH, outcome, amount)));
        assertEq(okH, okR, string.concat(what, " success"));
        assertEq(retH, retR, string.concat(what, " result or revert"));
    }

    /// @dev Market scalars (all but the token), every book, the pending count, and all ten
    ///      fields of every position.
    function _assertSameState(uint256 idR, uint256 idH, uint256 firstR, uint256 firstH, string memory what)
        internal
        view
    {
        _assertSameMarket(idR, idH, what);
        (,,,,,, uint8 n,,,,,) = ref.getMarket(idR);
        for (uint8 w = 0; w < n; w++) {
            VestedParimutuel.Book memory a = ref.getBook(idR, w);
            HunchVPM.Book memory b = hun.getBook(idH, w);
            assertEq(abi.encode(b), abi.encode(a), string.concat(what, ": book"));
        }
        assertEq(hun.pendingCount(idH), ref.pendingCount(idR), string.concat(what, ": pending"));
        uint256 count = ref.positionCount() - firstR;
        assertEq(hun.positionCount() - firstH, count, string.concat(what, ": position count"));
        for (uint256 k = 0; k < count; k++) {
            _assertSamePosition(firstR + k, firstH + k, idR, idH, what);
        }
    }

    /// @dev All twelve `getMarket` words except the token (each settler has its own token).
    function _assertSameMarket(uint256 idR, uint256 idH, string memory what) internal view {
        (, bytes memory a) = address(ref).staticcall(abi.encodeCall(ref.getMarket, (idR)));
        (, bytes memory b) = address(hun).staticcall(abi.encodeCall(hun.getMarket, (idH)));
        assertEq(a.length, 12 * 32);
        assembly ("memory-safe") {
            mstore(add(a, 0x20), 0)
            mstore(add(b, 0x20), 0)
        }
        assertEq(b, a, string.concat(what, ": market"));
        assertEq(hun.feesAccrued(address(tokH)), 0, "fee 0: nothing accrues");
    }

    /// @dev All ten `positions` fields; the market id is compared against each settler's own.
    function _assertSamePosition(uint256 pR, uint256 pH, uint256 idR, uint256 idH, string memory what) internal view {
        (, bytes memory a) = address(ref).staticcall(abi.encodeWithSignature("positions(uint256)", pR));
        (, bytes memory b) = address(hun).staticcall(abi.encodeWithSignature("positions(uint256)", pH));
        assertEq(a.length, 10 * 32);
        (uint256 mR, uint256 mH) = (uint256(bytes32(a)), uint256(bytes32(b)));
        assertEq(mR, idR);
        assertEq(mH, idH);
        assembly ("memory-safe") {
            mstore(add(a, 0x20), 0)
            mstore(add(b, 0x20), 0)
        }
        assertEq(b, a, string.concat(what, ": position"));
        assertEq(hun.previewPayout(pH), ref.previewPayout(pR), string.concat(what, ": previewPayout"));
    }

    function _fundBoth(address who, uint256 amount) internal {
        tokR.mint(who, amount);
        tokH.mint(who, amount);
        vm.startPrank(who);
        tokR.approve(address(ref), type(uint256).max);
        tokH.approve(address(hun), type(uint256).max);
        vm.stopPrank();
        for (uint256 i = 0; i < actors.length; i++) {
            vm.startPrank(actors[i]);
            tokR.approve(address(ref), type(uint256).max);
            tokH.approve(address(hun), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev Deterministic draws from the fuzzed entropy.
    function _pick(Run memory r, uint256 modulo) internal pure returns (uint256) {
        if (modulo == 0) return 0;
        r.entropy = uint256(keccak256(abi.encode(r.entropy)));
        return r.entropy % modulo;
    }

    /// @dev Log-uniform amounts from 1 unit to ~1e13 units, so both dust and whales appear.
    function _amount(Run memory r) internal pure returns (uint256) {
        uint256 digits = 1 + _pick(r, 13);
        return 1 + _pick(r, 10 ** digits);
    }

    // ------------------------------------------------------------------ vector parsing

    function _parse(string calldata doc) internal view returns (Vec memory V) {
        V.name = vm.parseJsonString(doc, ".name");
        string[] memory outcomes = vm.parseJsonStringArray(doc, ".outcomes");
        V.n = uint8(outcomes.length);
        V.winner = _outcomeIndex(outcomes, vm.parseJsonString(doc, ".winner"));
        V.expVoided = vm.parseJsonBool(doc, ".expect.voided");
        V.hasFreeze = vm.keyExistsJson(doc, ".freezeAt");
        if (V.hasFreeze) V.freezeAt = vm.parseJsonUint(doc, ".freezeAt");
        try this.readKappa(doc) returns (uint256 k) {
            V.kappa = k;
        } catch {
            V.kappa = 0; // the non-integer κ = 0.5 vector: below the κ ≥ 1 domain, both revert
        }
        uint256 m = 0;
        while (vm.keyExistsJson(doc, string.concat(".events[", vm.toString(m), "]"))) m++;
        V.ev = new Ev[](m);
        V.seed = new uint256[](outcomes.length);
        for (uint256 j = 0; j < m; j++) {
            string memory p = string.concat(".events[", vm.toString(j), "]");
            Ev memory e = V.ev[j];
            e.cents = vm.parseJsonUint(doc, string.concat(p, ".cents"));
            e.t = vm.parseJsonUint(doc, string.concat(p, ".t"));
            e.outcome = _outcomeIndex(outcomes, vm.parseJsonString(doc, string.concat(p, ".side")));
            e.seed = vm.keyExistsJson(doc, string.concat(p, ".seed"));
            e.hasV = vm.keyExistsJson(doc, string.concat(p, ".v"));
            if (e.hasV) e.v = vm.parseJsonUint(doc, string.concat(p, ".v"));
            if (e.seed) V.seed[e.outcome] += e.cents;
        }
    }

    function readKappa(string calldata doc) external pure returns (uint256) {
        return vm.parseJsonUint(doc, ".kappa");
    }

    function _outcomeIndex(string[] memory outcomes, string memory side) internal pure returns (uint8) {
        for (uint256 i = 0; i < outcomes.length; i++) {
            if (keccak256(bytes(outcomes[i])) == keccak256(bytes(side))) return uint8(i);
        }
        revert("unknown outcome");
    }
}
