// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {ClassicParimutuel} from "../src/ClassicParimutuel.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Two jobs. First, prove the port is faithful: `ClassicParimutuel` must pay what
///         the live product's `computeMarketPayouts` pays, `floor(pool * stake / winning)`,
///         for arbitrary inputs. Second, prove the port is *not* what the vested settler
///         pays — and that the difference always runs the same way, early money never worse
///         off under vesting and late money never better. That divergence is the product.
contract ClassicParimutuelTest is Test {
    ClassicParimutuel internal classic;
    VestedParimutuel internal vested;
    MockERC20 internal token;

    address internal early = address(0xE4);
    address internal late = address(0x1A7E);
    address internal loser = address(0x1053);

    uint64 internal freeze;

    function setUp() public {
        classic = new ClassicParimutuel();
        vested = new VestedParimutuel();
        token = new MockERC20();
        freeze = uint64(block.timestamp + 1 days);
    }

    // ------------------------------------------------------------- the live rule

    /// @dev The production rule, transcribed. Kept separate from the contract so the test
    ///      is a differential against an independent implementation, not a tautology.
    function _liveRule(uint256 pool, uint256 stake, uint256 winningPrincipal) internal pure returns (uint256) {
        if (winningPrincipal == 0) return 0;
        return (pool * stake) / winningPrincipal;
    }

    function testFuzz_MatchesTheLivePayoutRule(uint96 seedA, uint96 seedB, uint96 winStake, uint96 loseStake) public {
        vm.assume(seedA > 0 && seedB > 0 && winStake > 0 && loseStake > 0);
        vm.assume(uint256(seedA) + seedB + winStake + loseStake < type(uint128).max);

        uint256 marketId = _createClassic(seedA, seedB);

        uint256 winPos = _enterClassic(early, marketId, 0, winStake);
        _enterClassic(loser, marketId, 1, loseStake);

        vm.warp(freeze);
        classic.resolve(marketId, 0);

        (,,,,,,,,,, uint256 pool,) = classic.getMarket(marketId);
        uint256 winningPrincipal = classic.getBook(marketId, 0).principal;

        assertEq(
            classic.previewPayout(winPos),
            _liveRule(pool, winStake, winningPrincipal),
            "port must pay exactly what the live rule pays"
        );
    }

    function testFuzz_NeverOverpaysThePool(uint96 seedA, uint96 seedB, uint96 winStake, uint96 loseStake) public {
        vm.assume(seedA > 0 && seedB > 0 && winStake > 0 && loseStake > 0);
        vm.assume(uint256(seedA) + seedB + winStake + loseStake < type(uint128).max);

        uint256 marketId = _createClassic(seedA, seedB);
        uint256 winPos = _enterClassic(early, marketId, 0, winStake);
        _enterClassic(loser, marketId, 1, loseStake);

        vm.warp(freeze);
        classic.resolve(marketId, 0);

        (,,,,,,,,,, uint256 pool,) = classic.getMarket(marketId);
        // Seed leg 0 is position 0; the entrant is winPos. Both sit on the winning side.
        uint256 total = classic.previewPayout(0) + classic.previewPayout(winPos);
        assertLe(total, pool, "sum of winning payouts must never exceed the pool");
    }

    // ------------------------------------------------------------- the divergence

    /// @notice Same market, same flow, both settlers, and the difference stated as the
    ///         product claim: under the classic rule the payout multiple is flat in arrival
    ///         order — a unit that arrived seconds before the freeze earns exactly what a
    ///         unit that carried the risk all day earns. Under the vested rule the multiple
    ///         is strictly decreasing in arrival order, because stake vests into the
    ///         opposing books on arrival and late stake has less time left to vest.
    /// @dev    Multiples are compared per unit of stake at 1e18, since the three positions
    ///         do not stake the same amount. Fixtures: seed 100/100, early 50 on outcome 0,
    ///         200 against, late 50 on outcome 0, resolves to outcome 0.
    function test_TheVestedMultipleFallsWithArrivalOrderAndTheClassicOneDoesNot() public {
        uint256 classicId = _createClassic(100e6, 100e6);
        uint256 vestedId = _createVested(100e6, 100e6);

        // Early winner.
        uint256 cEarly = _enterClassic(early, classicId, 0, 50e6);
        vm.roll(block.number + 1);
        uint256 vEarly = _enterVested(early, vestedId, 0, 50e6);

        // Losing flow arrives in between, which is what vests to whoever is already there.
        vm.roll(block.number + 1);
        _enterClassic(loser, classicId, 1, 200e6);
        _enterVested(loser, vestedId, 1, 200e6);

        // Late winner, moments before the freeze.
        vm.roll(block.number + 1);
        uint256 cLate = _enterClassic(late, classicId, 0, 50e6);
        uint256 vLate = _enterVested(late, vestedId, 0, 50e6);

        vm.roll(block.number + 1);
        vm.warp(freeze);
        classic.resolve(classicId, 0);
        vested.resolve(vestedId, 0);

        // Position 0 is the seed leg on the winning outcome — the earliest money there is.
        uint256 cSeedX = _multiple(classic.previewPayout(0), 100e6);
        uint256 cEarlyX = _multiple(classic.previewPayout(cEarly), 50e6);
        uint256 cLateX = _multiple(classic.previewPayout(cLate), 50e6);

        uint256 vSeedX = _multiple(vested.previewPayout(0), 100e6);
        uint256 vEarlyX = _multiple(vested.previewPayout(vEarly), 50e6);
        uint256 vLateX = _multiple(vested.previewPayout(vLate), 50e6);

        // Classic is blind to arrival order: one multiple for everyone on the winning side.
        assertEq(cSeedX, cEarlyX, "classic pays the seed and the early entrant the same multiple");
        assertEq(cEarlyX, cLateX, "classic pays the early and late entrants the same multiple");

        // Vesting is strictly monotone in arrival order.
        assertGt(vSeedX, vEarlyX, "the seed must out-earn the early entrant per unit");
        assertGt(vEarlyX, vLateX, "the early entrant must out-earn the late one per unit");

        // And the divergence runs one way: the buzzer-beater is the one that loses.
        assertLt(vLateX, cLateX, "late money must never do better under vesting");
        assertGt(vSeedX, cSeedX, "the earliest money must never do worse under vesting");

        // Neither settler may distribute more than it took in.
        (,,,,,,,,,, uint256 cPool,) = classic.getMarket(classicId);
        (,,,,,,,,,, uint256 vPool,) = vested.getMarket(vestedId);
        assertLe(
            classic.previewPayout(0) + classic.previewPayout(cEarly) + classic.previewPayout(cLate),
            cPool,
            "classic must not overpay"
        );
        assertLe(
            vested.previewPayout(0) + vested.previewPayout(vEarly) + vested.previewPayout(vLate),
            vPool,
            "vested must not overpay"
        );
    }

    /// @dev Payout per unit of stake, at 1e18.
    function _multiple(uint256 payout, uint256 stake) internal pure returns (uint256) {
        return (payout * 1e18) / stake;
    }

    function test_SingleParticipantMarketRefunds() public {
        uint256 marketId = _createClassic(100e6, 100e6);
        vm.warp(freeze);
        classic.resolve(marketId, 0);

        (,,,,,,, uint8 status,,,,) = classic.getMarket(marketId);
        assertEq(status, uint8(IParimutuelSettler.Status.Voided), "one participant cannot settle against anyone");

        uint256 before = token.balanceOf(address(this));
        classic.claim(0);
        classic.claim(1);
        assertEq(token.balanceOf(address(this)) - before, 200e6, "a voided market refunds principal exactly");
    }

    function test_ClassicIsReachableThroughTheSharedInterface() public {
        IParimutuelSettler settler = IParimutuelSettler(address(classic));
        assertEq(settler.headroom(0, 0), type(uint256).max, "a classic pool never rations");
    }

    // ------------------------------------------------------------- helpers

    function _createClassic(uint256 a, uint256 b) internal returns (uint256) {
        token.mint(address(this), a + b);
        token.approve(address(classic), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        seed[0] = a;
        seed[1] = b;
        return classic.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));
    }

    function _createVested(uint256 a, uint256 b) internal returns (uint256) {
        token.mint(address(this), a + b);
        token.approve(address(vested), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        seed[0] = a;
        seed[1] = b;
        return vested.create(IERC20(address(token)), seed, 30, freeze, 7 days, address(this), address(this));
    }

    function _enterClassic(address who, uint256 marketId, uint8 outcome, uint256 amount) internal returns (uint256) {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(classic), type(uint256).max);
        uint256 id = classic.enter(marketId, outcome, amount);
        vm.stopPrank();
        return id;
    }

    function _enterVested(address who, uint256 marketId, uint8 outcome, uint256 amount) internal returns (uint256) {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(vested), type(uint256).max);
        uint256 id = vested.enter(marketId, outcome, amount);
        vm.stopPrank();
        return id;
    }
}
