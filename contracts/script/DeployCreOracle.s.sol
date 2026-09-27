// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ChainlinkCreOracle} from "../src/oracles/ChainlinkCreOracle.sol";

/// @notice Deploys the Chainlink CRE relay adapter on its own, next to an existing deployment.
/// @dev    The resolver takes its oracle per market, so adding a provider is one contract and no
///         redeploy of anything that holds stake. The forwarder defaults to Chainlink's
///         production `KeystoneForwarder` on Arc testnet — never the simulation
///         `MockKeystoneForwarder`, which checks no signatures and would let anyone write a price.
///         Any other chain has no default: set `CRE_FORWARDER` from Chainlink's forwarder directory.
///
///         forge script script/DeployCreOracle.s.sol --rpc-url arc_testnet --broadcast \
///           --account <keystore-account>
contract DeployCreOracle is Script {
    /// @dev Chainlink's production KeystoneForwarder on Arc testnet (typeAndVersion "KeystoneForwarder 1.0.0").
    address internal constant KEYSTONE_FORWARDER_ARC_TESTNET = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external {
        address forwarder =
            vm.envOr("CRE_FORWARDER", block.chainid == 5042002 ? KEYSTONE_FORWARDER_ARC_TESTNET : address(0));
        require(forwarder != address(0), "set CRE_FORWARDER: no verified KeystoneForwarder default for this chain");

        vm.startBroadcast();
        // The broadcaster owns it until the CRE workflow is named and the config is locked.
        ChainlinkCreOracle oracle = new ChainlinkCreOracle(forwarder, msg.sender);
        vm.stopBroadcast();

        console.log("{");
        console.log('  "chainId": %s,', vm.toString(block.chainid));
        console.log('  "chainlinkCreOracle": "%s",', vm.toString(address(oracle)));
        console.log('  "creForwarder": "%s"', vm.toString(forwarder));
        console.log("}");
    }
}
