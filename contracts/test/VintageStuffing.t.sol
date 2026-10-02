// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20 as RefIERC20} from "../src/reference/VestedParimutuel.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @title D9 · Lock prevention: a vintage cannot be stuffed past the block gas limit, and
///        finalizing never reverts
/// @notice Finalizing a vintage costs about 34,000 gas per entry, and every way out of a market
///         (the next entry, `finalizeVintage`, `resolve`, `voidMarket`, a pre-settlement
///         refund) finalizes first. On Robinhood Chain a vintage is one L1 block (~12 s, dozens
///         of L2 blocks), so without a cap anyone could pour ~1,000 minimum entries into one
///         vintage and make its finalization exceed the 32M block gas limit: the market could
///         then never settle and every stake in it would be locked for good. HunchVPM caps a
///         vintage at MAX_VINTAGE_ENTRIES (D9). Finalizing also loops over every outcome for
///         every entry, and `create` is permissionless up to 255 outcomes, so the entry cap
///         alone did not bound it (independent review, M-2): a vintage also holds at most
///         MAX_VINTAGE_WORK entry-outcome pairs. And κ·a is computed at finalization, so a huge
///         finite κ could overflow there (I-1): a finite κ is at most MAX_KAPPA.
contract VintageStuffingTest is Test {
    uint256 internal constant BLOCK_GAS_LIMIT = 32_000_000; // Arbitrum Orbit default
    /// @notice the pinned ceiling for finalizing the worst full vintage any creatable market allows
    uint256 internal constant WORST_FINALIZE_GAS = 25_000_000;
    MockUSDG internal usdg;
    address internal stuffer = makeAddr("stuffer");
    address internal resolver = makeAddr("resolver");
    uint64 internal T;

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(23_000_000);
        usdg = new MockUSDG();
        usdg.mint(address(this), 1e30);
        usdg.mint(stuffer, 1e30);
        T = uint64(block.timestamp + 1 days);
    }

    function _seed() internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        s[0] = 10e6;
        s[1] = 10e6;
    }

    /// @notice The reference: 1,100 one-unit entries in one vintage, and neither finalizing nor
    ///         voiding fits in a block any more (each measured as its own transaction: cold).
    function test_TheReferenceCanBeLockedByStuffingOneVintage() public {
        VestedParimutuel ref = new VestedParimutuel();
        usdg.approve(address(ref), type(uint256).max);
        uint256 id = ref.create(RefIERC20(address(usdg)), _seed(), 30, T, 1 days, resolver, resolver);
        vm.roll(block.number + 1);
        vm.startPrank(stuffer);
        usdg.approve(address(ref), type(uint256).max);
        for (uint256 i = 0; i < 1_100; i++) {
            ref.enter(id, uint8(i % 2), 1);
        }
        vm.stopPrank();
        vm.roll(block.number + 1);
        vm.cool(address(ref));
        vm.cool(address(usdg));
        (bool ok,) = address(ref).call{gas: BLOCK_GAS_LIMIT}(abi.encodeCall(ref.finalizeVintage, (id)));
        assertFalse(ok, "finalizing 1,100 entries does not fit in a block");
        vm.warp(T + 2 days);
        vm.cool(address(ref));
        (ok,) = address(ref).call{gas: BLOCK_GAS_LIMIT}(abi.encodeCall(ref.voidMarket, (id)));
        assertFalse(ok, "and neither does the timeout void: the market is locked");
    }

    /// @notice HunchVPM: the 201st entry of a vintage waits for the next block; a full vintage
    ///         finalizes, and settles, comfortably inside a block.
    function test_HunchVPMCapsAVintageSoItAlwaysFinalizes() public {
        HunchVPM vpm = new HunchVPM(makeAddr("guardian"), makeAddr("treasury"), address(this), address(0));
        usdg.approve(address(vpm), type(uint256).max);
        uint256 id = vpm.create(IERC20(address(usdg)), _seed(), 30, T, 1 days, resolver, resolver, 0, 0, 0);
        assertEq(vpm.MAX_VINTAGE_ENTRIES(), 200);
        assertEq(vpm.MAX_VINTAGE_WORK(), 12_800, "200 entries x 64 outcomes");
        vm.roll(block.number + 1);
        vm.startPrank(stuffer);
        usdg.approve(address(vpm), type(uint256).max);
        for (uint256 i = 0; i < 200; i++) {
            vpm.enter(id, uint8(i % 2), 1);
        }
        vm.expectRevert(HunchVPM.VintageFull.selector);
        vpm.enter(id, 0, 1);
        vm.stopPrank();
        assertEq(vpm.pendingCount(id), 200);

        // settle in the same block (D8): the full vintage finalizes inside the resolve
        vm.warp(T);
        vm.cool(address(vpm));
        vm.cool(address(usdg));
        uint256 g = gasleft();
        vm.prank(resolver);
        vpm.resolve(id, 0);
        uint256 used = g - gasleft();
        console.log("resolve finalizing a full 200-entry vintage, gas:", used);
        assertLt(used, 8_000_000, "a full vintage settles in a quarter of a block");
        assertEq(vpm.pendingCount(id), 0);
    }

    function test_TheNextBlockOpensAFreshVintage() public {
        HunchVPM vpm = new HunchVPM(makeAddr("guardian"), makeAddr("treasury"), address(this), address(0));
        usdg.approve(address(vpm), type(uint256).max);
        uint256 id = vpm.create(IERC20(address(usdg)), _seed(), 30, T, 1 days, resolver, resolver, 0, 0, 0);
        vm.roll(block.number + 1);
        vm.startPrank(stuffer);
        usdg.approve(address(vpm), type(uint256).max);
        for (uint256 i = 0; i < 200; i++) {
            vpm.enter(id, uint8(i % 2), 1);
        }
        vm.roll(block.number + 1);
        vm.cool(address(vpm));
        vm.cool(address(usdg));
        uint256 g = gasleft();
        vpm.enter(id, 0, 5e6); // finalizes the full vintage, then opens a fresh one
        console.log("an entry finalizing a full 200-entry vintage, gas:", g - gasleft());
        vm.stopPrank();
        assertEq(vpm.pendingCount(id), 1);
        assertLt(g - gasleft(), 8_000_000);
    }

    // ================================================================== M-2: many outcomes

    /// @notice A vintage takes min(200, floor(12,800 / n)) entries: 200 up to 64 outcomes (so a
    ///         binary market is unchanged), then fewer, down to 50 at 255 outcomes.
    function test_D9_TheWorkCapSetsHowManyEntriesAVintageTakes() public {
        HunchVPM vpm = _vpm();
        uint256[9] memory ns = [uint256(2), 3, 32, 64, 65, 100, 128, 200, 255];
        for (uint256 j = 0; j < ns.length; j++) {
            uint256 n = ns[j];
            uint256 id = _market(vpm, n, vpm.KAPPA_UNBOUNDED(), 1);
            vm.roll(block.number + 1);
            uint256 k = _fill(vpm, id, n, 1);
            assertEq(k, n <= 64 ? 200 : 12_800 / n, "entries per vintage");
            assertLe(k * n, vpm.MAX_VINTAGE_WORK());
            assertEq(vpm.pendingCount(id), k);
        }
    }

    /// @notice The worst full vintage of every outcome count a market can be created with inside
    ///         a 32M-gas transaction finalizes under 25M gas, cold. Three layouts per n: κ
    ///         unbounded with dust entries, κ at MAX_KAPPA with dust entries, and κ = n + 1 with
    ///         every book rationed (the costliest: a cap is computed for every entry-outcome
    ///         pair and every entry is accepted, so every book is written). Measured peak:
    ///         about 23.1M gas at 64 outcomes, rationed.
    function test_D9_EveryCreatableMarketsFullestVintageFinalizesUnder25MGas() public {
        HunchVPM vpm = _vpm();
        uint256 nMax = _maxCreatableOutcomes(vpm);
        console.log("most outcomes creatable in a 32M-gas transaction:", nMax);
        assertGe(nMax, 128, "many-outcome markets are creatable");
        assertLt(nMax, 255, "but not every n up to 255");
        uint256[12] memory ns = [uint256(2), 16, 32, 48, 63, 64, 65, 80, 96, 110, 128, nMax];
        uint256 worst;
        uint256 worstN;
        for (uint256 j = 0; j < ns.length; j++) {
            uint256 n = ns[j];
            uint256 a = _worstFinalize(vpm, n, vpm.KAPPA_UNBOUNDED(), 1, 1);
            uint256 b = _worstFinalize(vpm, n, vpm.MAX_KAPPA(), 1, 1);
            uint256 c = _worstFinalize(vpm, n, n + 1, 1e6, 10e6);
            console.log("outcomes", n, "entries", n <= 64 ? 200 : 12_800 / n);
            console.log("  finalize gas: unbounded / max kappa / rationed", a, b, c);
            uint256 m = a > b ? a : b;
            m = m > c ? m : c;
            if (m > worst) (worst, worstN) = (m, n);
        }
        console.log("worst finalize, gas:", worst, "at outcomes:", worstN);
        assertLt(worst, WORST_FINALIZE_GAS, "every full vintage finalizes under 25M gas");
    }

    /// @notice The reviewer's lock (AuditManyOutcomeStuffing): a 110-outcome market, κ 30, with a
    ///         victim's 1,000 USDG. The stuffer's 117th entry of a vintage now reverts
    ///         VintageFull, and every way out of the market fits in a block with a full vintage
    ///         pending: finalizing, a refund, the next entry, resolving, and the timeout void.
    function test_D9_TheReviewersManyOutcomeLockIsImpossible() public {
        HunchVPM vpm = _vpm();
        uint256 n = 110;
        uint256 id = _market(vpm, n, 30, 1e6);
        uint256 other = _market(vpm, n, 30, 1e6);
        address victim = makeAddr("victim");
        usdg.mint(victim, 1_000e6);
        vm.roll(block.number + 1);
        vm.startPrank(victim);
        usdg.approve(address(vpm), type(uint256).max);
        uint256 pid = vpm.enter(id, 3, 1_000e6);
        vm.stopPrank();
        assertEq(_fill(vpm, id, n, 1), 115, "12,800 / 110 = 116 entries a vintage (the victim's is one)");
        vm.roll(block.number + 1);

        (bool ok, uint256 used) = _cold(vpm, abi.encodeCall(vpm.finalizeVintage, (id)));
        assertTrue(ok, "finalizing the stuffed vintage fits in a block");
        console.log("finalize a full 110-outcome vintage, gas:", used);
        assertLt(used, WORST_FINALIZE_GAS);

        assertEq(_fill(vpm, id, n, 1), 116);
        vm.roll(block.number + 1);
        (ok, used) = _cold(vpm, abi.encodeCall(vpm.withdrawRefundFor, (pid)));
        assertTrue(ok, "a refund before settlement (it finalizes first) fits");
        assertEq(usdg.balanceOf(victim), 1_000e6, "kappa 30 < 109 opposing books: no headroom, the stake comes back");

        _fill(vpm, id, n, 1);
        vm.roll(block.number + 1);
        vm.prank(stuffer);
        (ok, used) = _cold(vpm, abi.encodeCall(vpm.enter, (id, 0, 1)));
        assertTrue(ok, "the next entry finalizes the full vintage and fits");

        _fill(vpm, id, n, 1);
        _fill(vpm, other, n, 1);
        vm.warp(T);
        vm.prank(resolver);
        (ok, used) = _cold(vpm, abi.encodeCall(vpm.resolve, (id, 3)));
        assertTrue(ok, "resolve (D8: finalizes in the same block) fits");
        vm.warp(T + 1 days);
        (ok, used) = _cold(vpm, abi.encodeCall(vpm.voidMarket, (other)));
        assertTrue(ok, "the timeout void by anyone fits");
    }

    // ================================================================== I-1: κ bound

    /// @notice A finite κ above MAX_KAPPA (1e9) is refused; 1, MAX_KAPPA and KAPPA_UNBOUNDED are
    ///         accepted. The published vectors use κ up to 1e9 (P9, P12), which is why the bound
    ///         is 1e9 and not lower.
    function test_D9_CreateAcceptsKappaOnlyUpToTheBoundOrUnbounded() public {
        HunchVPM vpm = _vpm();
        assertEq(vpm.MAX_KAPPA(), 1e9);
        uint256[5] memory bad = [uint256(0), 1e9 + 1, 1e18, 1e70, type(uint256).max - 1];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(HunchVPM.InvalidKappa.selector);
            vpm.create(IERC20(address(usdg)), _seed(), bad[i], T, 1 days, resolver, resolver, 0, 0, 0);
        }
        vpm.create(IERC20(address(usdg)), _seed(), 1, T, 1 days, resolver, resolver, 0, 0, 0);
        vpm.create(IERC20(address(usdg)), _seed(), 1e9, T, 1 days, resolver, resolver, 0, 0, 0);
        vpm.create(IERC20(address(usdg)), _seed(), vpm.KAPPA_UNBOUNDED(), T, 1 days, resolver, resolver, 0, 0, 0);
    }

    /// @notice The reviewer's lock (AuditHugeKappaLock): κ = 1e70 overflowed κ·a at finalization
    ///         on a 20 USDG entry and locked the market. It is now refused at creation, and at the
    ///         bound a market takes stakes far beyond any USDG supply (2^96 units, 7.9e22 USDG)
    ///         through several vintages on both sides, then settles and pays out.
    function test_D9_TheReviewersHugeKappaLockIsImpossible() public {
        HunchVPM vpm = _vpm();
        vm.expectRevert(HunchVPM.InvalidKappa.selector);
        vpm.create(IERC20(address(usdg)), _seed(), 1e70, T, 1 days, resolver, resolver, 0, 0, 0);

        uint256[] memory dust = new uint256[](2);
        dust[0] = 1;
        dust[1] = 1;
        uint256 id = vpm.create(IERC20(address(usdg)), dust, vpm.MAX_KAPPA(), T, 1 days, resolver, resolver, 0, 0, 0);
        uint256 big = type(uint96).max;
        usdg.mint(stuffer, 20 * big);
        vm.startPrank(stuffer);
        for (uint256 v = 0; v < 5; v++) {
            vm.roll(block.number + 1);
            vpm.enter(id, 0, big);
            vpm.enter(id, 1, big);
            vpm.enter(id, 0, 20e6);
        }
        vm.stopPrank();
        vm.roll(block.number + 1);
        vpm.finalizeVintage(id);
        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, 0);
        uint256[] memory all = vpm.marketPositions(id, 0, 100);
        for (uint256 i = 0; i < all.length; i++) {
            vpm.claimFor(all[i]);
        }
        vm.prank(resolver); // the residue owner
        vpm.claimResidue(id);
        assertEq(usdg.balanceOf(address(vpm)), 0, "every unit paid out");
    }

    // ================================================================== helpers

    function _vpm() internal returns (HunchVPM vpm) {
        vpm = new HunchVPM(makeAddr("guardian"), makeAddr("treasury"), address(this), address(0));
        usdg.approve(address(vpm), type(uint256).max);
        vm.prank(stuffer);
        usdg.approve(address(vpm), type(uint256).max);
    }

    function _market(HunchVPM vpm, uint256 n, uint256 kappa, uint256 seedEach) internal returns (uint256) {
        uint256[] memory seed = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            seed[i] = seedEach;
        }
        return vpm.create(IERC20(address(usdg)), seed, kappa, T, 1 days, resolver, resolver, 0, 0, 0);
    }

    /// @dev Enter `stake` on outcomes 0, 1, 2, ... until the vintage is full; returns its size.
    function _fill(HunchVPM vpm, uint256 id, uint256 n, uint256 stake) internal returns (uint256 k) {
        vm.startPrank(stuffer);
        while (true) {
            try vpm.enter(id, uint8(k % n), stake) {
                k++;
            } catch (bytes memory err) {
                assertEq(bytes4(err), HunchVPM.VintageFull.selector, "the vintage is full");
                break;
            }
        }
        vm.stopPrank();
    }

    /// @dev One call as its own transaction: every touched contract cooled, at most 32M gas.
    function _cold(HunchVPM vpm, bytes memory data) internal returns (bool ok, uint256 used) {
        vm.cool(address(vpm));
        vm.cool(address(usdg));
        uint256 g = gasleft();
        (ok,) = address(vpm).call{gas: BLOCK_GAS_LIMIT}(data);
        used = g - gasleft();
    }

    function _worstFinalize(HunchVPM vpm, uint256 n, uint256 kappa, uint256 seedEach, uint256 stake)
        internal
        returns (uint256 used)
    {
        uint256 id = _market(vpm, n, kappa, seedEach);
        vm.roll(block.number + 1);
        _fill(vpm, id, n, stake);
        vm.roll(block.number + 1);
        bool ok;
        (ok, used) = _cold(vpm, abi.encodeCall(vpm.finalizeVintage, (id)));
        assertTrue(ok, "a full vintage finalizes inside a block");
    }

    /// @dev The largest n whose `create` (κ unbounded, 1-unit legs: the cheapest creation) fits
    ///      in a 32M-gas transaction. Creation cost only grows with n.
    function _maxCreatableOutcomes(HunchVPM vpm) internal returns (uint256 lo) {
        lo = 2;
        uint256 hi = 255;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256[] memory seed = new uint256[](mid);
            for (uint256 i = 0; i < mid; i++) {
                seed[i] = 1;
            }
            (bool ok,) = _cold(
                vpm,
                abi.encodeCall(
                    vpm.create,
                    (IERC20(address(usdg)), seed, vpm.KAPPA_UNBOUNDED(), T, 1 days, resolver, resolver, 0, 0, 0)
                )
            );
            if (ok) lo = mid;
            else hi = mid - 1;
        }
    }
}
