// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {ClassicParimutuel} from "../src/ClassicParimutuel.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";

/// @notice Conservation, stated as an equality rather than a bound: once a market has been
///         settled and everybody has pulled what they are owed, the settler holds exactly
///         nothing. Not "no more than it should" — nothing. Anything left behind is either
///         money someone is owed and cannot reach, or money the contract invented.
contract ConservationTest is Test {
    VestedParimutuel internal vested;
    ClassicParimutuel internal classic;
    MockERC20 internal token;

    address internal maker = address(0x11);
    address internal taker = address(0x22);
    uint64 internal freeze;

    function setUp() public {
        vested = new VestedParimutuel();
        classic = new ClassicParimutuel();
        token = new MockERC20();
        freeze = uint64(block.timestamp + 1 days);
    }

    function testFuzz_VestedSettlesToTheLastUnit(uint96 seedA, uint96 seedB, uint96 upStake, uint96 downStake) public {
        vm.assume(seedA >= 1e6 && seedB >= 1e6 && upStake >= 1e6 && downStake >= 1e6);
        vm.assume(uint256(seedA) + seedB + upStake + downStake < 1e30);

        uint256[] memory seed = new uint256[](2);
        seed[0] = seedA;
        seed[1] = seedB;
        token.mint(address(this), uint256(seedA) + seedB);
        token.approve(address(vested), type(uint256).max);
        uint256 marketId = vested.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));

        uint256 up = _enter(IParimutuelSettler(address(vested)), marketId, maker, 0, upStake);
        vm.roll(block.number + 1);
        uint256 down = _enter(IParimutuelSettler(address(vested)), marketId, taker, 1, downStake);

        vm.roll(block.number + 1);
        vm.warp(freeze);
        vested.resolve(marketId, 0);

        // Everyone pulls everything they are entitled to, in every order that matters.
        _drain(vested, maker, up);
        _drain(vested, taker, down);
        _drain(vested, address(this), 0);
        _drain(vested, address(this), 1);
        vested.claimResidue(marketId);

        assertEq(token.balanceOf(address(vested)), 0, "a fully drained market must hold nothing at all");
    }

    function testFuzz_ClassicSettlesToTheLastUnit(uint96 seedA, uint96 seedB, uint96 upStake, uint96 downStake) public {
        vm.assume(seedA >= 1e6 && seedB >= 1e6 && upStake >= 1e6 && downStake >= 1e6);
        vm.assume(uint256(seedA) + seedB + upStake + downStake < 1e30);

        uint256[] memory seed = new uint256[](2);
        seed[0] = seedA;
        seed[1] = seedB;
        token.mint(address(this), uint256(seedA) + seedB);
        token.approve(address(classic), type(uint256).max);
        uint256 marketId =
            classic.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));

        uint256 up = _enter(IParimutuelSettler(address(classic)), marketId, maker, 0, upStake);
        uint256 down = _enter(IParimutuelSettler(address(classic)), marketId, taker, 1, downStake);

        vm.warp(freeze);
        classic.resolve(marketId, 0);

        vm.prank(maker);
        classic.claim(up);
        vm.prank(taker);
        classic.claim(down);
        classic.claim(0);
        classic.claim(1);
        classic.claimResidue(marketId);

        assertEq(token.balanceOf(address(classic)), 0, "a fully drained market must hold nothing at all");
    }

    /// @notice The one-participant rule differs between the two settlers, on purpose.
    /// @dev    Under the classic pool a market only one address staked in has no
    ///         counterparty at all, so it voids and refunds — the live product's rule. Under
    ///         the vested pool the seed legs *are* each other's counterparties: each leg
    ///         vests its accepted principal into every other leg's book at creation, so the
    ///         market is well-formed even with nobody else in it and settles normally.
    ///         Forcing the classic rule onto the vested settler would refund markets that
    ///         have a real, funded book on both sides.
    function test_TheOneParticipantRuleDiffersBetweenSettlers() public {
        uint256[] memory seed = new uint256[](2);
        seed[0] = 100e6;
        seed[1] = 100e6;

        token.mint(address(this), 400e6);
        token.approve(address(vested), type(uint256).max);
        token.approve(address(classic), type(uint256).max);

        uint256 vestedId = vested.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));
        uint256 classicId =
            classic.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));

        vm.roll(block.number + 1);
        vm.warp(freeze);
        vested.resolve(vestedId, 0);
        classic.resolve(classicId, 0);

        (,,,,,,, uint8 vestedStatus,,,,) = IParimutuelSettler(address(vested)).getMarket(vestedId);
        (,,,,,,, uint8 classicStatus,,,,) = IParimutuelSettler(address(classic)).getMarket(classicId);

        assertEq(vestedStatus, uint8(IParimutuelSettler.Status.Resolved), "seed legs are counterparties under vesting");
        assertEq(classicStatus, uint8(IParimutuelSettler.Status.Voided), "a classic pool with one participant voids");
    }

    // ------------------------------------------------------------- helpers

    function _enter(IParimutuelSettler settler, uint256 marketId, address who, uint8 outcome, uint256 amount)
        internal
        returns (uint256 positionId)
    {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(settler), type(uint256).max);
        positionId = settler.enter(marketId, outcome, amount);
        vm.stopPrank();
    }

    function _drain(VestedParimutuel settler, address who, uint256 positionId) internal {
        vm.startPrank(who);
        try settler.withdrawRefund(positionId) {} catch {}
        try settler.claim(positionId) {} catch {}
        vm.stopPrank();
    }
}
