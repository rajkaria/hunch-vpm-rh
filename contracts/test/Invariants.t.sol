// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Drives a live market the way a market actually gets driven — many actors,
///         arbitrary amounts, blocks advancing between entries so vintages form — while
///         keeping its own independent ledger of every unit that went in and came out.
///         The invariants are checked against that ledger, not against the contract's own
///         accounting, so a bug in the contract cannot hide behind itself.
contract SettlerHandler is Test {
    VestedParimutuel public immutable vpm;
    MockERC20 public immutable token;
    uint256 public immutable marketId;
    uint64 public immutable freeze;

    /// @dev Independent ledger.
    uint256 public escrowed;
    uint256 public withdrawn;

    address[] internal actors;
    uint256[] internal openPositions;
    mapping(uint256 => address) internal positionOwner;

    address public constant ATTACKER = address(0xBAD);

    constructor(VestedParimutuel vpm_, MockERC20 token_, uint64 freeze_) {
        vpm = vpm_;
        token = token_;
        freeze = freeze_;

        for (uint160 i = 1; i <= 8; i++) {
            actors.push(address(uint160(0xA000) + i));
        }

        uint256[] memory seed = new uint256[](2);
        seed[0] = 100e6;
        seed[1] = 100e6;
        token.mint(address(this), 200e6);
        token.approve(address(vpm), type(uint256).max);
        marketId = vpm.create(IERC20(address(token)), seed, 30, freeze_, 7 days, address(this), address(this));
        escrowed += 200e6;
        openPositions.push(0);
        openPositions.push(1);
        positionOwner[0] = address(this);
        positionOwner[1] = address(this);
    }

    function _actor(uint256 seed_) internal view returns (address) {
        return actors[seed_ % actors.length];
    }

    /// @notice Offer stake on one side. Amounts are bounded to keep runs meaningful rather
    ///         than degenerate, and blocks advance so entries land in different vintages.
    function enter(uint256 actorSeed, uint8 outcome, uint256 amount, bool advanceBlock) external {
        if (block.timestamp >= freeze) return;
        amount = bound(amount, 1e6, 500e6);
        outcome = uint8(bound(outcome, 0, 1));
        address actor = _actor(actorSeed);

        if (advanceBlock) vm.roll(block.number + 1);

        token.mint(actor, amount);
        vm.startPrank(actor);
        token.approve(address(vpm), type(uint256).max);
        uint256 positionId = vpm.enter(marketId, outcome, amount);
        vm.stopPrank();

        escrowed += amount;
        openPositions.push(positionId);
        positionOwner[positionId] = actor;
    }

    /// @notice Pull a refused remainder back out, which is a withdrawal like any other.
    function withdrawRefund(uint256 positionSeed) external {
        if (openPositions.length == 0) return;
        uint256 positionId = openPositions[positionSeed % openPositions.length];
        vpm.finalizeVintage(marketId);

        address owner = positionOwner[positionId];
        uint256 before = token.balanceOf(owner);
        vm.prank(owner);
        try vpm.withdrawRefund(positionId) {
            withdrawn += token.balanceOf(owner) - before;
        } catch {}
    }

    /// @notice Let the clock run. Vintages only finalize when the block moves on.
    function advance(uint256 blocks, uint256 secs) external {
        vm.roll(block.number + bound(blocks, 1, 5));
        uint256 target = block.timestamp + bound(secs, 1, 6 hours);
        vm.warp(target > freeze ? freeze : target);
    }

    /// @notice Freeze, settle, and let everyone claim. Runs at most once.
    function settleAndClaimAll(uint8 winner) external {
        (,,,,,,, VestedParimutuel.Status status,,,,) = vpm.getMarket(marketId);
        if (status != VestedParimutuel.Status.Open) return;

        vm.warp(freeze);
        vm.roll(block.number + 1);
        vpm.resolve(marketId, uint8(bound(winner, 0, 1)));

        for (uint256 i = 0; i < openPositions.length; i++) {
            uint256 positionId = openPositions[i];
            address owner = positionOwner[positionId];
            uint256 before = token.balanceOf(owner);
            vm.prank(owner);
            try vpm.claim(positionId) {
                withdrawn += token.balanceOf(owner) - before;
            } catch {}
        }

        uint256 residueBefore = token.balanceOf(address(this));
        try vpm.claimResidue(marketId) {
            withdrawn += token.balanceOf(address(this)) - residueBefore;
        } catch {}
    }

    /// @notice Everything an outsider might try. None of it should move a unit.
    function attack(uint256 positionSeed, uint8 winner) external {
        uint256 positionId = openPositions[positionSeed % openPositions.length];
        vm.startPrank(ATTACKER);
        try vpm.claim(positionId) {} catch {}
        try vpm.withdrawRefund(positionId) {} catch {}
        try vpm.claimResidue(marketId) {} catch {}
        try vpm.resolve(marketId, uint8(bound(winner, 0, 1))) {} catch {}
        try vpm.transferPosition(positionId, ATTACKER) {} catch {}
        vm.stopPrank();
    }

    function positionCount() external view returns (uint256) {
        return openPositions.length;
    }
}

/// @notice The four properties the settlement layer has to hold no matter what order
///         anything happens in: the escrow is never short, the contract's own ledger agrees
///         with an independent one, nothing is ever paid out that was not paid in, and an
///         address with no position cannot extract a unit.
contract InvariantsTest is StdInvariant, Test {
    VestedParimutuel internal vpm;
    MockERC20 internal token;
    SettlerHandler internal handler;

    function setUp() public {
        vpm = new VestedParimutuel();
        token = new MockERC20();
        handler = new SettlerHandler(vpm, token, uint64(block.timestamp + 7 days));

        targetContract(address(handler));
    }

    /// @notice Every unit escrowed is either still held or has been paid to somebody.
    function invariant_EscrowIsNeverShort() public view {
        assertEq(
            token.balanceOf(address(vpm)),
            handler.escrowed() - handler.withdrawn(),
            "the settler's balance must equal what went in minus what came out"
        );
    }

    /// @notice The contract's own accounting cannot exceed what was actually escrowed.
    function invariant_AcceptedPoolIsBackedByRealTokens() public view {
        (,,,,,,,,,, uint256 acceptedPool,) = vpm.getMarket(handler.marketId());
        assertLe(acceptedPool, handler.escrowed(), "the settler cannot account for more than it was sent");
    }

    /// @notice Nothing is ever paid out that was not paid in.
    function invariant_NothingIsCreatedFromNothing() public view {
        assertLe(handler.withdrawn(), handler.escrowed(), "payouts can never exceed deposits");
    }

    /// @notice An address that never staked cannot end up holding anything.
    function invariant_AnOutsiderCannotExtractAnything() public view {
        assertEq(token.balanceOf(handler.ATTACKER()), 0, "an outsider must never be able to move a unit");
    }
}
