// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice A deployment script that only runs on the day you need it is a deployment
///         script that fails on the day you need it. This runs all three oracle
///         configurations in the test suite so a broken one is caught in CI.
contract DeployTest is Test {
    function test_DeploysWithStorkByDefault() public {
        Deploy deployer = new Deploy();
        deployer.run();
    }

    function test_DeploysWithChainlink() public {
        vm.setEnv("ORACLE_KIND", "chainlink");
        Deploy deployer = new Deploy();
        deployer.run();
    }

    function test_DeploysWithTheMockOracle() public {
        vm.setEnv("ORACLE_KIND", "mock");
        Deploy deployer = new Deploy();
        deployer.run();
    }
}
