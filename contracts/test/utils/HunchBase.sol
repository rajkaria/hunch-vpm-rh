// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HunchVPM, IERC20} from "../../src/HunchVPM.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";

/// @notice ERC-1271 smart wallet for the `bytes`-signature path: accepts a digest signed by
///         its owner key (65-byte ECDSA), like a 1-of-1 Safe or a passkey account would.
contract MockSmartWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(hash, v, r, s) == owner ? this.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// @notice Shared fixture for the HunchVPM suites: a MockUSDG, a HunchVPM with a guardian and
///         a treasury, named bettors with private keys (for EIP-3009 signatures), and helpers
///         that open, fill and settle markets the way the venue does.
abstract contract HunchBase is Test {
    HunchVPM internal vpm;
    MockUSDG internal usdg;

    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal resolver = makeAddr("resolver");
    address internal residueOwner = makeAddr("residueOwner");
    address internal creator = makeAddr("creator");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;
    uint256 internal carolPk = 0xCA201;
    address internal alice;
    address internal bob;
    address internal carol;

    uint256 internal constant USDG = 1e6;
    uint256 internal constant KAPPA = 30;
    uint64 internal constant VOID_TIMEOUT = 72 hours;
    uint64 internal T; // the freeze of markets opened by `_create`

    function setUp() public virtual {
        vm.warp(1_790_000_000); // 2026-09-21, a realistic unix time
        vm.roll(23_000_000); // an L1 block number, which is what `block.number` reads on 4663
        usdg = new MockUSDG();
        vpm = new HunchVPM(guardian, treasury);
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        carol = vm.addr(carolPk);
        vm.label(alice, "alice");
        vm.label(bob, "bob");
        vm.label(carol, "carol");
        T = uint64(block.timestamp + 1 days);
        usdg.mint(creator, 1e15);
        vm.prank(creator);
        usdg.approve(address(vpm), type(uint256).max);
    }

    // ------------------------------------------------------------------ market helpers

    function _seed(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        s[0] = a;
        s[1] = b;
    }

    function _createWith(uint256[] memory seed, uint256 kappa, uint16 feeBps, uint128 minEntry, uint128 maxEntry)
        internal
        returns (uint256 id)
    {
        vm.prank(creator);
        id = vpm.create(
            IERC20(address(usdg)), seed, kappa, T, VOID_TIMEOUT, resolver, residueOwner, feeBps, minEntry, maxEntry
        );
    }

    /// @dev The venue's market: κ = 30, seed 10 / 10 USDG, the given fee, bounds 1 to 100 USDG.
    function _create(uint16 feeBps) internal returns (uint256) {
        return _createWith(_seed(10 * USDG, 10 * USDG), KAPPA, feeBps, uint128(1 * USDG), uint128(100 * USDG));
    }

    /// @dev Fee 0 and no bounds: the configuration the differential suite compares.
    function _createPlain(uint256[] memory seed, uint256 kappa) internal returns (uint256) {
        return _createWith(seed, kappa, 0, 0, 0);
    }

    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.prank(who);
        usdg.approve(address(vpm), type(uint256).max);
    }

    /// @dev Enter in the CURRENT block (same vintage as any other entry of this block).
    function _enter(address who, uint256 id, uint8 outcome, uint256 amount) internal returns (uint256 pid) {
        _fund(who, amount);
        vm.prank(who);
        pid = vpm.enter(id, outcome, amount);
    }

    /// @dev Enter in a NEW block (its own vintage).
    function _enterNext(address who, uint256 id, uint8 outcome, uint256 amount) internal returns (uint256) {
        vm.roll(block.number + 1);
        return _enter(who, id, outcome, amount);
    }

    function _settle(uint256 id, uint8 winner) internal {
        vm.roll(block.number + 1);
        vm.warp(T);
        vm.prank(resolver);
        vpm.resolve(id, winner);
    }

    function _void(uint256 id) internal {
        vm.roll(block.number + 1);
        vm.warp(T);
        vm.prank(resolver);
        vpm.voidMarket(id);
    }

    /// @dev The worked example of docs/spec/02-mechanism.md: κ = 30, seed 10 / 10, then Mei UP
    ///      20, Dan DOWN 30, Kim DOWN 40, Ben UP 50, Lee DOWN 10, each in its own block, with
    ///      no bounds. Returns the market and the five position ids in that order.
    function _workedExample(uint16 feeBps) internal returns (uint256 id, uint256[5] memory pid) {
        id = _createWith(_seed(10 * USDG, 10 * USDG), KAPPA, feeBps, 0, 0);
        pid[0] = _enterNext(makeAddr("Mei"), id, 0, 20 * USDG);
        pid[1] = _enterNext(makeAddr("Dan"), id, 1, 30 * USDG);
        pid[2] = _enterNext(makeAddr("Kim"), id, 1, 40 * USDG);
        pid[3] = _enterNext(makeAddr("Ben"), id, 0, 50 * USDG);
        pid[4] = _enterNext(makeAddr("Lee"), id, 1, 10 * USDG);
    }

    // ------------------------------------------------------------------ EIP-3009 helpers

    function _digest(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, address(vpm), value, validAfter, validBefore, nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev The signature a wallet produces for one HunchVPM entry: USDG's EIP-712
    ///      ReceiveWithAuthorization with `to` = HunchVPM and nonce = `enterNonce(...)`.
    function _signEnter(
        uint256 pk,
        uint256 id,
        uint8 outcome,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt
    ) internal view returns (bytes memory) {
        bytes32 digest = _digest(
            vm.addr(pk), amount, validAfter, validBefore, vpm.enterNonce(id, outcome, amount, salt)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sign with `pk` and relay from `relayer` in the current block; valid for one hour.
    function _relayEnter(uint256 pk, uint256 id, uint8 outcome, uint256 amount, bytes32 salt)
        internal
        returns (uint256 pid)
    {
        address from = vm.addr(pk);
        usdg.mint(from, amount);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signEnter(pk, id, outcome, amount, 0, validBefore, salt);
        vm.prank(relayer);
        pid = vpm.enterWithAuthorization(from, id, outcome, amount, 0, validBefore, salt, sig);
    }

    // ------------------------------------------------------------------ readers

    function _position(uint256 pid)
        internal
        view
        returns (address owner, uint8 outcome, bool finalized, uint128 offered, uint128 accepted, uint128 entryAcc)
    {
        (, owner, outcome, finalized,,,, offered, accepted, entryAcc) = vpm.positions(pid);
    }

    function _status(uint256 id) internal view returns (HunchVPM.Status status) {
        (,,,,,,, status,,,,) = vpm.getMarket(id);
    }

    function _pool(uint256 id) internal view returns (uint256 acceptedPool, uint256 paidOut) {
        (,,,,,,,,,, acceptedPool, paidOut) = vpm.getMarket(id);
    }
}
