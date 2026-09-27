// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {RH} from "../../script/RH.sol";
import {HunchVPM, IERC20} from "../../src/HunchVPM.sol";
import {StockRoundResolver} from "../../src/StockRoundResolver.sol";
import {HunchMarketFactory} from "../../src/HunchMarketFactory.sol";
import {IERC20Like} from "../../src/interfaces/IERC20Like.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";

interface IUSDGCancel {
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external;
}

/// @title  T7: the venue end to end on a fork of Robinhood Chain, against REAL USDG
/// @notice The three contracts are deployed in DeployRH's order against the real USDG proxy
///         (Paxos: UUPS proxy with facets, freeze list, EIP-3009), with a MockAggregator
///         allow-listed as the feed so the outcome is deterministic. One market, four bettors
///         across three vintages (L1 block numbers, driven with `vm.roll`): a full fill, a
///         partial fill, and a same-vintage pair of which one enters gasless through
///         `enterWithAuthorization`, signed against USDG's real EIP-712 domain with the `bytes`
///         overload. The bell passes, a stranger resolves from two proven rounds in the same L1
///         block as the last vintage (D8), the keeper delivers every position with `claimFor`,
///         fees and residue go to the Safe. Every balance is asserted to the base unit, with
///         INV-1 (solvency) and INV-2 (conservation) along the way.
///
///         The second test is the regression for a finding of this suite (S4): real USDG does
///         NOT revert `receiveWithAuthorization` / `transferWithAuthorization` for an
///         authorization whose nonce is already used or cancelled. It emits
///         `AuthorizationAlreadyUsed(authorizer, nonce)` and returns without moving funds and
///         without checking the signature (measured on chain 4663; only an expired window
///         reverts first). MockUSDG reverts there, so the local suites could not see it.
contract ForkE2ETest is ForkBase {
    HunchVPM internal vpm;
    StockRoundResolver internal resolver;
    HunchMarketFactory internal factory;
    MockAggregator internal feed;
    MockStockToken internal token;

    address internal safe = makeAddr("safe");
    address internal keeper = makeAddr("keeper");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");
    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal constant BOB_PK = 0xB0B;
    uint256 internal constant CAROL_PK = 0xCA201;
    uint256 internal constant DAVE_PK = 0xDA7E;
    address internal alice = vm.addr(ALICE_PK);
    address internal bob = vm.addr(BOB_PK);
    address internal carol = vm.addr(CAROL_PK);
    address internal dave = vm.addr(DAVE_PK);

    uint256 internal constant U = 1e6; // one USDG
    uint64 internal strike;
    uint64 internal bell;
    uint80 internal strikeRound;

    function setUp() public {
        if (!_forkOrSkip()) return;
        // DeployRH's order: resolver → settler(guardian = treasury = Safe) → factory → feeds →
        // opener → two-step hand-over to the Safe.
        resolver = new StockRoundResolver();
        vpm = new HunchVPM(safe, safe);
        factory = new HunchMarketFactory(vpm, resolver, IERC20Like(RH.USDG), address(this), safe);
        feed = new MockAggregator("TEST / USD");
        token = new MockStockToken("TEST");
        factory.setFeed(address(feed), address(token), "TEST", RH.MAX_AGE, RH.MAX_AGE, true);
        factory.setOpener(keeper, true);
        factory.transferOwnership(safe);
        vm.prank(safe);
        factory.acceptOwnership();

        vm.label(RH.USDG, "USDG");
        vm.label(alice, "alice");
        vm.label(bob, "bob");
        vm.label(carol, "carol");
        vm.label(dave, "dave");

        strike = uint64(block.timestamp + 10 minutes);
        bell = uint64(block.timestamp + 7 hours);
        strikeRound = feed.addRound(100e8, block.timestamp); // the price in effect at the strike
    }

    function _open(uint128 maxEntry) internal returns (uint256 id, bytes32 spec) {
        _fundUsdg(keeper, 20 * U);
        vm.startPrank(keeper);
        USDG.approve(address(factory), 20 * U);
        (id, spec) = factory.openUpDown(
            HunchMarketFactory.UpDown({
                feed: address(feed),
                strikeTime: strike,
                finalTime: bell,
                maxStrikeAge: 0,
                maxFinalAge: 0,
                seedPerLeg: 10e6,
                minEntry: 1e6,
                maxEntry: maxEntry
            })
        );
        vm.stopPrank();
    }

    function _enter(address who, uint256 id, uint8 outcome, uint256 amount) internal returns (uint256 pid) {
        _fundUsdg(who, amount);
        vm.startPrank(who);
        USDG.approve(address(vpm), amount);
        pid = vpm.enter(id, outcome, amount);
        vm.stopPrank();
    }

    function _escrow() internal view returns (uint256) {
        return USDG.balanceOf(address(vpm));
    }

    // ================================================================== T7

    // the market of the end-to-end test and its positions, kept in storage between phases
    uint256 internal mId;
    bytes32 internal mSpec;
    uint256 internal pAlice;
    uint256 internal pDave;
    uint256 internal pBob;
    uint256 internal pCarol;

    function test_E2E_OneMarketOnRealUSDG() public {
        _phaseOpen();
        _phaseBets();
        _phasePartialFillRefund();
        _phaseResolveAtTheBell();
        _phaseDeliverAndCheck();
    }

    function _phaseOpen() internal {
        (mId, mSpec) = _open(500e6);
        assertEq(USDG.balanceOf(address(factory)), 0, "the factory keeps nothing");
        assertEq(USDG.allowance(address(factory), address(vpm)), 0, "and leaves no allowance");
        uint256[] memory legs = vpm.marketPositions(mId, 0, 2);
        (, address upLegOwner,,,,,,,,) = vpm.positions(legs[0]);
        assertEq(upLegOwner, keeper, "the opener owns the seed legs");
    }

    function _phaseBets() internal {
        uint256 b0 = block.number;

        // vintage 1: Alice UP 20, filled in full (DOWN headroom 30 * 10 - 10 = 290)
        vm.roll(b0 + 1);
        pAlice = _enter(alice, mId, 0, 20 * U);

        // vintage 2: Dave UP 300, a partial fill: DOWN headroom is now 300 - 30 = 270
        vm.roll(b0 + 2);
        pDave = _enter(dave, mId, 0, 300 * U);

        // vintage 3: Bob DOWN 30 with `enter` and Carol DOWN 40 signed and relayed, same vintage
        vm.roll(b0 + 3);
        pBob = _enter(bob, mId, 1, 30 * U);
        _fundUsdg(carol, 40 * U);
        bytes32 salt = keccak256("carol");
        bytes32 nonce = vpm.enterNonce(mId, 1, 40 * U, salt);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _sign(CAROL_PK, _receiveDigest(carol, address(vpm), 40 * U, 0, validBefore, nonce));
        vm.prank(relayer);
        pCarol = vpm.enterWithAuthorization(carol, mId, 1, 40 * U, 0, validBefore, salt, sig);
        assertTrue(USDG.authorizationState(carol, nonce), "USDG marked Carol's authorization used");
        (, address carolOwner,,,,,,,,) = vpm.positions(pCarol);
        assertEq(carolOwner, carol, "the relayed position belongs to the signer, not the relayer");
        assertEq(USDG.balanceOf(carol), 0, "Carol paid 40 through her signature");

        // INV-1 while open: the escrow is exactly every stake offered
        assertEq(_escrow(), (20 + 20 + 300 + 30 + 40) * U, "INV-1: escrow = seeds + offered stakes");
    }

    function _phasePartialFillRefund() internal {
        // Dave's refused 30 is withdrawable as soon as his vintage is final (finalized by Bob)
        (,,, bool daveFinal,,,, uint128 daveOffered, uint128 daveAccepted,) = vpm.positions(pDave);
        assertTrue(daveFinal);
        assertEq(daveOffered, 300 * U);
        assertEq(daveAccepted, 270 * U, "partial fill: the DOWN book had 270 of headroom");
        vm.prank(keeper);
        vpm.withdrawRefundFor(pDave);
        assertEq(USDG.balanceOf(dave), 30 * U, "the refused part went to Dave (not to the keeper)");
        assertEq(USDG.balanceOf(keeper), 0, "and nothing to the keeper who delivered it");
    }

    function _phaseResolveAtTheBell() internal {
        // the price in effect at the bell is 101 > 100: UP
        uint80 finalRound = feed.addRound(101e8, bell - 10 minutes);
        vm.warp(bell);
        vm.expectRevert(StockRoundResolver.TooEarly.selector);
        resolver.resolve(mSpec, strikeRound, finalRound);

        // one second after the bell, still in vintage 3's L1 block: resolve finalizes it (D8)
        vm.warp(bell + 1);
        (uint8 status,,,,) = resolver.preview(mSpec, strikeRound, finalRound);
        assertEq(status, resolver.STATUS_UP(), "preview: UP");
        vm.prank(stranger);
        resolver.resolve(mSpec, strikeRound, finalRound);
        (,,,,,,, HunchVPM.Status st, uint8 winner,, uint256 pool,) = vpm.getMarket(mId);
        assertEq(uint8(st), uint8(HunchVPM.Status.Resolved));
        assertEq(winner, 0, "UP won");
        assertEq(pool, 380 * U, "accepted pool: 20 seed + 20 + 270 + 30 + 40");

        // same vintage, no vesting between Bob and Carol: identical entry accumulators
        (,,,,,,,,, uint128 accBob) = vpm.positions(pBob);
        (,,,,,,,,, uint128 accCarol) = vpm.positions(pCarol);
        assertEq(accBob, accCarol, "a same-vintage pair shares its entry accumulator");
        assertEq(accBob, 30e18, "A_DOWN after vintages 1 and 2: 1 + 20/10 + 270/10");
    }

    function _phaseDeliverAndCheck() internal {
        // the keeper delivers every position; it never receives anything but its own legs' due
        uint256[] memory all = vpm.marketPositions(mId, 0, 10);
        assertEq(all.length, 6);
        assertEq(all[2], pAlice);
        assertEq(all[3], pDave);
        for (uint256 i = 0; i < all.length; i++) {
            vm.prank(keeper);
            vpm.claimFor(all[i]);
        }
        vm.prank(stranger);
        vpm.sweepFees(IERC20(RH.USDG));
        vm.prank(safe);
        vpm.claimResidue(mId);

        // Exact payouts. A_UP = 1 (seed vintage: 10/10) + 70e18/300 (Bob + Carol vest into the
        // 300 of UP principal) = 1_233333333333333333. payout = s·(1e18 + A_UP − entryAcc)/1e18,
        // fee = ⌊gain · 200 / 10_000⌋:
        //   keeper UP leg  s=10,  entryAcc 0    → 22_333333 gross, fee 246_666, net 22_086_667
        //   Alice          s=20,  entryAcc 1e18 → 24_666666 gross, fee  93_333, net 24_573_333
        //   Dave           s=270, entryAcc 1e18 → 332_999999 gross, fee 1_259_999, net 331_740_000
        //   DOWN leg, Bob, Carol: 0. Σ gross = 379_999_998 → residue 2; fees 1_599_998.
        (,,,,,,,,,, uint256 pool, uint256 paidOut) = vpm.getMarket(mId);
        assertEq(paidOut, 379_999_998, "gross payouts");
        assertEq(pool - paidOut, 2, "residue");
        assertEq(paidOut + (pool - paidOut), pool, "INV-2: payouts + residue = accepted pool");
        assertEq(USDG.balanceOf(keeper), 22_086_667, "keeper: 20 seed in, 22.086667 out");
        assertEq(USDG.balanceOf(alice), 24_573_333, "Alice: 20 in, 24.573333 out");
        assertEq(USDG.balanceOf(dave), 331_740_000 + 30 * U, "Dave: 300 in, 331.74 + 30 refused back");
        assertEq(USDG.balanceOf(bob), 0, "Bob lost 30");
        assertEq(USDG.balanceOf(carol), 0, "Carol lost 40");
        assertEq(USDG.balanceOf(safe), 1_599_998 + 2, "Safe: fees + residue");
        assertEq(USDG.balanceOf(relayer), 0, "the relayer never receives a unit");
        assertEq(USDG.balanceOf(stranger), 0, "the resolver-caller never receives a unit");
        assertEq(_escrow(), 0, "INV-1: nothing owed, nothing left");
        assertEq(USDG.balanceOf(address(factory)), 0);
    }

    // ================================================================== S4 finding

    /// @notice A used (or cancelled) authorization must not book an entry. Real USDG returns
    ///         successfully for it without paying, so a settler that trusts the call to revert
    ///         books a position nobody paid for, whose refused part (or payout) is then paid out
    ///         of other bettors' escrow. The attack costs nothing: the attacker cancels an
    ///         authorization nonce of their own (`cancelAuthorization`), then relays entries on
    ///         that nonce with any signature. This test passes only when HunchVPM refuses such
    ///         an entry (it must check `authorizationState(from, nonce)` before the pull, or
    ///         check its balance delta after it).
    function test_AUsedOrCancelledAuthorizationCannotBookAnEntry() public {
        (uint256 id,) = _open(100e6);
        // honest money in the escrow: 20 seed + 200 of bets
        vm.roll(block.number + 1);
        _enter(alice, id, 0, 100 * U);
        _enter(bob, id, 1, 100 * U);
        uint256 honest = _escrow();

        // the attacker holds no USDG and burns a nonce of their own for free
        uint256 attackerPk = 0xBAD;
        address attacker = vm.addr(attackerPk);
        bytes32 salt = keccak256("free entry");
        bytes32 nonce = vpm.enterNonce(id, 0, 100 * U, salt);
        IUSDGCancel(RH.USDG).cancelAuthorization(attacker, nonce, _sign(attackerPk, _cancelDigest(attacker, nonce)));
        assertTrue(USDG.authorizationState(attacker, nonce), "the nonce is burnt");

        // enter on that nonce with a junk signature: real USDG returns without paying
        // (it emits AuthorizationAlreadyUsed and checks neither the signature nor the value)
        vm.roll(block.number + 1);
        vm.prank(attacker);
        try vpm.enterWithAuthorization(
            attacker, id, 0, 100 * U, 0, block.timestamp + 1 days, salt, new bytes(65)
        ) returns (
            uint256 pid
        ) {
            (,,,,,,, uint128 offered,,) = vpm.positions(pid);
            assertTrue(
                false,
                string.concat(
                    "HunchVPM booked a ",
                    vm.toString(offered / U),
                    " USDG entry for an attacker who paid nothing (USDG does not revert on a used or ",
                    "cancelled authorization); its payout or refund would come out of other bettors' escrow"
                )
            );
        } catch {}
        assertEq(USDG.balanceOf(attacker), 0, "the attacker got nothing");
        assertEq(_escrow(), honest, "the escrow is untouched");
    }

    /// @notice The plain replay of a relayed entry (same signature, same salt) is refused too.
    function test_ARelayedEntryCannotBeReplayed() public {
        (uint256 id,) = _open(100e6);
        vm.roll(block.number + 1);
        _fundUsdg(carol, 40 * U);
        bytes32 salt = keccak256("once");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _sign(
            CAROL_PK, _receiveDigest(carol, address(vpm), 40 * U, 0, validBefore, vpm.enterNonce(id, 1, 40 * U, salt))
        );
        vm.prank(relayer);
        vpm.enterWithAuthorization(carol, id, 1, 40 * U, 0, validBefore, salt, sig);
        uint256 escrow = _escrow();
        uint256 positions = vpm.marketPositionCount(id);

        vm.prank(relayer);
        try vpm.enterWithAuthorization(carol, id, 1, 40 * U, 0, validBefore, salt, sig) {
            assertTrue(false, "a replayed signed entry was booked without payment (USDG returned instead of reverting)");
        } catch {}
        assertEq(_escrow(), escrow, "no unpaid stake");
        assertEq(vpm.marketPositionCount(id), positions, "no extra position");
    }
}
