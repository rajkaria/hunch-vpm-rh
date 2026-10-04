// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice forge 1.8's `lastFrameGas` cheatcode, which replaces the deprecated `lastCallGas`
///         (forge-std 1.9.7 predates it). In a test running in isolate mode (inline config
///         `default.isolate = true`), every top-level call is its own transaction, and
///         `lastFrameGas().gasTotalUsed` is the gas that transaction needs: 21,000 + calldata +
///         execution, before the EIP-3529 refund, the figure `eth_estimateGas` returns for the
///         same transaction (checked against anvil on 2026-10-04). forge 1.5.1 reported it net
///         of the refund instead, one reason the repo pins its forge release (scripts/forge.sh).
interface VmFrameGas {
    function lastFrameGas() external view returns (Vm.Gas memory gas);
}

/// @dev The intrinsic gas of a transaction carrying `data` (EIP-2028; no access list, no
///      contract creation): 21,000 plus 4 per zero byte and 16 per non-zero byte.
function intrinsicGas(bytes memory data) pure returns (uint256 gas) {
    gas = 21_000;
    for (uint256 i = 0; i < data.length; i++) {
        gas += data[i] == 0 ? 4 : 16;
    }
}
