// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HunchBase, MockSmartWallet} from "./utils/HunchBase.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @title T2 · HunchVPM: every diff D1–D7 against the reference, one behaviour per test
/// @notice The mechanism itself (Rule 1, Rule 2, vintages, seed clamp, freeze) is proven
///         equal to the reference by Differential.t.sol; this suite covers only what the
///         product adds: the fee on gains (D1), owner-only delivery by anyone (D2), entry
///         bounds (D3), the entries-only pause (D4, incl. T2.9), the signed USDG entry (D5),
///         the views (D6) and the events (D7).
contract HunchVPMTest is HunchBase {
    // ================================================================== constructor

    function test_Constructor_FixesGuardianAndTreasury() public view {
        assertEq(vpm.guardian(), guardian);
        assertEq(vpm.treasury(), treasury);
        assertFalse(vpm.entriesPaused());
        assertEq(vpm.MAX_FEE_BPS(), 500);
        assertEq(
            vpm.ENTER_TYPEHASH(), keccak256("HunchEnter(uint256 marketId,uint8 outcome,uint256 amount,bytes32 salt)")
        );
    }

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert(HunchVPM.ZeroAddress.selector);
        new HunchVPM(address(0), treasury);
        vm.expectRevert(HunchVPM.ZeroAddress.selector);
        new HunchVPM(guardian, address(0));
    }

    // ================================================================== D1 · fee on winners' gains

    function test_D1_CreateRejectsFeeAboveFivePercent() public {
        vm.prank(creator);
        vm.expectRevert(HunchVPM.FeeTooHigh.selector);
        vpm.create(
            IERC20(address(usdg)),
            _seed(10 * USDG, 10 * USDG),
            KAPPA,
            T,
            VOID_TIMEOUT,
            resolver,
            residueOwner,
            501,
            0,
            0
        );
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), KAPPA, 500, 0, 0);
        (uint16 feeBps,,) = vpm.marketTerms(id);
        assertEq(feeBps, 500, "500 bps is the ceiling, inclusive");
    }

    /// @dev The worked example at 200 bps. Gross payouts are the reference's; each winner
    ///      pays floor(gain * 200 / 10_000) and receives the rest.
    function test_D1_WinnersPayTheFeeOnTheirGainOnly() public {
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        uint256 seedUp = vpm.marketPositions(id, 0, 1)[0];
        _settle(id, 0);

        // gross = s·(1 + A_UP(T) − A_UP(entry)), exactly as the reference pays
        assertEq(vpm.previewPayout(p[0]), 69_166_666, "Mei gross");
        assertEq(vpm.previewPayout(p[3]), 56_250_000, "Ben gross");
        assertEq(vpm.previewPayout(seedUp), 44_583_333, "seed UP gross");

        address mei = makeAddr("Mei");
        vm.expectEmit(address(vpm));
        emit HunchVPM.FeeAccrued(p[0], 983_333); // floor(49_166_666 * 0.02)
        vm.expectEmit(address(vpm));
        emit HunchVPM.Claimed(p[0], mei, 68_183_333, 0); // payout field = net amount sent
        vpm.claimFor(p[0]);
        assertEq(usdg.balanceOf(mei), 68_183_333, "Mei receives gross - fee");

        vpm.claimFor(p[3]);
        assertEq(usdg.balanceOf(makeAddr("Ben")), 56_250_000 - 125_000, "Ben: 6.25 gain, 0.125 fee");
        vpm.claimFor(seedUp);
        assertEq(
            usdg.balanceOf(creator), 1e15 - 20 * USDG + 44_583_333 - 691_666, "seed leg pays the fee on its gain too"
        );

        assertEq(vpm.feesAccrued(address(usdg)), 983_333 + 125_000 + 691_666);
        (uint256 pool, uint256 paidOut) = _pool(id);
        assertEq(pool, 170 * USDG);
        assertEq(paidOut, 69_166_666 + 56_250_000 + 44_583_333, "paidOut stays GROSS");

        vm.prank(residueOwner);
        vpm.claimResidue(id);
        assertEq(usdg.balanceOf(residueOwner), 1, "residue is the reference's: one unit of floor dust");
    }

    function test_D1_LosersPayNoFee() public {
        (uint256 id, uint256[5] memory p) = _workedExample(500);
        _settle(id, 0);
        vm.recordLogs();
        vpm.claimFor(p[1]); // Dan, DOWN, lost
        assertEq(vm.getRecordedLogs().length, 1, "only Claimed, no FeeAccrued");
        assertEq(usdg.balanceOf(makeAddr("Dan")), 0);
        assertEq(vpm.feesAccrued(address(usdg)), 0);
        assertEq(vpm.previewFee(p[1]), 0);
    }

    function test_D1_VoidRefundsCarryNoFee() public {
        (uint256 id, uint256[5] memory p) = _workedExample(500);
        _void(id);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(vpm.previewFee(p[i]), 0);
            vpm.claimFor(p[i]);
        }
        assertEq(usdg.balanceOf(makeAddr("Mei")), 20 * USDG, "void refunds accepted principal in full");
        assertEq(usdg.balanceOf(makeAddr("Ben")), 50 * USDG);
        assertEq(vpm.feesAccrued(address(usdg)), 0, "no fee on a void");
    }

    function test_D1_RefusedRemaindersCarryNoFee() public {
        // κ = 2, seed 10/10: the DOWN book can absorb 20 in total, 10 already used by the
        // seed, so Alice's UP 30 is accepted 10 and 20 is refused.
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 200, 0, 0);
        uint256 a = _enterNext(alice, id, 0, 30 * USDG);
        uint256 b = _enterNext(bob, id, 1, 5 * USDG); // vests 5 into UP: A_UP 1.0 → 1.25
        (,,,, uint128 accepted,) = _position(a);
        assertEq(accepted, 10 * USDG);

        _settle(id, 0);
        // gross 10·(1 + 1.25 − 1.0) = 12.5; gain 2.5; fee 0.05; the refused 20 is fee-free
        vm.expectEmit(address(vpm));
        emit HunchVPM.Claimed(a, alice, 12_450_000, 20 * USDG);
        vpm.claimFor(a);
        assertEq(usdg.balanceOf(alice), 12_450_000 + 20 * USDG);
        assertEq(vpm.feesAccrued(address(usdg)), 50_000);
        vpm.claimFor(b);
        assertEq(usdg.balanceOf(bob), 0);
    }

    function test_D1_RefundWithdrawnBeforeResolutionCarriesNoFee() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 500, 0, 0);
        uint256 a = _enterNext(alice, id, 0, 30 * USDG);
        vm.roll(block.number + 1);
        vm.prank(alice);
        vpm.withdrawRefund(a);
        assertEq(usdg.balanceOf(alice), 20 * USDG, "the full refused remainder");
        assertEq(vpm.feesAccrued(address(usdg)), 0);
    }

    /// @dev P4: the last entry of a market is paid exactly 1x, so its gain and its fee are 0.
    function test_D1_ABuzzerEntryPaysNoFee() public {
        uint256 id = _create(500);
        _enterNext(alice, id, 1, 40 * USDG);
        uint256 late = _enterNext(bob, id, 0, 100 * USDG);
        _settle(id, 0);
        assertEq(vpm.previewPayout(late), 100 * USDG, "stake back, nothing vested after it");
        assertEq(vpm.previewFee(late), 0);
        vm.recordLogs();
        vpm.claimFor(late);
        assertEq(vm.getRecordedLogs().length, 2, "Claimed + the token Transfer, no FeeAccrued");
        assertEq(usdg.balanceOf(bob), 100 * USDG);
    }

    /// @dev The residue and the gross payouts are identical to a fee-0 twin market: the fee
    ///      only splits each winner's gross between the winner and `feesAccrued`.
    function test_D1_FeeLeavesPayoutsAndResidueUnchanged() public {
        (uint256 withFee, uint256[5] memory p) = _workedExample(300);
        (uint256 noFee, uint256[5] memory q) = _workedExample(0);
        _settle(withFee, 1);
        vm.prank(resolver);
        vpm.resolve(noFee, 1);
        uint256 fees;
        for (uint256 i = 0; i < 5; i++) {
            assertEq(vpm.previewPayout(p[i]), vpm.previewPayout(q[i]), "same gross payout");
            fees += vpm.previewFee(p[i]);
            vpm.claimFor(p[i]);
            vpm.claimFor(q[i]);
        }
        uint256[] memory seedsA = vpm.marketPositions(withFee, 0, 2);
        uint256[] memory seedsB = vpm.marketPositions(noFee, 0, 2);
        for (uint256 i = 0; i < 2; i++) {
            fees += vpm.previewFee(seedsA[i]);
            vpm.claimFor(seedsA[i]);
            vpm.claimFor(seedsB[i]);
        }
        (uint256 poolA, uint256 paidA) = _pool(withFee);
        (uint256 poolB, uint256 paidB) = _pool(noFee);
        assertEq(poolA, poolB);
        assertEq(paidA, paidB, "gross paidOut, so the residue is the reference's");
        assertEq(vpm.feesAccrued(address(usdg)), fees, "previewFee predicted every fee taken");
        assertGt(fees, 0);
    }

    function testFuzz_D1_FeeIsTheFloorOfGainTimesBps(uint16 feeBps, uint96 early, uint96 against, uint96 late) public {
        feeBps = uint16(bound(feeBps, 0, 500));
        early = uint96(bound(early, 1, 1e12));
        against = uint96(bound(against, 1, 1e12));
        late = uint96(bound(late, 1, 1e12));
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), type(uint256).max, feeBps, 0, 0);
        uint256 a = _enterNext(alice, id, 0, early);
        _enterNext(bob, id, 1, against);
        _enterNext(carol, id, 0, late);
        _settle(id, 0);

        uint256 gross = vpm.previewPayout(a);
        uint256 fee = ((gross - early) * feeBps) / 10_000;
        assertEq(vpm.previewFee(a), fee);
        vpm.claimFor(a);
        assertEq(usdg.balanceOf(alice), gross - fee, "owner receives gross - floor(gain*bps/1e4)");
        assertEq(vpm.feesAccrued(address(usdg)), fee);
        assertLe(fee * 10_000, (gross - early) * feeBps, "never rounds against the winner");
    }

    function test_D1_SweepFeesPaysTheTreasuryAndOnlyTheTreasury() public {
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        _settle(id, 0);
        vpm.claimFor(p[0]);
        uint256 accrued = vpm.feesAccrued(address(usdg));
        assertEq(accrued, 983_333);

        vm.expectEmit(address(vpm));
        emit HunchVPM.FeesSwept(address(usdg), treasury, accrued);
        vm.prank(stranger); // anyone may sweep
        vpm.sweepFees(IERC20(address(usdg)));
        assertEq(usdg.balanceOf(treasury), accrued);
        assertEq(usdg.balanceOf(stranger), 0, "the caller gets nothing");
        assertEq(vpm.feesAccrued(address(usdg)), 0, "zeroed");

        vm.recordLogs();
        vpm.sweepFees(IERC20(address(usdg))); // nothing accrued: a no-op, not a revert
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(usdg.balanceOf(treasury), accrued);
    }

    function test_D1_FeesAreAccountedPerToken() public {
        MockUSDG other = new MockUSDG();
        other.mint(creator, 1e12);
        vm.prank(creator);
        other.approve(address(vpm), type(uint256).max);
        vm.prank(creator);
        uint256 id2 = vpm.create(
            IERC20(address(other)),
            _seed(10 * USDG, 10 * USDG),
            KAPPA,
            T,
            VOID_TIMEOUT,
            resolver,
            residueOwner,
            500,
            0,
            0
        );
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        other.mint(alice, 50 * USDG);
        vm.prank(alice);
        other.approve(address(vpm), type(uint256).max);
        vm.roll(block.number + 1);
        vm.prank(alice);
        vpm.enter(id2, 1, 50 * USDG);

        _settle(id, 0);
        vm.prank(resolver);
        vpm.resolve(id2, 0);
        vpm.claimFor(p[0]);
        vpm.claimFor(vpm.marketPositions(id2, 0, 1)[0]); // the seed UP leg wins 50 of DOWN's money
        uint256 feeA = vpm.feesAccrued(address(usdg));
        uint256 feeB = vpm.feesAccrued(address(other));
        assertEq(feeA, 983_333);
        assertEq(feeB, ((10 * USDG + 50 * USDG) * 500) / 10_000, "seed UP gain = 10 (seed DOWN) + 50");

        vpm.sweepFees(IERC20(address(other)));
        assertEq(other.balanceOf(treasury), feeB);
        assertEq(usdg.balanceOf(treasury), 0, "sweeping one token never touches another");
        assertEq(vpm.feesAccrued(address(usdg)), feeA);
    }

    /// @dev Everything in, everything out: claims + residue + sweep leave the settler empty.
    function test_D1_AFullyDrainedMarketLeavesNothingBehind() public {
        (uint256 id, uint256[5] memory p) = _workedExample(250);
        _settle(id, 1);
        uint256[] memory all = vpm.marketPositions(id, 0, 100);
        assertEq(all.length, 7);
        assertEq(all[2], p[0], "seed legs first, then entries in arrival order");
        for (uint256 i = 0; i < all.length; i++) {
            vpm.claimFor(all[i]);
        }
        vm.prank(residueOwner);
        vpm.claimResidue(id);
        vpm.sweepFees(IERC20(address(usdg)));
        assertEq(usdg.balanceOf(address(vpm)), 0, "not one unit left behind");
        assertGt(usdg.balanceOf(treasury), 0);
    }

    /// @dev Paxos can freeze any address. A frozen treasury blocks only the sweep, never a claim.
    function test_D1_AFrozenTreasuryNeverBlocksAClaim() public {
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        _settle(id, 0);
        usdg.setFrozen(treasury, true);
        vpm.claimFor(p[0]);
        vpm.claimFor(p[3]);
        vm.expectRevert(MockUSDG.AddressFrozen.selector);
        vpm.sweepFees(IERC20(address(usdg)));
        assertEq(vpm.feesAccrued(address(usdg)), 983_333 + 125_000, "fees wait, intact");
        usdg.setFrozen(treasury, false);
        vpm.sweepFees(IERC20(address(usdg)));
        assertEq(usdg.balanceOf(treasury), 983_333 + 125_000);
    }

    // ================================================================== D2 · deliver to the owner

    function test_D2_ClaimForPaysTheOwnerNeverTheCaller() public {
        (uint256 id, uint256[5] memory p) = _workedExample(0);
        _settle(id, 0);
        address mei = makeAddr("Mei");
        vm.expectEmit(address(vpm));
        emit HunchVPM.Claimed(p[0], mei, 69_166_666, 0);
        vm.prank(stranger);
        vpm.claimFor(p[0]);
        assertEq(usdg.balanceOf(mei), 69_166_666);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    function test_D2_WithdrawRefundForPaysTheOwnerNeverTheCaller() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 200, 0, 0);
        uint256 a = _enterNext(alice, id, 0, 30 * USDG);
        vm.roll(block.number + 1);
        vm.expectEmit(address(vpm));
        emit HunchVPM.Claimed(a, alice, 0, 20 * USDG);
        vm.prank(stranger);
        vpm.withdrawRefundFor(a); // also finalizes the vintage, as the reference does
        assertEq(usdg.balanceOf(alice), 20 * USDG);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    function test_D2_TheOwnerOnlyFormsStillCheckTheOwner() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 0, 0, 0);
        uint256 a = _enterNext(alice, id, 0, 30 * USDG);
        vm.roll(block.number + 1);
        vm.prank(stranger);
        vm.expectRevert(HunchVPM.NotOwner.selector);
        vpm.withdrawRefund(a);
        _settle(id, 0);
        vm.prank(stranger);
        vm.expectRevert(HunchVPM.NotOwner.selector);
        vpm.claim(a);
        vm.prank(alice);
        vpm.claim(a);
        assertEq(usdg.balanceOf(alice), 30 * USDG, "accepted 10 at 1x plus the refused 20");
    }

    function test_D2_ClaimForFollowsATransferredPosition() public {
        (uint256 id, uint256[5] memory p) = _workedExample(0);
        address mei = makeAddr("Mei");
        vm.prank(mei);
        vpm.transferPosition(p[0], carol);
        _settle(id, 0);
        vpm.claimFor(p[0]);
        assertEq(usdg.balanceOf(carol), 69_166_666, "the current owner is paid");
        assertEq(usdg.balanceOf(mei), 0);
    }

    function test_D2_ClaimForNeverPaysTwiceOrEarly() public {
        (uint256 id, uint256[5] memory p) = _workedExample(0);
        vm.expectRevert(HunchVPM.NotSettled.selector);
        vpm.claimFor(p[0]);
        _settle(id, 0);
        vpm.claimFor(p[0]);
        vm.expectRevert(HunchVPM.AlreadyClaimed.selector);
        vpm.claimFor(p[0]);
        vm.prank(makeAddr("Mei"));
        vm.expectRevert(HunchVPM.AlreadyClaimed.selector);
        vpm.claim(p[0]);
    }

    function test_D2_WithdrawRefundForRevertsLikeTheReference() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 0, 0, 0);
        uint256 full = _enterNext(bob, id, 1, 5 * USDG); // fully accepted
        uint256 part = _enter(alice, id, 0, 30 * USDG); // same block: not yet finalized
        vm.expectRevert(HunchVPM.NotFinalized.selector);
        vpm.withdrawRefundFor(part);
        vm.roll(block.number + 1);
        vm.expectRevert(HunchVPM.NothingToRefund.selector);
        vpm.withdrawRefundFor(full);
        vpm.withdrawRefundFor(part);
        vm.expectRevert(HunchVPM.NothingToRefund.selector);
        vpm.withdrawRefundFor(part);
    }

    /// @dev A Paxos-frozen winner's claim reverts on its own and blocks nobody else's.
    function test_D2_AFrozenOwnerFailsAlone() public {
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        _settle(id, 0);
        address mei = makeAddr("Mei");
        usdg.setFrozen(mei, true);
        vm.expectRevert(MockUSDG.AddressFrozen.selector);
        vpm.claimFor(p[0]);
        vpm.claimFor(p[3]); // Ben is unaffected
        assertEq(usdg.balanceOf(makeAddr("Ben")), 56_125_000);
        usdg.setFrozen(mei, false);
        vpm.claimFor(p[0]); // and Mei's claim is intact once unfrozen
        assertEq(usdg.balanceOf(mei), 68_183_333);
    }

    /// @dev A paused token reverts every transfer; nothing is lost, and claims resume after.
    function test_D2_APausedTokenLosesNothing() public {
        (uint256 id, uint256[5] memory p) = _workedExample(0);
        _settle(id, 0);
        usdg.setPaused(true);
        vm.expectRevert(MockUSDG.TokenPaused.selector);
        vpm.claimFor(p[0]);
        usdg.setPaused(false);
        vpm.claimFor(p[0]);
        assertEq(usdg.balanceOf(makeAddr("Mei")), 69_166_666);
    }

    // ================================================================== D3 · entry bounds

    function test_D3_CreateRejectsInvertedBounds() public {
        vm.prank(creator);
        vm.expectRevert(HunchVPM.InvalidEntryBounds.selector);
        vpm.create(
            IERC20(address(usdg)), _seed(10 * USDG, 10 * USDG), KAPPA, T, VOID_TIMEOUT, resolver, residueOwner, 0, 5, 4
        );
        // a minimum with no maximum is fine
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), KAPPA, 0, uint128(5 * USDG), 0);
        (, uint128 minEntry, uint128 maxEntry) = vpm.marketTerms(id);
        assertEq(minEntry, 5 * USDG);
        assertEq(maxEntry, 0);
    }

    function test_D3_EntriesOutsideTheBoundsRevert() public {
        uint256 id = _create(0); // 1 to 100 USDG
        _fund(alice, 1_000 * USDG);
        vm.startPrank(alice);
        vm.expectRevert(HunchVPM.EntryTooSmall.selector);
        vpm.enter(id, 0, 1 * USDG - 1);
        vm.expectRevert(HunchVPM.EntryTooLarge.selector);
        vpm.enter(id, 0, 100 * USDG + 1);
        vpm.enter(id, 0, 1 * USDG); // both bounds are inclusive
        vpm.enter(id, 1, 100 * USDG);
        vm.stopPrank();
        (uint16 feeBps, uint128 minEntry, uint128 maxEntry) = vpm.marketTerms(id);
        assertEq(feeBps, 0);
        assertEq(minEntry, 1 * USDG);
        assertEq(maxEntry, 100 * USDG);
    }

    function test_D3_ZeroMeansNoBound() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), KAPPA, 0, 0, 0);
        _enterNext(alice, id, 0, 1); // one base unit
        _enterNext(bob, id, 1, 250 * USDG);
    }

    /// @dev Bounds apply to the OFFERED amount: an in-bounds offer can still be partly filled.
    function test_D3_BoundsApplyToTheOfferNotTheFill() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 0, uint128(15 * USDG), uint128(30 * USDG));
        uint256 a = _enterNext(alice, id, 0, 30 * USDG);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        (,,, uint128 offered, uint128 accepted,) = _position(a);
        assertEq(offered, 30 * USDG);
        assertEq(accepted, 10 * USDG, "accepted below minEntry is fine: the bound is on the offer");
    }

    // ================================================================== D4 · entries pause

    function test_D4_OnlyTheGuardianCanPause() public {
        vm.prank(stranger);
        vm.expectRevert(HunchVPM.NotGuardian.selector);
        vpm.setEntriesPaused(true);
        vm.prank(treasury);
        vm.expectRevert(HunchVPM.NotGuardian.selector);
        vpm.setEntriesPaused(true);

        vm.expectEmit(address(vpm));
        emit HunchVPM.EntriesPaused(true);
        vm.prank(guardian);
        vpm.setEntriesPaused(true);
        assertTrue(vpm.entriesPaused());
    }

    function test_D4_PauseStopsBothEntryPathsAndUnpauseRestoresThem() public {
        uint256 id = _create(0);
        vm.prank(guardian);
        vpm.setEntriesPaused(true);

        _fund(alice, 10 * USDG);
        vm.prank(alice);
        vm.expectRevert(HunchVPM.EntriesArePaused.selector);
        vpm.enter(id, 0, 10 * USDG);

        usdg.mint(bob, 10 * USDG);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signEnter(bobPk, id, 1, 10 * USDG, 0, validBefore, bytes32("s"));
        vm.prank(relayer);
        vm.expectRevert(HunchVPM.EntriesArePaused.selector);
        vpm.enterWithAuthorization(bob, id, 1, 10 * USDG, 0, validBefore, bytes32("s"), sig);
        assertFalse(
            usdg.authorizationState(bob, vpm.enterNonce(id, 1, 10 * USDG, bytes32("s"))),
            "a refused relay leaves the bettor's authorization unused"
        );

        vm.prank(guardian);
        vpm.setEntriesPaused(false);
        vm.prank(alice);
        vpm.enter(id, 0, 10 * USDG);
        vm.prank(relayer);
        uint256 pid = vpm.enterWithAuthorization(bob, id, 1, 10 * USDG, 0, validBefore, bytes32("s"), sig);
        (address owner,,,,,) = _position(pid);
        assertEq(owner, bob, "the same signature relays fine after unpause");
    }

    function test_D4_CreationIsNotAnEntryAndIsNotPaused() public {
        vm.prank(guardian);
        vpm.setEntriesPaused(true);
        uint256 id = _create(200);
        assertEq(vpm.marketPositionCount(id), 2);
    }

    /// @notice T2.9: with entries paused, every non-entry function still succeeds:
    ///         finalizeVintage, resolve, voidMarket, claim, claimFor, withdrawRefund,
    ///         withdrawRefundFor, claimResidue, sweepFees and transferPosition.
    function test_T2_9_WhileEntriesArePausedEveryNonEntryFunctionSucceeds() public {
        // Market A (κ = 2, fee 2%) with partial fills; market B to void.
        uint256 a = _createWith(_seed(10 * USDG, 10 * USDG), 2, 200, 0, 0);
        uint256 b = _create(0);
        uint256 alicePos = _enterNext(alice, a, 0, 30 * USDG); // accepted 10, refused 20
        uint256 bobPos = _enter(bob, a, 0, 30 * USDG); // same vintage: rationed with Alice
        uint256 carolPos = _enterNext(carol, a, 1, 5 * USDG); // finalizes vintage 1
        uint256 bPos = _enter(alice, b, 1, 10 * USDG);
        vm.roll(block.number + 1);

        vm.prank(guardian);
        vpm.setEntriesPaused(true);

        vpm.finalizeVintage(a); // finalizeVintage
        vm.prank(alice);
        vpm.withdrawRefund(alicePos); // withdrawRefund
        vpm.withdrawRefundFor(bobPos); // withdrawRefundFor
        vm.prank(carol);
        vpm.transferPosition(carolPos, stranger); // transferPosition

        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(a, 0); // resolve
        vm.prank(resolver);
        vpm.voidMarket(b); // voidMarket

        vm.prank(alice);
        vpm.claim(alicePos); // claim
        vpm.claimFor(bobPos); // claimFor
        vpm.claimFor(carolPos);
        vpm.claimFor(bPos);
        uint256[] memory seeds = vpm.marketPositions(a, 0, 2);
        vpm.claimFor(seeds[0]);
        vpm.claimFor(seeds[1]);
        vm.prank(residueOwner);
        vpm.claimResidue(a); // claimResidue
        uint256 fees = vpm.feesAccrued(address(usdg));
        assertGt(fees, 0);
        vpm.sweepFees(IERC20(address(usdg))); // sweepFees
        assertEq(usdg.balanceOf(treasury), fees);

        assertTrue(vpm.entriesPaused(), "still paused throughout");
        _fund(alice, 10 * USDG);
        vm.prank(alice);
        vm.expectRevert(HunchVPM.EntriesArePaused.selector);
        vpm.enter(b, 0, 10 * USDG);
    }

    // ================================================================== D5 · signed USDG entry

    function test_D5_EnterNonceBindsChainContractMarketSideAmountAndSalt() public view {
        bytes32 expected = keccak256(
            abi.encode(
                vpm.ENTER_TYPEHASH(), block.chainid, address(vpm), uint256(7), uint8(1), uint256(42), bytes32("x")
            )
        );
        assertEq(vpm.enterNonce(7, 1, 42, bytes32("x")), expected);
        assertTrue(vpm.enterNonce(7, 1, 42, bytes32("x")) != vpm.enterNonce(8, 1, 42, bytes32("x")));
        assertTrue(vpm.enterNonce(7, 1, 42, bytes32("x")) != vpm.enterNonce(7, 0, 42, bytes32("x")));
        assertTrue(vpm.enterNonce(7, 1, 42, bytes32("x")) != vpm.enterNonce(7, 1, 43, bytes32("x")));
        assertTrue(vpm.enterNonce(7, 1, 42, bytes32("x")) != vpm.enterNonce(7, 1, 42, bytes32("y")));
    }

    function test_D5_ARelayedEntryBelongsToTheSignerAndCostsTheRelayerNothing() public {
        uint256 id = _create(200);
        usdg.mint(alice, 25 * USDG);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signEnter(alicePk, id, 0, 25 * USDG, 0, validBefore, bytes32(uint256(1)));
        vm.roll(block.number + 1);
        vm.expectEmit(address(vpm));
        emit HunchVPM.Entered(id, vpm.positionCount(), alice, 0, 25 * USDG, uint64(block.number));
        vm.prank(relayer);
        uint256 pid = vpm.enterWithAuthorization(alice, id, 0, 25 * USDG, 0, validBefore, bytes32(uint256(1)), sig);

        (address owner, uint8 outcome,, uint128 offered,,) = _position(pid);
        assertEq(owner, alice, "owner = from, never the relayer");
        assertEq(outcome, 0);
        assertEq(offered, 25 * USDG);
        assertEq(usdg.balanceOf(alice), 0, "pulled from the signer");
        assertEq(usdg.balanceOf(relayer), 0);
        assertEq(usdg.balanceOf(address(vpm)), 20 * USDG + 25 * USDG);
        assertTrue(usdg.authorizationState(alice, vpm.enterNonce(id, 0, 25 * USDG, bytes32(uint256(1)))));
    }

    /// @dev INV-8: a relayer cannot change the market, the side, the amount or the salt.
    function test_D5_ARelayerCannotChangeWhatWasSigned() public {
        uint256 id = _create(0);
        uint256 other = _create(0);
        usdg.mint(alice, 100 * USDG);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 salt = bytes32("salt");
        bytes memory sig = _signEnter(alicePk, id, 0, 10 * USDG, 0, vb, salt);

        vm.startPrank(relayer);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(alice, other, 0, 10 * USDG, 0, vb, salt, sig); // market
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(alice, id, 1, 10 * USDG, 0, vb, salt, sig); // side
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(alice, id, 0, 20 * USDG, 0, vb, salt, sig); // amount
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, vb, bytes32("other"), sig); // salt
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(bob, id, 0, 10 * USDG, 0, vb, salt, sig); // owner
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, vb + 1, salt, sig); // window
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, vb, salt, sig); // as signed: fine
        vm.stopPrank();
        assertEq(vpm.marketPositionCount(id), 3);
        assertEq(vpm.marketPositionCount(other), 2);
    }

    function test_D5_AnAuthorizationCannotBeReplayed() public {
        uint256 id = _create(0);
        usdg.mint(alice, 100 * USDG);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _signEnter(alicePk, id, 0, 10 * USDG, 0, vb, bytes32("s"));
        vm.prank(relayer);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, vb, bytes32("s"), sig);
        vm.roll(block.number + 1);
        vm.prank(stranger);
        vm.expectRevert(MockUSDG.AuthorizationAlreadyUsed.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, vb, bytes32("s"), sig);
        assertEq(usdg.balanceOf(alice), 90 * USDG, "charged once");
    }

    function test_D5_ExpiredOrNotYetValidAuthorizationsRevert() public {
        uint256 id = _create(0);
        usdg.mint(alice, 100 * USDG);
        uint256 now_ = block.timestamp;

        bytes memory early = _signEnter(alicePk, id, 0, 10 * USDG, now_ + 60, now_ + 3600, bytes32("a"));
        vm.prank(relayer);
        vm.expectRevert(MockUSDG.AuthorizationNotYetValid.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, now_ + 60, now_ + 3600, bytes32("a"), early);

        bytes memory late = _signEnter(alicePk, id, 0, 10 * USDG, 0, now_, bytes32("b"));
        vm.prank(relayer);
        vm.expectRevert(MockUSDG.AuthorizationExpired.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, now_, bytes32("b"), late);

        vm.warp(now_ + 61);
        vm.prank(relayer);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, now_ + 60, now_ + 3600, bytes32("a"), early);
    }

    function test_D5_OnlyTheOwnersKeyCanSign() public {
        uint256 id = _create(0);
        usdg.mint(alice, 100 * USDG);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory bobsSig = _signEnter(bobPk, id, 0, 10 * USDG, 0, vb, bytes32("s"));
        vm.prank(relayer);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, vb, bytes32("s"), bobsSig);
        vm.prank(relayer);
        vm.expectRevert(HunchVPM.ZeroAddress.selector);
        vpm.enterWithAuthorization(address(0), id, 0, 10 * USDG, 0, vb, bytes32("s"), bobsSig);
    }

    /// @dev The signature names HunchVPM as payee under ReceiveWithAuthorization: nobody can
    ///      redeem it directly at the token, as a plain transfer or to themselves.
    function test_D5_TheSignatureIsUselessOutsideHunchVPM() public {
        uint256 id = _create(0);
        usdg.mint(alice, 100 * USDG);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 nonce = vpm.enterNonce(id, 0, 10 * USDG, bytes32("s"));
        bytes memory sig = _signEnter(alicePk, id, 0, 10 * USDG, 0, vb, bytes32("s"));

        vm.prank(stranger);
        vm.expectRevert(MockUSDG.CallerMustBePayee.selector);
        usdg.receiveWithAuthorization(alice, address(vpm), 10 * USDG, 0, vb, nonce, sig);
        vm.prank(stranger);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        usdg.receiveWithAuthorization(alice, stranger, 10 * USDG, 0, vb, nonce, sig);
        vm.prank(stranger);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        usdg.transferWithAuthorization(alice, address(vpm), 10 * USDG, 0, vb, nonce, sig);
        assertEq(usdg.balanceOf(alice), 100 * USDG);
    }

    function test_D5_ASmartWalletCanSign() public {
        uint256 id = _create(0);
        MockSmartWallet wallet = new MockSmartWallet(carol);
        usdg.mint(address(wallet), 40 * USDG);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 nonce = vpm.enterNonce(id, 1, 40 * USDG, bytes32("w"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(carolPk, _digest(address(wallet), 40 * USDG, 0, vb, nonce));
        vm.prank(relayer);
        uint256 pid = vpm.enterWithAuthorization(
            address(wallet), id, 1, 40 * USDG, 0, vb, bytes32("w"), abi.encodePacked(r, s, v)
        );
        (address owner,,,,,) = _position(pid);
        assertEq(owner, address(wallet), "the smart wallet owns the position");
    }

    function test_D5_RelayedEntriesObeyTheMarketsRules() public {
        uint256 id = _create(0); // 1 to 100 USDG
        usdg.mint(alice, 1_000 * USDG);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory big = _signEnter(alicePk, id, 0, 101 * USDG, 0, vb, bytes32("s"));
        vm.prank(relayer);
        vm.expectRevert(HunchVPM.EntryTooLarge.selector);
        vpm.enterWithAuthorization(alice, id, 0, 101 * USDG, 0, vb, bytes32("s"), big);

        bytes memory frozen = _signEnter(alicePk, id, 0, 10 * USDG, 0, T + 1 hours, bytes32("f"));
        vm.warp(T);
        vm.prank(relayer);
        vm.expectRevert(HunchVPM.Frozen.selector);
        vpm.enterWithAuthorization(alice, id, 0, 10 * USDG, 0, T + 1 hours, bytes32("f"), frozen);
    }

    /// @dev Direct and relayed entries of one block form one vintage: the path is irrelevant
    ///      to the mechanism.
    function test_D5_DirectAndRelayedEntriesShareAVintage() public {
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), 2, 0, 0, 0);
        vm.roll(block.number + 1);
        uint256 direct = _enter(bob, id, 0, 30 * USDG);
        uint256 relayed = _relayEnter(alicePk, id, 0, 30 * USDG, bytes32("r"));
        assertEq(vpm.pendingCount(id), 2);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        (,,,, uint128 accD, uint128 eD) = _position(direct);
        (,,,, uint128 accR, uint128 eR) = _position(relayed);
        assertEq(accD, 5 * USDG, "rationed pro-rata: headroom 10 split over 60 offered");
        assertEq(accR, accD);
        assertEq(eR, eD, "same vintage, same entry accumulator");
    }

    function testFuzz_D5_AnyKeyAnyAmount(uint256 pk, uint256 amount, uint8 outcome, bytes32 salt) public {
        pk = bound(pk, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        amount = bound(amount, 1, 1e15);
        outcome = uint8(bound(outcome, 0, 1));
        uint256 id = _createWith(_seed(10 * USDG, 10 * USDG), KAPPA, 200, 0, 0);
        uint256 pid = _relayEnter(pk, id, outcome, amount, salt);
        (address owner, uint8 o,, uint128 offered,,) = _position(pid);
        assertEq(owner, vm.addr(pk));
        assertEq(o, outcome);
        assertEq(offered, amount);
        assertEq(usdg.balanceOf(vm.addr(pk)), 0);
    }

    // ================================================================== D6 · views

    function test_D6_AccruedIsZeroUntilTheVintageIsFinalized() public {
        uint256 id = _create(0);
        uint256 a = _enterNext(alice, id, 0, 20 * USDG);
        assertEq(vpm.accrued(a), 0, "not finalized: acceptance unknown");
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        assertEq(vpm.accrued(a), 20 * USDG, "finalized, nothing vested into UP after it yet");
    }

    /// @dev P2 as a view: `accrued` never goes down while the market is open, and at
    ///      resolution it is exactly what the claim pays (gross of the fee).
    function test_D6_AccruedOnlyRisesAndEqualsThePayoutAtResolution() public {
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        uint256 seedUp = vpm.marketPositions(id, 0, 1)[0];
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        uint256 meiBefore = vpm.accrued(p[0]);
        assertEq(meiBefore, 69_166_666, "every DOWN stake after Mei vested into her book");
        assertEq(vpm.accrued(p[3]), 56_250_000);
        assertEq(vpm.accrued(seedUp), 44_583_333);
        assertEq(vpm.accrued(p[1]), 30 * USDG + (30 * USDG * 625) / 1000, "Dan: 30 x (1 + 3.625 - 3.0)");

        // more DOWN money only raises the UP positions
        uint256 extra = _enterNext(carol, id, 1, 40 * USDG);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        assertGt(vpm.accrued(p[0]), meiBefore);
        assertEq(vpm.accrued(extra), 40 * USDG);

        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, 0);
        uint256[] memory all = vpm.marketPositions(id, 0, 10);
        for (uint256 i = 0; i < all.length; i++) {
            (address owner, uint8 outcome,,,,) = _position(all[i]);
            if (outcome != 0) continue;
            uint256 acc = vpm.accrued(all[i]);
            assertEq(acc, vpm.previewPayout(all[i]), "accrued == previewPayout for a winner");
            uint256 before = usdg.balanceOf(owner);
            uint256 fee = vpm.previewFee(all[i]);
            vpm.claimFor(all[i]);
            assertEq(usdg.balanceOf(owner) - before + fee, acc, "accrued == what the claim pays, gross");
        }
    }

    function test_D6_MarketPositionsPaginates() public {
        uint256 id = _create(0);
        uint256 first = vpm.positionCount() - 2;
        uint256[] memory ids = new uint256[](9);
        ids[0] = first;
        ids[1] = first + 1;
        for (uint256 i = 2; i < 9; i++) {
            ids[i] = _enterNext(alice, id, uint8(i % 2), 5 * USDG);
        }
        assertEq(vpm.marketPositionCount(id), 9);

        uint256[] memory page = vpm.marketPositions(id, 0, 4);
        assertEq(page.length, 4);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(page[i], ids[i]);
        }
        page = vpm.marketPositions(id, 4, 4);
        for (uint256 i = 0; i < 4; i++) {
            assertEq(page[i], ids[4 + i]);
        }
        page = vpm.marketPositions(id, 8, 4);
        assertEq(page.length, 1, "the last page is short");
        assertEq(page[0], ids[8]);
        assertEq(vpm.marketPositions(id, 9, 4).length, 0, "past the end is empty");
        assertEq(vpm.marketPositions(id, 2, 0).length, 0, "count 0 is empty");
        assertEq(vpm.marketPositions(id, 3, type(uint256).max).length, 6, "no overflow on a huge count");
        assertEq(vpm.marketPositions(id, type(uint256).max, 1).length, 0);
        assertEq(vpm.marketPositionCount(999), 0, "an unknown market has no positions");
    }

    function test_D6_MarketPositionsKeepsInterleavedMarketsApart() public {
        uint256 a = _create(0);
        uint256 b = _create(0);
        uint256 a1 = _enterNext(alice, a, 0, 5 * USDG);
        uint256 b1 = _enter(bob, b, 1, 5 * USDG);
        uint256 a2 = _relayEnter(carolPk, a, 1, 7 * USDG, bytes32("c"));
        uint256[] memory pa = vpm.marketPositions(a, 0, 10);
        uint256[] memory pb = vpm.marketPositions(b, 0, 10);
        assertEq(pa.length, 4);
        assertEq(pb.length, 3);
        assertEq(pa[0], 0);
        assertEq(pa[1], 1);
        assertEq(pa[2], a1);
        assertEq(pa[3], a2);
        assertEq(pb[0], 2);
        assertEq(pb[1], 3);
        assertEq(pb[2], b1);
    }

    function test_D6_PreviewFeeIsZeroUntilResolvedAndForLosers() public {
        (uint256 id, uint256[5] memory p) = _workedExample(200);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        assertEq(vpm.previewFee(p[0]), 0, "open market: no fee yet");
        _settle(id, 0);
        assertEq(vpm.previewFee(p[0]), 983_333);
        assertEq(vpm.previewFee(p[3]), 125_000);
        assertEq(vpm.previewFee(p[1]), 0, "loser");
    }

    // ================================================================== D7 · events

    /// @dev The reference events are unchanged: same signatures, same fields, same order.
    function test_D7_ReferenceEventsAreUnchanged() public {
        uint256 id = _create(0);
        vm.roll(block.number + 1);
        uint256 a = _enter(alice, id, 0, 5 * USDG);
        vm.roll(block.number + 1);
        vm.expectEmit(address(vpm));
        emit HunchVPM.VintageFinalized(id, uint64(block.number - 1), 1);
        vpm.finalizeVintage(id);
        vm.warp(T);
        vm.expectEmit(address(vpm));
        emit HunchVPM.Resolved(id, 0);
        vm.prank(resolver);
        vpm.resolve(id, 0);
        vm.expectEmit(address(vpm));
        emit HunchVPM.PositionTransferred(a, alice, bob);
        vm.prank(alice);
        vpm.transferPosition(a, bob);
        assertEq(
            keccak256("MarketCreated(uint256,address,uint8,uint256,uint64)"),
            HunchVPM.MarketCreated.selector,
            "MarketCreated"
        );
        assertEq(keccak256("Entered(uint256,uint256,address,uint8,uint256,uint64)"), HunchVPM.Entered.selector);
        assertEq(keccak256("Claimed(uint256,address,uint256,uint256)"), HunchVPM.Claimed.selector);
        assertEq(keccak256("ResidueClaimed(uint256,address,uint256)"), HunchVPM.ResidueClaimed.selector);
        assertEq(keccak256("Voided(uint256)"), HunchVPM.Voided.selector);
        assertEq(keccak256("FeeAccrued(uint256,uint256)"), HunchVPM.FeeAccrued.selector);
        assertEq(keccak256("FeesSwept(address,address,uint256)"), HunchVPM.FeesSwept.selector);
        assertEq(keccak256("EntriesPaused(bool)"), HunchVPM.EntriesPaused.selector);
    }
}
