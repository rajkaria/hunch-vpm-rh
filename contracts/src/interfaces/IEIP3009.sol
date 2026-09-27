// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  The part of EIP-3009 that HunchVPM uses
/// @notice USDG on Robinhood Chain (4663) implements EIP-3009 in full, including the
///         `bytes`-signature overload of `receiveWithAuthorization` (selector 0x88b7ab63),
///         which accepts both 65-byte ECDSA signatures and ERC-1271 smart-wallet signatures.
///         `receiveWithAuthorization` reverts unless `msg.sender == to`, so a signed
///         authorization naming HunchVPM as the payee can only ever be redeemed by HunchVPM.
interface IEIP3009 {
    /// @notice Pull `value` from `from` to `to` (== msg.sender) with `from`'s EIP-712 signature
    ///         over ReceiveWithAuthorization(from,to,value,validAfter,validBefore,nonce).
    ///         Valid strictly after `validAfter` and strictly before `validBefore`; the
    ///         `(from, nonce)` pair is marked used, so it can never be redeemed twice.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    /// @notice True once `(authorizer, nonce)` has been used or cancelled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
