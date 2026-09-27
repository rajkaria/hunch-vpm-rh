// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @title Mechanism unit tests: the paths the vectors cannot exercise
/// @notice §4.2 worked example by hand, §12 freeze / resolve / void, the V4 void-refund
///         identity, the reserved vintage 0 (a same-block third party lands in vintage 1),
///         the seed clamp on asymmetric seeds, κ unbounded, pull-based claims, transfer.
contract MechanismTest is Test {
    VestedParimutuel vpm;
    MockERC20 token;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address resolver = address(0x5E50);
    address sink = address(0x51DE);
    uint64 T;

    function setUp() public {
        token = new MockERC20();
        vpm = new VestedParimutuel();
        vm.warp(1_000_000);
        vm.roll(100);
        T = uint64(block.timestamp + 1 days);
        for (uint256 i = 0; i < 3; i++) {
            address a = [address(this), alice, bob][i];
            token.mint(a, 1e24);
            vm.prank(a);
            token.approve(address(vpm), type(uint256).max);
        }
    }

    function _seed(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        s[0] = a;
        s[1] = b;
    }

    function _create(uint256[] memory seed, uint256 kappa) internal returns (uint256) {
        return vpm.create(IERC20(address(token)), seed, kappa, T, 1 days, resolver, sink);
    }

    function _enterAs(address who, uint256 id, uint8 o, uint256 amt) internal returns (uint256 pid) {
        vm.roll(block.number + 1);
        vm.prank(who);
        pid = vpm.enter(id, o, amt);
    }

    // §4.2: the worked example, both branches, straight from the paper's tables
    function test_WorkedExample42() public {
        uint256 id = _create(_seed(2500, 2500), 9);
        uint256 a = _enterAs(alice, id, 0, 10000);
        uint256 b = _enterAs(bob, id, 1, 20000);
        uint256 c = _enterAs(alice, id, 0, 30000);
        uint256 d = _enterAs(bob, id, 1, 20000);
        uint256 e = _enterAs(alice, id, 0, 20000);
        vm.roll(block.number + 1);
        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, 0);
        (,,,,,,,,,, uint256 pool,) = vpm.getMarket(id);
        assertEq(pool, 105000, "accepted pool $1,050");
        // the paper's cents are largest-remainder; the on-chain form floors (§3), so ±1
        assertApproxEqAbs(vpm.previewPayout(0), 10176, 1, "creator YES leg 4.070x"); // paper: $101.76
        assertApproxEqAbs(vpm.previewPayout(a), 30706, 1, "A 3.071x"); // $307.06 (floors to 30705)
        assertApproxEqAbs(vpm.previewPayout(c), 44118, 1, "C 1.471x"); // $441.18
        assertEq(vpm.previewPayout(e), 20000, "E pays exactly 1x (P4): no floor to lose");
        assertEq(vpm.previewPayout(b), 0, "B is on the losing side");
        assertEq(vpm.previewPayout(d), 0);
        // conservation: winners + residue == pool, residue ≤ one unit per winner (§6)
        uint256 sum = vpm.previewPayout(0) + vpm.previewPayout(a) + vpm.previewPayout(c) + vpm.previewPayout(e);
        assertLe(sum, 105000, "never overpays");
        assertLe(105000 - sum, 4, "residue at most one unit per winning position");
    }

    // §12: entries at or after the resolution timestamp are refused in full
    function test_FreezeRefusesEntry() public {
        uint256 id = _create(_seed(5000, 5000), 9);
        vm.roll(block.number + 1);
        vm.warp(T - 1);
        vpm.enter(id, 0, 100); // one second before the freeze: accepted into the vintage
        vm.warp(T);
        vm.expectRevert(VestedParimutuel.Frozen.selector);
        vpm.enter(id, 0, 100);
        // and the resolver cannot resolve BEFORE the freeze
        vm.warp(T - 1);
        vm.prank(resolver);
        vm.expectRevert(VestedParimutuel.TooEarly.selector);
        vpm.resolve(id, 0);
        // resolution latency is harmless: the accumulator froze at T
        vm.warp(T + 30 days);
        vm.roll(block.number + 5);
        vm.prank(resolver);
        vpm.resolve(id, 0);
    }

    // §12 / V4: void refunds every position at accepted principal; refused remainders too
    function test_VoidRefundsAcceptedPrincipal() public {
        uint256 id = _create(_seed(1000, 1000), 3); // headroom on each book: 3000 − 1000 = 2000
        uint256 p0 = _enterAs(alice, id, 0, 10000); // partial fill: 2000 accepted, 8000 refused
        uint256 p1 = _enterAs(bob, id, 1, 500);
        vm.roll(block.number + 1);
        vm.warp(T);
        vm.expectRevert(VestedParimutuel.TooEarly.selector);
        vpm.voidMarket(id); // a stranger must wait for the timeout
        vm.warp(T + 1 days);
        vpm.voidMarket(id); // anyone, after resolutionTime + voidTimeout
        (,,,,,,,, uint128 acc0,) = vpm.positions(p0);
        assertEq(acc0, 2000);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vpm.claim(p0);
        assertEq(token.balanceOf(alice) - before, 10000, "accepted principal + refused remainder");
        before = token.balanceOf(bob);
        vm.prank(bob);
        vpm.claim(p1);
        assertEq(token.balanceOf(bob) - before, 500);
        vpm.claim(0);
        vpm.claim(1);
        assertEq(token.balanceOf(address(vpm)), 0, "every unit refunded, nothing stranded");
        vm.prank(sink);
        vm.expectRevert(VestedParimutuel.NotSettled.selector);
        vpm.claimResidue(id); // no residue on a void
    }

    // §4.4 / A3: a third party in the creation block lands in vintage 1, never vintage 0
    function test_CreationBlockEntryIsVintageOne() public {
        uint256 id = _create(_seed(5000, 5000), 9);
        vm.prank(bob);
        uint256 p = vpm.enter(id, 1, 5000); // same block as the seed
        (,,,,,, uint64 vintage,,,) = vpm.positions(p);
        assertEq(vintage, uint64(block.number));
        assertGt(vintage, 0);
        vm.roll(block.number + 1);
        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, 1);
        // the seed's NO leg received bob's full 5000 (P6 floor holds: 5000 + 5000 ≥ 10000 staked)
        assertEq(vpm.previewPayout(1), 10000);
        assertEq(vpm.previewPayout(p), 5000, "bob vested nothing from the seed: vintage-0 legs vest only to each other");
    }

    // §4.4 (i)-(iii): a same-block batch is rationed pro-rata and never vests to itself
    function test_BlockVintageRationing() public {
        uint256 id = _create(_seed(1000, 1000), 3); // each book: headroom 2000
        vm.roll(block.number + 1);
        vm.prank(alice);
        uint256 big = vpm.enter(id, 0, 1500);
        vm.prank(bob);
        uint256 small = vpm.enter(id, 0, 1500); // joint demand 3000 > 2000
        vm.prank(alice);
        uint256 opp = vpm.enter(id, 1, 900); // opposite side, same block: must not vest to big/small
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        (,,,,,,,, uint128 aBig,) = vpm.positions(big);
        (,,,,,,,, uint128 aSmall,) = vpm.positions(small);
        (,,,,,,,, uint128 aOpp,) = vpm.positions(opp);
        assertEq(aBig, 1000, "1500 * 2000 / 3000");
        assertEq(aSmall, 1000);
        assertEq(aOpp, 900);
        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, 0);
        // opp's 900 vested into the vintage-start YES book (the 1000 seed leg only)
        assertEq(vpm.previewPayout(0), 1000 + 1000 + 900, "seed leg: own 1000 + seed cross-vest 1000 + opp 900");
        assertEq(vpm.previewPayout(big), 1000, "no same-vintage vesting");
        assertEq(vpm.previewPayout(small), 1000);
    }

    // §4.4 creation: asymmetric seeds are clamped to the Rule-2 fixed point; zero legs void
    function test_SeedClampAndVoidAtCreation() public {
        uint256 before = token.balanceOf(address(this));
        _create(_seed(1000, 20000), 9); // NO clamps to 9 * 1000
        assertEq(before - token.balanceOf(address(this)), 10000, "only the accepted seed is pulled");
        (,,,, bool refunded,,, uint128 offered, uint128 accepted,) = vpm.positions(1);
        assertEq(offered, 20000);
        assertEq(accepted, 9000);
        assertTrue(refunded);
        vm.expectRevert(VestedParimutuel.InvalidSeed.selector);
        _create(_seed(5000, 0), 9);
        vm.expectRevert(VestedParimutuel.InvalidKappa.selector);
        _create(_seed(5000, 5000), 0);
        uint256[] memory one = new uint256[](1);
        one[0] = 5;
        vm.expectRevert(VestedParimutuel.InvalidOutcomes.selector);
        _create(one, 9);
    }

    // §4.3: κ unbounded — no headroom to exhaust, the n-way freeze cannot happen
    function test_KappaUnboundedNeverRations() public {
        uint256[] memory s = new uint256[](3);
        s[0] = 5000;
        s[1] = 5000;
        s[2] = 5000;
        uint256 id = _create(s, vpm.KAPPA_UNBOUNDED());
        assertEq(vpm.headroom(id, 0), type(uint256).max);
        _enterAs(alice, id, 1, 45000); // the P9 griefer
        uint256 p = _enterAs(bob, id, 0, 200000); // the informed entry clears in full
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        (,,,,,,,, uint128 acc,) = vpm.positions(p);
        assertEq(acc, 200000);
        // and the same log at κ = 9 blocks it entirely (P9)
        uint256 id9 = _create(s, 9);
        _enterAs(alice, id9, 1, 45000);
        uint256 p9 = _enterAs(bob, id9, 0, 200000);
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id9);
        (,,,,,,,, uint128 acc9,) = vpm.positions(p9);
        assertEq(acc9, 0, "P9: the thin C book gates every entry opposing it");
    }

    // §6 (b), §11: pull-based claims, the residue owner, and whole-position transfer
    function test_ClaimsAreIndependentAndTransferable() public {
        uint256 id = _create(_seed(3000, 3000), 9);
        uint256 p = _enterAs(alice, id, 0, 7000);
        _enterAs(bob, id, 1, 7000);
        vm.roll(block.number + 1);
        // alice sells her position whole to bob before resolution
        vm.prank(alice);
        vpm.transferPosition(p, bob);
        vm.prank(alice);
        vm.expectRevert(VestedParimutuel.NotOwner.selector);
        vpm.claim(p);
        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, 0);
        // residue is gated on the last winner claiming
        vm.prank(sink);
        vm.expectRevert(VestedParimutuel.WinnersOutstanding.selector);
        vpm.claimResidue(id);
        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        vpm.claim(p);
        uint256 got = token.balanceOf(bob) - before;
        assertEq(got, 7000 + 4900, "7000 principal + 7000*7000/10000 of bob's opposing 7000");
        vm.prank(bob);
        vm.expectRevert(VestedParimutuel.AlreadyClaimed.selector);
        vpm.claim(p);
        vpm.claim(0); // creator's winning seed leg: 3000 + 3000 + 7000*3000/10000 = 8100
        (,,,,,,,,,, uint256 pool, uint256 paid) = vpm.getMarket(id);
        assertEq(pool, 20000);
        assertEq(paid, 11900 + 8100);
        vm.prank(sink);
        vpm.claimResidue(id); // residue 0 here, still the sink's call and nobody else's
        vm.prank(alice);
        vm.expectRevert(VestedParimutuel.NotResidueOwner.selector);
        vpm.claimResidue(id);
    }
}
