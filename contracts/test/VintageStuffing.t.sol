// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20 as RefIERC20} from "../src/reference/VestedParimutuel.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";

/// @title D9 · A vintage cannot be stuffed past the block gas limit
/// @notice Finalizing a vintage costs about 34,000 gas per entry, and every way out of a market
///         (the next entry, `finalizeVintage`, `resolve`, `voidMarket`, a pre-settlement
///         refund) finalizes first. On Robinhood Chain a vintage is one L1 block (~12 s, dozens
///         of L2 blocks), so without a cap anyone could pour ~1,000 minimum entries into one
///         vintage and make its finalization exceed the 32M block gas limit: the market could
///         then never settle and every stake in it would be locked for good. HunchVPM caps a
///         vintage at MAX_VINTAGE_ENTRIES (D9).
contract VintageStuffingTest is Test {
    uint256 internal constant BLOCK_GAS_LIMIT = 32_000_000; // Arbitrum Orbit default
    MockUSDG internal usdg;
    address internal stuffer = makeAddr("stuffer");
    address internal resolver = makeAddr("resolver");
    uint64 internal T;

    function setUp() public {
        vm.warp(1_790_000_000);
        vm.roll(23_000_000);
        usdg = new MockUSDG();
        usdg.mint(address(this), 1e12);
        usdg.mint(stuffer, 1e12);
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
        HunchVPM vpm = new HunchVPM(makeAddr("guardian"), makeAddr("treasury"));
        usdg.approve(address(vpm), type(uint256).max);
        uint256 id = vpm.create(IERC20(address(usdg)), _seed(), 30, T, 1 days, resolver, resolver, 0, 0, 0);
        assertEq(vpm.MAX_VINTAGE_ENTRIES(), 200);
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
        HunchVPM vpm = new HunchVPM(makeAddr("guardian"), makeAddr("treasury"));
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
}
