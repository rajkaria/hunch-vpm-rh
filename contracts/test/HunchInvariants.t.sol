// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {VestedParimutuel, IERC20 as RefIERC20} from "../src/reference/VestedParimutuel.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @notice Drives HunchVPM the way the venue does, with many bettors, direct and signed
///         (relayed) entries, block vintages, partial fills, refunds, transfers, the guardian's
///         pause, resolution and voids, fee sweeps, donations and an attacker, while keeping an
///         independent ledger. Three markets: A is the venue's (κ 30, fee 2%, 1 to 100 USDG),
///         B has fee 0 and no bounds and is mirrored call for call on the reference settler
///         (INV-6), C has κ 2 and a 5% fee so partial fills and fees meet.
contract HunchHandler is Test {
    HunchVPM public immutable vpm;
    VestedParimutuel public immutable ref;
    MockUSDG public immutable usdg; // HunchVPM's token
    MockUSDG public immutable tokR; // the reference's token

    address public constant GUARDIAN = address(0x6A);
    address public constant TREASURY = address(0x7E);
    address public constant RELAYER = address(0x4E1A);
    address public constant STRANGER = address(0xBAD);
    address public constant RESIDUE = address(0x5E5);

    uint256 public constant MARKETS = 3;
    uint256 public constant MAX_POSITIONS = 72; // keeps every invariant sweep cheap
    uint64 public immutable freeze;
    uint256[MARKETS] public mkt;
    uint16[MARKETS] public fee;
    uint256 public refB;

    uint256[] internal pks;
    address[] public actors;
    uint256[] public allPids; // every HunchVPM position, seeds included
    mapping(uint256 => uint256) public refOf; // HunchVPM pid of market B -> reference pid + 1
    mapping(uint256 => uint256) internal lastAccrued;
    bool[MARKETS] public settled;
    bool[MARKETS] public residueTaken;
    uint256 internal salt;

    // ---- the independent ledger
    uint256 public ghostIn; // every unit that entered HunchVPM through entries and seeds
    uint256 public ghostOut; // every unit that left it
    uint256 public donated; // sent straight to the contract, owed to nobody
    uint256 public swept; // fees sent to the treasury
    uint256 public residuePaid; // residue sent to the residue owner
    uint256 public feesObserved; // Σ of feesAccrued increases seen at claims
    uint256 public feesExpected; // Σ floor(gain·bps/1e4), computed here from position data
    uint256[MARKETS] public grossPaid; // Σ gross winning payouts claimed, per market

    // ---- violation counters (every invariant below asserts its counter is zero)
    uint256 public badPauseScope; // INV-4: a non-entry call failed because entries were paused
    uint256 public pausedEntryLanded; // INV-4: an entry succeeded while paused
    uint256 public badExit; // INV-3: a token left to anyone but the position's owner
    uint256 public badAccrual; // INV-5: accrued() went down
    uint256 public badMirror; // INV-6: market B diverged from the reference
    uint256 public badSignedEntry; // INV-8: a tampered or replayed authorization landed

    // ---- what the campaign actually exercised (test_TheHandlerIsNotVacuous)
    uint256 public landedDirect;
    uint256 public landedSigned;
    uint256 public refundsDelivered;
    uint256 public claimsDelivered;
    uint256 public feesTaken;
    uint256 public settles;

    constructor() {
        vpm = new HunchVPM(GUARDIAN, TREASURY);
        ref = new VestedParimutuel();
        usdg = new MockUSDG();
        tokR = new MockUSDG();
        freeze = uint64(block.timestamp + 3 days);
        for (uint256 i = 0; i < 5; i++) {
            uint256 pk = uint256(keccak256(abi.encode("invariant bettor", i))) >> 8;
            pks.push(pk);
            actors.push(vm.addr(pk));
            vm.prank(vm.addr(pk));
            usdg.approve(address(vpm), type(uint256).max);
            vm.prank(vm.addr(pk));
            tokR.approve(address(ref), type(uint256).max);
        }
        usdg.mint(address(this), 1e12);
        tokR.mint(address(this), 1e12);
        usdg.approve(address(vpm), type(uint256).max);
        tokR.approve(address(ref), type(uint256).max);

        uint256[] memory seed = new uint256[](2);
        seed[0] = 10e6;
        seed[1] = 10e6;
        fee = [uint16(200), 0, 500];
        mkt[0] = vpm.create(IERC20(address(usdg)), seed, 30, freeze, 1 days, address(this), RESIDUE, 200, 1e6, 100e6);
        mkt[1] = vpm.create(IERC20(address(usdg)), seed, 3, freeze, 1 days, address(this), RESIDUE, 0, 0, 0);
        mkt[2] = vpm.create(IERC20(address(usdg)), seed, 2, freeze, 1 days, address(this), RESIDUE, 500, 0, 0);
        refB = ref.create(RefIERC20(address(tokR)), seed, 3, freeze, 1 days, address(this), RESIDUE);
        ghostIn = 60e6;
        for (uint256 i = 0; i < 6; i++) {
            allPids.push(i);
        }
        refOf[2] = 1; // market B's seed legs are reference positions 0 and 1
        refOf[3] = 2;
    }

    // ================================================================== actions

    /// @notice A bettor enters directly (approve + enter).
    function enter(uint256 actorSeed, uint256 marketSeed, uint8 outcome, uint256 amount, bool newBlock) external {
        if (allPids.length >= MAX_POSITIONS) return;
        uint256 k = marketSeed % MARKETS;
        uint256 a = actorSeed % actors.length;
        outcome = uint8(bound(outcome, 0, 1));
        amount = bound(amount, 1, 150e6); // straddles market A's 1-100 USDG bounds
        if (newBlock) vm.roll(block.number + 1);
        usdg.mint(actors[a], amount);
        vm.prank(actors[a]);
        try vpm.enter(mkt[k], outcome, amount) returns (uint256 pid) {
            landedDirect++;
            _landed(k, a, pid, outcome, amount);
        } catch (bytes memory err) {
            _refused(err);
        }
        _afterBookChange(k);
    }

    /// @notice The same entry, signed by the bettor and relayed by the venue (D5).
    function enterSigned(uint256 actorSeed, uint256 marketSeed, uint8 outcome, uint256 amount, bool newBlock) external {
        if (allPids.length >= MAX_POSITIONS) return;
        uint256 k = marketSeed % MARKETS;
        uint256 a = actorSeed % actors.length;
        outcome = uint8(bound(outcome, 0, 1));
        amount = bound(amount, 1, 150e6);
        if (newBlock) vm.roll(block.number + 1);
        usdg.mint(actors[a], amount);
        bytes32 s = bytes32(++salt);
        bytes memory sig = _sign(a, mkt[k], outcome, amount, s);
        vm.prank(RELAYER);
        try vpm.enterWithAuthorization(
            actors[a], mkt[k], outcome, amount, 0, block.timestamp + 1 hours, s, sig
        ) returns (
            uint256 pid
        ) {
            landedSigned++;
            _landed(k, a, pid, outcome, amount);
            // INV-8: the same authorization can never land twice
            vm.prank(STRANGER);
            try vpm.enterWithAuthorization(actors[a], mkt[k], outcome, amount, 0, block.timestamp + 1 hours, s, sig) {
                badSignedEntry++;
            } catch {}
        } catch (bytes memory err) {
            _refused(err);
        }
        _afterBookChange(k);
    }

    /// @notice INV-8: a relayer alters what the bettor signed. It must never land.
    function tamperedRelay(uint256 actorSeed, uint256 marketSeed, uint8 outcome, uint256 amount, uint8 how) external {
        uint256 k = marketSeed % MARKETS;
        uint256 a = actorSeed % actors.length;
        outcome = uint8(bound(outcome, 0, 1));
        amount = bound(amount, 1e6, 100e6);
        usdg.mint(actors[a], amount + 1);
        bytes32 s = bytes32(++salt);
        bytes memory sig = _sign(a, mkt[k], outcome, amount, s);
        address from = actors[a];
        uint256 market = mkt[k];
        how = uint8(bound(how, 0, 4));
        if (how == 0) market = mkt[(k + 1) % MARKETS];
        else if (how == 1) outcome = 1 - outcome;
        else if (how == 2) amount += 1;
        else if (how == 3) s = bytes32(uint256(s) + 1);
        else from = actors[(a + 1) % actors.length];
        vm.prank(RELAYER);
        try vpm.enterWithAuthorization(from, market, outcome, amount, 0, block.timestamp + 1 hours, s, sig) {
            badSignedEntry++;
        } catch {}
    }

    /// @notice Anyone delivers a refused remainder to its owner (D2).
    function withdrawRefundFor(uint256 posSeed) external {
        uint256 pid = allPids[posSeed % allPids.length];
        (, address owner,,,,,,,,) = vpm.positions(pid);
        uint256 before = usdg.balanceOf(owner);
        uint256 vBefore = usdg.balanceOf(address(vpm));
        vm.prank(STRANGER);
        try vpm.withdrawRefundFor(pid) {
            uint256 got = usdg.balanceOf(owner) - before;
            if (vBefore - usdg.balanceOf(address(vpm)) != got) badExit++;
            ghostOut += got;
            refundsDelivered++;
            _mirrorRefund(pid, got);
        } catch (bytes memory err) {
            _nonEntryFailed(err);
        }
        _afterBookChange(_marketIndex(pid));
    }

    function finalize(uint256 marketSeed) external {
        uint256 k = marketSeed % MARKETS;
        vm.roll(block.number + 1);
        try vpm.finalizeVintage(mkt[k]) {}
        catch (bytes memory err) {
            _nonEntryFailed(err);
        }
        if (k == 1) ref.finalizeVintage(refB);
        _afterBookChange(k);
    }

    function advance(uint256 blocks, uint256 secs) external {
        vm.roll(block.number + bound(blocks, 1, 3));
        uint256 target = block.timestamp + bound(secs, 1, 8 hours);
        vm.warp(target > freeze ? freeze : target);
    }

    function transfer(uint256 posSeed, uint256 toSeed) external {
        uint256 pid = allPids[posSeed % allPids.length];
        (, address owner,,,, bool claimed,,,,) = vpm.positions(pid);
        if (claimed) return;
        address to = actors[toSeed % actors.length];
        vm.prank(owner);
        try vpm.transferPosition(pid, to) {
            if (refOf[pid] != 0) {
                vm.prank(owner);
                ref.transferPosition(refOf[pid] - 1, to);
            }
        } catch (bytes memory err) {
            _nonEntryFailed(err);
        }
        _checkMirror();
    }

    /// @notice The guardian flips the entries pause (D4).
    function pause(bool paused) external {
        vm.prank(GUARDIAN);
        vpm.setEntriesPaused(paused);
    }

    /// @notice After the freeze: resolve (mostly) or void a market; market B on both settlers.
    function settle(uint256 marketSeed, uint8 winner, bool voidIt, uint8 gate) external {
        if (gate % 3 != 0) return; // settle rarely, so markets live long enough to fill
        uint256 k = marketSeed % MARKETS;
        if (settled[k]) return;
        vm.roll(block.number + 1);
        if (block.timestamp < freeze) vm.warp(freeze);
        winner = uint8(bound(winner, 0, 1));
        if (voidIt) {
            try vpm.voidMarket(mkt[k]) {}
            catch (bytes memory err) {
                _nonEntryFailed(err);
                return;
            }
            if (k == 1) ref.voidMarket(refB);
        } else {
            try vpm.resolve(mkt[k], winner) {}
            catch (bytes memory err) {
                _nonEntryFailed(err);
                return;
            }
            if (k == 1) ref.resolve(refB, winner);
        }
        settled[k] = true;
        settles++;
        _checkMirror();
    }

    /// @notice Anyone delivers a settled position's payout to its owner (D1, D2).
    function claimFor(uint256 posSeed) external {
        uint256 pid = allPids[posSeed % allPids.length];
        uint256 k = _marketIndex(pid);
        if (!settled[k]) return;
        (, address owner,,,, bool claimed,, uint128 offered, uint128 accepted,) = vpm.positions(pid);
        if (claimed) return;
        (, bool refunded) = _flags(pid);
        uint256 gross = _status(mkt[k]) == 2 ? accepted : vpm.previewPayout(pid);
        uint256 expectedFee = _status(mkt[k]) == 2 || gross == 0 ? 0 : ((gross - accepted) * fee[k]) / 10_000;
        uint256 refund = refunded ? 0 : offered - accepted;
        uint256 before = usdg.balanceOf(owner);
        uint256 vBefore = usdg.balanceOf(address(vpm));
        uint256 fBefore = vpm.feesAccrued(address(usdg));
        vm.prank(STRANGER);
        try vpm.claimFor(pid) {
            uint256 got = usdg.balanceOf(owner) - before;
            uint256 feeTaken = vpm.feesAccrued(address(usdg)) - fBefore;
            if (got != gross - expectedFee + refund) badExit++;
            if (vBefore - usdg.balanceOf(address(vpm)) != got) badExit++;
            feesObserved += feeTaken;
            claimsDelivered++;
            if (feeTaken > 0) feesTaken++;
            feesExpected += expectedFee;
            if (_status(mkt[k]) == 1) grossPaid[k] += gross;
            ghostOut += got;
            _mirrorClaim(pid, got);
        } catch (bytes memory err) {
            _nonEntryFailed(err);
        }
    }

    function claimResidue(uint256 marketSeed) external {
        uint256 k = marketSeed % MARKETS;
        if (!settled[k] || residueTaken[k]) return;
        uint256 before = usdg.balanceOf(RESIDUE);
        vm.prank(RESIDUE);
        try vpm.claimResidue(mkt[k]) {
            residueTaken[k] = true;
            uint256 got = usdg.balanceOf(RESIDUE) - before;
            residuePaid += got;
            ghostOut += got;
            if (k == 1) {
                uint256 rb = tokR.balanceOf(RESIDUE);
                vm.prank(RESIDUE);
                ref.claimResidue(refB);
                if (tokR.balanceOf(RESIDUE) - rb != got) badMirror++;
            }
        } catch (bytes memory err) {
            _nonEntryFailed(err);
        }
    }

    function sweep() external {
        uint256 amount = vpm.feesAccrued(address(usdg));
        uint256 before = usdg.balanceOf(TREASURY);
        vm.prank(STRANGER);
        try vpm.sweepFees(IERC20(address(usdg))) {
            if (usdg.balanceOf(TREASURY) - before != amount) badExit++;
            swept += amount;
            ghostOut += amount;
        } catch (bytes memory err) {
            _nonEntryFailed(err);
        }
    }

    /// @notice Somebody sends USDG straight to the contract. It is owed to nobody.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1e6);
        usdg.mint(address(vpm), amount);
        donated += amount;
    }

    /// @notice An outsider tries everything. None of it may move a unit to them.
    function attack(uint256 posSeed, uint256 marketSeed) external {
        uint256 pid = allPids[posSeed % allPids.length];
        uint256 k = marketSeed % MARKETS;
        vm.startPrank(STRANGER);
        try vpm.claim(pid) {
            badExit++;
        } catch {}
        try vpm.withdrawRefund(pid) {
            badExit++;
        } catch {}
        try vpm.transferPosition(pid, STRANGER) {
            badExit++;
        } catch {}
        try vpm.claimResidue(mkt[k]) {
            badExit++;
        } catch {}
        try vpm.setEntriesPaused(true) {
            badExit++;
        } catch {}
        try vpm.resolve(mkt[k], 0) {
            badExit++;
        } catch {}
        vm.stopPrank();
    }

    // ================================================================== bookkeeping

    function _landed(uint256 k, uint256 a, uint256 pid, uint8 outcome, uint256 amount) internal {
        if (vpm.entriesPaused()) pausedEntryLanded++;
        ghostIn += amount;
        allPids.push(pid);
        if (k == 1) {
            // mirror on the reference: same bettor, same block, same stake
            tokR.mint(actors[a], amount);
            vm.prank(actors[a]);
            try ref.enter(refB, outcome, amount) returns (uint256 rp) {
                refOf[pid] = rp + 1;
            } catch {
                badMirror++;
            }
        }
    }

    function _refused(bytes memory err) internal {
        // an entry may be refused for its own reasons (bounds, freeze, settled market, pause);
        // the pause may be the reason only while entries really are paused
        if (bytes4(err) == HunchVPM.EntriesArePaused.selector && !vpm.entriesPaused()) badPauseScope++;
    }

    /// @dev INV-4: no non-entry function may ever fail because entries are paused.
    function _nonEntryFailed(bytes memory err) internal {
        if (bytes4(err) == HunchVPM.EntriesArePaused.selector) badPauseScope++;
    }

    function _mirrorRefund(uint256 pid, uint256 got) internal {
        if (refOf[pid] == 0) return;
        (, address owner,,,,,,,,) = ref.positions(refOf[pid] - 1);
        uint256 before = tokR.balanceOf(owner);
        vm.prank(owner);
        try ref.withdrawRefund(refOf[pid] - 1) {
            if (tokR.balanceOf(owner) - before != got) badMirror++;
        } catch {
            badMirror++;
        }
    }

    function _mirrorClaim(uint256 pid, uint256 got) internal {
        if (refOf[pid] == 0) return;
        (, address owner,,,,,,,,) = ref.positions(refOf[pid] - 1);
        uint256 before = tokR.balanceOf(owner);
        vm.prank(owner);
        try ref.claim(refOf[pid] - 1) {
            if (tokR.balanceOf(owner) - before != got) badMirror++;
        } catch {
            badMirror++;
        }
    }

    /// @dev INV-5 and INV-6 after anything that can move a book.
    function _afterBookChange(uint256 k) internal {
        if (_status(mkt[k]) == 0) {
            for (uint256 i = 0; i < allPids.length; i++) {
                uint256 pid = allPids[i];
                if (_marketIndex(pid) != k) continue;
                uint256 acc = vpm.accrued(pid);
                if (acc < lastAccrued[pid]) badAccrual++;
                lastAccrued[pid] = acc;
            }
        }
        if (k == 1) _checkMirror();
    }

    function _checkMirror() internal {
        (, bytes memory a) = address(ref).staticcall(abi.encodeCall(ref.getMarket, (refB)));
        (, bytes memory b) = address(vpm).staticcall(abi.encodeCall(vpm.getMarket, (mkt[1])));
        assembly ("memory-safe") {
            mstore(add(a, 0x20), 0) // the token word: each settler has its own token
            mstore(add(b, 0x20), 0)
        }
        if (keccak256(a) != keccak256(b)) badMirror++;
        for (uint8 w = 0; w < 2; w++) {
            if (keccak256(abi.encode(ref.getBook(refB, w))) != keccak256(abi.encode(vpm.getBook(mkt[1], w)))) {
                badMirror++;
            }
        }
    }

    function _sign(uint256 a, uint256 market, uint8 outcome, uint256 amount, bytes32 s)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                actors[a],
                address(vpm),
                amount,
                0,
                block.timestamp + 1 hours,
                vpm.enterNonce(market, outcome, amount, s)
            )
        );
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(pks[a], keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, ss, v);
    }

    // ================================================================== views for the invariants

    function positionsCount() external view returns (uint256) {
        return allPids.length;
    }

    function _marketIndex(uint256 pid) internal view returns (uint256) {
        (uint64 m,,,,,,,,,) = vpm.positions(pid);
        for (uint256 k = 0; k < MARKETS; k++) {
            if (mkt[k] == m) return k;
        }
        revert("unknown market");
    }

    function marketIndex(uint256 pid) external view returns (uint256) {
        return _marketIndex(pid);
    }

    function _status(uint256 id) internal view returns (uint8) {
        (,,,,,,, HunchVPM.Status s,,,,) = vpm.getMarket(id);
        return uint8(s);
    }

    function _flags(uint256 pid) internal view returns (bool finalized, bool refunded) {
        (,,, finalized, refunded,,,,,) = vpm.positions(pid);
    }
}

/// @title T4 · HunchVPM invariants INV-1 … INV-6 and INV-8 (docs/spec/03-contracts.md)
/// @notice Asserted after every call of every run (256 runs × depth 128 in the ci profile).
///         INV-7 (resolver soundness) lives with the resolver: ResolverInvariants.t.sol.
contract HunchInvariantsTest is StdInvariant, Test {
    HunchHandler internal h;
    HunchVPM internal vpm;
    MockUSDG internal usdg;

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(23_000_000);
        h = new HunchHandler();
        vpm = h.vpm();
        usdg = h.usdg();
        targetContract(address(h));
    }

    /// @notice INV-1 Solvency, as an equality: the settler holds exactly what it owes
    ///         (unfilled escrow, unclaimed payouts, unwithdrawn refunds, unclaimed residue),
    ///         plus accrued fees, plus whatever was donated. Computed position by position
    ///         from the contract's own views, and cross-checked against the handler's ledger.
    function invariant_INV1_Solvency() public view {
        uint256 owed = vpm.feesAccrued(address(usdg)) + h.donated();
        for (uint256 k = 0; k < h.MARKETS(); k++) {
            owed += _marketLiability(h.mkt(k));
        }
        for (uint256 i = 0; i < h.positionsCount(); i++) {
            owed += _positionLiability(h.allPids(i));
        }
        uint256 balance = usdg.balanceOf(address(vpm));
        assertEq(balance, owed, "INV-1: balance == escrow + unclaimed + refunds + residue + fees + donations");
        assertEq(balance, h.ghostIn() + h.donated() - h.ghostOut(), "INV-1: independent ledger");
    }

    /// @notice INV-2 Conservation: a resolved market never promises more than its accepted pool,
    ///         its gross paid out is exactly what winners were paid, fees are exactly
    ///         floor(gain·bps/1e4) per winning claim, and a void refunds the pool exactly.
    function invariant_INV2_Conservation() public view {
        for (uint256 k = 0; k < h.MARKETS(); k++) {
            uint256 id = h.mkt(k);
            (,,,,,,, HunchVPM.Status status, uint8 winner,, uint256 pool, uint256 paidOut) = vpm.getMarket(id);
            uint256 promised;
            uint256 acceptedSum;
            for (uint256 i = 0; i < h.positionsCount(); i++) {
                uint256 pid = h.allPids(i);
                if (h.marketIndex(pid) != k) continue;
                (,, uint8 outcome,,,,,, uint128 accepted,) = vpm.positions(pid);
                acceptedSum += accepted;
                if (status == HunchVPM.Status.Resolved && outcome == winner) promised += vpm.previewPayout(pid);
            }
            if (status == HunchVPM.Status.Resolved) {
                assertLe(promised, pool, "INV-2: winners are never promised more than the pool");
                assertEq(paidOut, h.grossPaid(k), "INV-2: paidOut is the gross actually paid");
            }
            if (status == HunchVPM.Status.Voided) {
                assertEq(acceptedSum, pool, "INV-2: a void refunds the pool exactly");
            }
        }
        assertEq(h.feesObserved(), h.feesExpected(), "INV-2: every fee is floor(gain * bps / 1e4)");
        assertEq(vpm.feesAccrued(address(usdg)) + h.swept(), h.feesObserved(), "INV-2: fees are accrued or swept");
    }

    /// @notice INV-3 Exits: tokens leave only to a position's owner, the residue owner or the
    ///         treasury. Outsiders, the relayer and the guardian never receive a unit.
    function invariant_INV3_Exits() public view {
        assertEq(h.badExit(), 0, "INV-3: a payout went to the wrong place or the wrong amount");
        assertEq(usdg.balanceOf(h.STRANGER()), 0, "INV-3: an outsider received tokens");
        assertEq(usdg.balanceOf(h.RELAYER()), 0, "INV-3: the relayer received tokens");
        assertEq(usdg.balanceOf(h.GUARDIAN()), 0, "INV-3: the guardian received tokens");
        assertEq(usdg.balanceOf(h.TREASURY()), h.swept(), "INV-3: the treasury receives swept fees only");
        assertEq(usdg.balanceOf(h.RESIDUE()), h.residuePaid(), "INV-3: the residue owner receives residue only");
    }

    /// @notice INV-4 Pause scope: while paused, only entries fail.
    function invariant_INV4_PauseScope() public view {
        assertEq(h.badPauseScope(), 0, "INV-4: a non-entry call failed because of the pause");
        assertEq(h.pausedEntryLanded(), 0, "INV-4: an entry landed while paused");
    }

    /// @notice INV-5 Monotone accrual (P2): accrued() of a finalized open position never falls.
    function invariant_INV5_MonotoneAccrual() public view {
        assertEq(h.badAccrual(), 0, "INV-5: accrued decreased");
    }

    /// @notice INV-6 Reference equivalence: market B (fee 0, no bounds) matches the reference
    ///         settler driven with the same calls: market, books, and every claim and refund.
    function invariant_INV6_ReferenceEquivalence() public view {
        assertEq(h.badMirror(), 0, "INV-6: HunchVPM diverged from the reference");
    }

    /// @notice INV-8 Signed entries: an authorization whose market, side, amount, salt or owner
    ///         differs from what was signed never lands, and a used one is never replayed.
    function invariant_INV8_SignedEntries() public view {
        assertEq(h.badSignedEntry(), 0, "INV-8: a tampered or replayed authorization landed");
    }

    /// @notice The handler is not vacuous: a scripted pass through it lands direct and signed
    ///         entries, partial fills and refunds, fees, claims and residue on every market,
    ///         with every invariant holding at each step.
    function test_TheHandlerIsNotVacuous() public {
        for (uint256 i = 0; i < 30; i++) {
            h.enter(i, i, uint8(i % 2), 5e6 + i * 3e6, i % 3 == 0);
            h.enterSigned(i + 1, i + 1, uint8((i + 1) % 2), 7e6 + i * 2e6, i % 2 == 0);
            if (i % 5 == 0) h.tamperedRelay(i, i, uint8(i % 2), 10e6, uint8(i));
            if (i % 7 == 0) h.pause(i % 2 == 0);
            _checkAll();
        }
        h.pause(false);
        for (uint256 k = 0; k < 3; k++) {
            h.finalize(k);
        }
        for (uint256 i = 0; i < h.positionsCount(); i++) {
            h.withdrawRefundFor(i);
        }
        h.settle(0, 0, false, 0);
        h.settle(1, 1, false, 0);
        h.settle(2, 0, true, 0);
        for (uint256 i = 0; i < h.positionsCount(); i++) {
            h.claimFor(i);
            _checkAll();
        }
        for (uint256 k = 0; k < 3; k++) {
            h.claimResidue(k);
        }
        h.sweep();
        _checkAll();
        assertGt(h.landedDirect(), 10, "direct entries landed");
        assertGt(h.landedSigned(), 10, "signed entries landed");
        assertGt(h.refundsDelivered(), 0, "partial fills refunded by a third party");
        assertEq(h.claimsDelivered(), h.positionsCount(), "every position claimed");
        assertGt(h.feesTaken(), 0, "fees were taken");
        assertEq(h.settles(), 3, "resolved and voided");
        assertGt(h.residuePaid() + h.swept(), 0);
        assertEq(usdg.balanceOf(address(vpm)), h.donated(), "drained to the unit");
    }

    function _checkAll() internal view {
        invariant_INV1_Solvency();
        invariant_INV2_Conservation();
        invariant_INV3_Exits();
        invariant_INV4_PauseScope();
        invariant_INV5_MonotoneAccrual();
        invariant_INV6_ReferenceEquivalence();
        invariant_INV8_SignedEntries();
    }

    // ------------------------------------------------------------------ liabilities

    function _marketLiability(uint256 id) internal view returns (uint256 owed) {
        (,,,,,,, HunchVPM.Status status, uint8 winner,, uint256 pool,) = vpm.getMarket(id);
        if (status != HunchVPM.Status.Resolved) return 0;
        // unclaimed residue: the pool minus EVERY winner's gross (claimed or not)
        if (_residueTaken(id)) return 0;
        uint256 promised;
        for (uint256 i = 0; i < h.positionsCount(); i++) {
            uint256 pid = h.allPids(i);
            (uint64 m,, uint8 outcome,,,,,,,) = vpm.positions(pid);
            if (m == id && outcome == winner) promised += vpm.previewPayout(pid);
        }
        owed = pool - promised;
    }

    function _residueTaken(uint256 id) internal view returns (bool) {
        for (uint256 k = 0; k < h.MARKETS(); k++) {
            if (h.mkt(k) == id) return h.residueTaken(k);
        }
        return false;
    }

    function _positionLiability(uint256 pid) internal view returns (uint256) {
        (uint64 m,, uint8 outcome,, bool refunded, bool claimed,, uint128 offered, uint128 accepted,) =
            vpm.positions(pid);
        (,,,,,,, HunchVPM.Status status, uint8 winner,,,) = vpm.getMarket(m);
        uint256 refund = refunded ? 0 : offered - accepted;
        if (status == HunchVPM.Status.Open) return refunded ? accepted : offered; // not finalized: offered
        if (claimed) return 0;
        if (status == HunchVPM.Status.Voided) return accepted + refund;
        return (outcome == winner ? vpm.previewPayout(pid) : 0) + refund;
    }
}
