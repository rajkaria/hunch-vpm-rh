// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice The vendored settler predates `IParimutuelSettler`, so nothing in the compiler
///         forces the two to agree. These tests are that force: every selector is asserted
///         against the deployed bytecode, and the whole lifecycle is driven through the
///         interface. Change a signature on either side and this suite goes red.
contract ParimutuelInterfaceTest is Test {
    VestedParimutuel internal vpm;
    MockERC20 internal token;
    IParimutuelSettler internal settler;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        vpm = new VestedParimutuel();
        token = new MockERC20();
        settler = IParimutuelSettler(address(vpm));
    }

    function test_SelectorsMatchTheVendoredSettler() public pure {
        assertEq(IParimutuelSettler.create.selector, VestedParimutuel.create.selector, "create");
        assertEq(IParimutuelSettler.enter.selector, VestedParimutuel.enter.selector, "enter");
        assertEq(IParimutuelSettler.resolve.selector, VestedParimutuel.resolve.selector, "resolve");
        assertEq(IParimutuelSettler.voidMarket.selector, VestedParimutuel.voidMarket.selector, "voidMarket");
        assertEq(IParimutuelSettler.claim.selector, VestedParimutuel.claim.selector, "claim");
        assertEq(IParimutuelSettler.withdrawRefund.selector, VestedParimutuel.withdrawRefund.selector, "withdrawRefund");
        assertEq(
            IParimutuelSettler.transferPosition.selector, VestedParimutuel.transferPosition.selector, "transferPosition"
        );
        assertEq(IParimutuelSettler.headroom.selector, VestedParimutuel.headroom.selector, "headroom");
        assertEq(IParimutuelSettler.previewPayout.selector, VestedParimutuel.previewPayout.selector, "previewPayout");
        assertEq(IParimutuelSettler.getMarket.selector, VestedParimutuel.getMarket.selector, "getMarket");
        assertEq(IParimutuelSettler.marketCount.selector, VestedParimutuel.marketCount.selector, "marketCount");
        assertEq(IParimutuelSettler.positionCount.selector, VestedParimutuel.positionCount.selector, "positionCount");
    }

    function test_FullLifecycleThroughTheInterface() public {
        token.mint(address(this), 1_000e6);
        token.approve(address(vpm), type(uint256).max);

        uint256[] memory seed = new uint256[](2);
        seed[0] = 100e6;
        seed[1] = 100e6;

        uint64 freeze = uint64(block.timestamp + 1 days);
        uint256 marketId =
            settler.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));

        // Alice takes outcome 0 early.
        token.mint(alice, 50e6);
        vm.roll(block.number + 1);
        vm.startPrank(alice);
        token.approve(address(vpm), type(uint256).max);
        uint256 alicePosition = settler.enter(marketId, 0, 50e6);
        vm.stopPrank();

        assertGt(settler.headroom(marketId, 0), 0, "book 0 should still have room");

        // Bob takes the other side in a later vintage, which is what vests to Alice.
        token.mint(bob, 80e6);
        vm.roll(block.number + 1);
        vm.startPrank(bob);
        token.approve(address(vpm), type(uint256).max);
        settler.enter(marketId, 1, 80e6);
        vm.stopPrank();

        vm.roll(block.number + 1);
        vm.warp(freeze);
        settler.resolve(marketId, 0);

        (,,,,,,, uint8 status, uint8 winner,,,) = settler.getMarket(marketId);
        assertEq(status, uint8(IParimutuelSettler.Status.Resolved), "status");
        assertEq(winner, 0, "winner");

        uint256 preview = settler.previewPayout(alicePosition);
        assertGt(preview, 50e6, "an early winner should be paid more than its principal");

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        settler.claim(alicePosition);
        assertEq(token.balanceOf(alice) - before, preview, "claim should pay exactly what it previewed");
    }
}
