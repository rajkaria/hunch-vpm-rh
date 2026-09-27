// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RH, IUSDG} from "../../script/RH.sol";

/// @notice Shared fixture of the chain-4663 fork suites (T5f, T7, T7g, DeployRH).
///         Each suite forks Robinhood Chain at the LATEST block of `RH_RPC_URL` (the public
///         RPC keeps only ~10 minutes of state, so an older pinned block fails there; with a
///         keyed archive RPC, `RH_FORK_BLOCK` pins one). Without `RH_RPC_URL` (or with it
///         empty, as CI passes a missing secret) every test of the suite is skipped:
///
///           RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --root contracts --match-path 'test/fork/*'
///
///         On a fork, `block.number` is the fork's own counter (L2 style), not the L1 estimate
///         the EVM reads on chain 4663; vintages are driven explicitly with `vm.roll`.
abstract contract ForkBase is Test {
    IUSDG internal constant USDG = IUSDG(RH.USDG);
    /// @notice keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"), EIP-3009.
    bytes32 internal constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    /// @dev Fork chain 4663 and return true, or mark the suite skipped and return false.
    function _forkOrSkip() internal returns (bool) {
        string memory url = vm.envOr("RH_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true, "RH_RPC_URL is not set: the chain-4663 fork suites need an RPC");
            return false;
        }
        uint256 pinned = vm.envOr("RH_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        assertEq(block.chainid, RH.CHAIN_ID, "RH_RPC_URL is not Robinhood Chain (4663)");
        return true;
    }

    /// @dev Real USDG from the USDG/WETH pool (impersonated): exact, and no storage guessing.
    function _fundUsdg(address to, uint256 amount) internal {
        vm.prank(RH.USDG_WHALE);
        assertTrue(USDG.transfer(to, amount), "USDG transfer from the pool");
    }

    /// @dev USDG's EIP-712 digest for ReceiveWithAuthorization, built on the REAL domain
    ///      separator read from the chain (and pinned: the read must equal the constant).
    function _receiveDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 domain = USDG.DOMAIN_SEPARATOR();
        assertEq(domain, RH.USDG_DOMAIN_SEPARATOR, "USDG domain separator changed");
        bytes32 structHash = keccak256(
            abi.encode(RH.RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev USDG's CancelAuthorization digest (a signer may burn any nonce of their own).
    function _cancelDigest(address authorizer, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        return keccak256(abi.encodePacked("\x19\x01", USDG.DOMAIN_SEPARATOR(), structHash));
    }
}
