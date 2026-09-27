// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {VestedParimutuel} from "../src/VestedParimutuel.sol";
import {ClassicParimutuel} from "../src/ClassicParimutuel.sol";
import {FeedResolver} from "../src/FeedResolver.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {ChainlinkFeedOracle} from "../src/oracles/ChainlinkFeedOracle.sol";
import {StorkOracle, IStork} from "../src/oracles/StorkOracle.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";

/// @notice Deploys the whole settlement layer and prints a deployments JSON to stdout.
/// @dev    Which oracle adapter ships is configuration, not code: set `ORACLE_KIND` to
///         `stork`, `chainlink` or `mock`. Stork is the only provider with a published Arc
///         testnet address today; `chainlink` needs no address here because the feed itself
///         is the `feedKey` passed per market.
///
///         ORACLE_KIND=stork STORK_ADDRESS=0x... \
///         forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --verify
contract Deploy is Script {
    /// @dev Stork's published Arc testnet contract.
    address internal constant STORK_ARC_TESTNET = 0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62;

    function run() external {
        vm.startBroadcast();

        VestedParimutuel vested = new VestedParimutuel();
        ClassicParimutuel classic = new ClassicParimutuel();
        IPriceOracle oracle = _oracle();
        FeedResolver resolver = new FeedResolver();
        MarketFactory factory = new MarketFactory(resolver);

        vm.stopBroadcast();

        console.log("{");
        console.log('  "chainId": %s,', vm.toString(block.chainid));
        console.log('  "vestedParimutuel": "%s",', vm.toString(address(vested)));
        console.log('  "classicParimutuel": "%s",', vm.toString(address(classic)));
        console.log('  "priceOracle": "%s",', vm.toString(address(oracle)));
        console.log('  "feedResolver": "%s",', vm.toString(address(resolver)));
        console.log('  "marketFactory": "%s"', vm.toString(address(factory)));
        console.log("}");
    }

    function _oracle() internal returns (IPriceOracle) {
        string memory kind = vm.envOr("ORACLE_KIND", string("stork"));
        bytes32 k = keccak256(bytes(kind));

        if (k == keccak256("chainlink")) return new ChainlinkFeedOracle();
        if (k == keccak256("mock")) return new MockOracle();

        address stork = vm.envOr("STORK_ADDRESS", STORK_ARC_TESTNET);
        return new StorkOracle(IStork(stork));
    }
}
