// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OpenMarket} from "../script/OpenMarket.s.sol";
import {VestedParimutuel} from "../src/VestedParimutuel.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {FeedResolver} from "../src/FeedResolver.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {ChainlinkFeedOracle} from "../src/oracles/ChainlinkFeedOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {FakeAggregator} from "./Oracles.t.sol";

/// @notice The market script is what an operator runs on mainnet launch day, once, with real
///         money. It prints two transactions rather than sending them, so the tests send exactly
///         what it prints and check the chain ends up where it said it would — plus every refusal,
///         because a spec is hashed into its id and is never edited.
/// @dev    Only `test_RunsFromTheEnvironment` touches the environment: env vars are process-wide
///         and forge runs tests in parallel.
contract OpenMarketTest is Test {
    OpenMarket internal script;
    VestedParimutuel internal vpm;
    MockERC20 internal token;
    MockOracle internal oracle;
    FeedResolver internal resolver;
    MarketFactory internal factory;

    bytes32 internal constant FEED = keccak256("BTC / USD");
    int256 internal constant STRIKE = 77_000_00000000;
    uint256 internal constant SEED = 2e6;

    function setUp() public {
        vm.warp(1_789_000_000);
        script = new OpenMarket();
        vpm = new VestedParimutuel();
        token = new MockERC20();
        oracle = new MockOracle();
        resolver = new FeedResolver();
        factory = new MarketFactory(resolver);

        token.mint(address(this), 100e6);
        oracle.set(FEED, 76_752_00000000, block.timestamp - 600);
    }

    function _params() internal view returns (OpenMarket.Params memory) {
        return OpenMarket.Params({
            factory: factory,
            settler: address(vpm),
            oracle: address(oracle),
            feedKey: FEED,
            strike8: STRIKE,
            direction: 0,
            resolutionTime: uint64(block.timestamp + 2 days),
            maxStaleness: 5400,
            voidTimeout: 3 days,
            seedPerSide: SEED,
            kappa: 30,
            token: address(token),
            residueOwner: address(0),
            skipFeedCheck: false
        });
    }

    /// @dev Send the plan's two transactions from this contract, as `cast send` would from the operator.
    function _send(OpenMarket.Plan memory plan) internal returns (uint256 marketId, bytes32 specId) {
        (bool approved,) = address(token).call(plan.approveCalldata);
        assertTrue(approved, "approve");
        (bool opened, bytes memory ret) = address(factory).call(plan.openCalldata);
        assertTrue(opened, "open");
        return abi.decode(ret, (uint256, bytes32));
    }

    // ------------------------------------------------------------------ the plan is what happens

    function test_ThePrintedTransactionsOpenExactlyThePredictedMarket() public {
        OpenMarket.Params memory p = _params();
        script.preflight(p, address(this));
        OpenMarket.Plan memory plan = script.planFor(p, address(this));

        (uint256 marketId, bytes32 specId) = _send(plan);
        assertEq(marketId, plan.marketId, "the market id it predicted");
        assertEq(specId, plan.specId, "the spec id it predicted");

        (
            address settler,
            uint256 specMarketId,
            address specOracle,
            bytes32 feedKey,
            int256 strike,,
            uint64 resolutionTime,
            uint64 maxStaleness
        ) = resolver.specs(specId);
        assertEq(settler, address(vpm), "spec names the settler");
        assertEq(specMarketId, marketId, "spec names the market");
        assertEq(specOracle, address(oracle), "spec names the oracle");
        assertEq(feedKey, FEED, "feed key");
        assertEq(strike, STRIKE, "strike");
        assertEq(resolutionTime, p.resolutionTime, "freeze");
        assertEq(maxStaleness, 5400, "bound");

        assertEq(token.balanceOf(address(factory)), 0, "the factory keeps nothing");
        assertEq(token.balanceOf(address(this)), 100e6 - 2 * SEED, "the opener paid exactly the seed");
    }

    function test_ThePredictionFollowsTheSettlersNextId() public {
        OpenMarket.Params memory p = _params();
        _send(script.planFor(p, address(this)));

        p.strike8 = 80_000_00000000;
        OpenMarket.Plan memory second = script.planFor(p, address(this));
        assertEq(second.marketId, 1, "the second market is id 1");
        (uint256 marketId, bytes32 specId) = _send(second);
        assertEq(marketId, 1, "market");
        assertEq(specId, second.specId, "spec");
    }

    function test_OpensOnAChainlinkAdapterWithTheFeedAddressAsItsKey() public {
        FakeAggregator aggregator = new FakeAggregator(8, 2_478_55000000, block.timestamp - 60);
        OpenMarket.Params memory p = _params();
        p.oracle = address(new ChainlinkFeedOracle());
        p.feedKey = script.feedKeyOf(address(aggregator), bytes32(0));
        p.strike8 = 2_500_00000000;
        p.maxStaleness = 90_000;

        script.preflight(p, address(this));
        (, bytes32 specId) = _send(script.planFor(p, address(this)));
        (,,, bytes32 feedKey,,,,) = resolver.specs(specId);
        assertEq(address(uint160(uint256(feedKey))), address(aggregator), "the key is the aggregator, left-padded");
    }

    function test_ResidueOwnerDefaultsToTheSenderAndCanBeNamed() public {
        OpenMarket.Params memory p = _params();
        p.residueOwner = address(0xBEEF);
        // Decode the Terms back out of the printed calldata and check the owner it carries.
        (MarketFactory.Terms memory named,) =
            abi.decode(_args(script.planFor(p, address(this)).openCalldata), (MarketFactory.Terms, MarketFactory.Feed));
        assertEq(named.residueOwner, address(0xBEEF), "named");

        p.residueOwner = address(0);
        (MarketFactory.Terms memory defaulted,) =
            abi.decode(_args(script.planFor(p, address(this)).openCalldata), (MarketFactory.Terms, MarketFactory.Feed));
        assertEq(defaulted.residueOwner, address(this), "the sender");
    }

    function test_SkipFeedCheckPassesARelayThatHasNotDeliveredYet() public {
        OpenMarket.Params memory p = _params();
        p.feedKey = keccak256("ETH / USD"); // nothing was ever written under this key
        p.skipFeedCheck = true;
        script.preflight(p, address(this));
    }

    // ------------------------------------------------------------------ the refusals

    function test_RefusesAFeedThatHasNeverBeenWritten() public {
        OpenMarket.Params memory p = _params();
        p.feedKey = keccak256("ETH / USD");
        vm.expectRevert(bytes("the oracle returned a non-positive price"));
        script.preflight(p, address(this));
    }

    function test_RefusesAnOracleThatDoesNotAnswer() public {
        OpenMarket.Params memory p = _params();
        p.oracle = address(new ChainlinkFeedOracle());
        p.feedKey = bytes32(uint256(uint160(address(0xDEAD)))); // no aggregator there
        vm.expectRevert(
            bytes("the oracle does not answer for this feed key. SKIP_FEED_CHECK=true only if that is expected")
        );
        script.preflight(p, address(this));
    }

    function test_RefusesAFeedAlreadyOlderThanTheBound() public {
        oracle.set(FEED, 76_752_00000000, block.timestamp - 5401);
        vm.expectRevert(bytes("the feed's last reading is already older than MAX_STALENESS"));
        script.preflight(_params(), address(this));
    }

    function test_RefusesAFreezeInThePast() public {
        OpenMarket.Params memory p = _params();
        p.resolutionTime = uint64(block.timestamp);
        vm.expectRevert(bytes("RESOLUTION_TIME is not in the future"));
        script.preflight(p, address(this));
    }

    function test_RefusesWithoutTheWholeSeed() public {
        OpenMarket.Params memory p = _params();
        p.seedPerSide = 51e6;
        vm.expectRevert(bytes("the sender does not hold the whole seed (two sides, 6-decimal units)"));
        script.preflight(p, address(this));
    }

    function test_RefusesAnAddressWithNoCode() public {
        OpenMarket.Params memory p = _params();
        p.factory = MarketFactory(address(0xFAC7));
        vm.expectRevert(bytes("MARKET_FACTORY has no code on this chain"));
        script.preflight(p, address(this));
    }

    function test_RefusesANonPositiveStrikeAndABadDirection() public {
        OpenMarket.Params memory p = _params();
        p.strike8 = 0;
        vm.expectRevert(bytes("STRIKE8 must be positive, at 8 decimals"));
        script.preflight(p, address(this));

        p = _params();
        p.direction = 2;
        vm.expectRevert(bytes("DIRECTION is 0 (above) or 1 (below)"));
        script.preflight(p, address(this));
    }

    function test_FeedKeyNeedsExactlyOneSource() public {
        vm.expectRevert(bytes("set exactly one of CHAINLINK_FEED (an aggregator address) or FEED_KEY (bytes32)"));
        script.feedKeyOf(address(0), bytes32(0));

        vm.expectRevert(bytes("set exactly one of CHAINLINK_FEED (an aggregator address) or FEED_KEY (bytes32)"));
        script.feedKeyOf(address(0xBEEF), FEED);

        assertEq(script.feedKeyOf(address(0), FEED), FEED, "a raw key passes through");
        assertEq(
            script.feedKeyOf(0x50FCDD99D6762D1C170DC6A9111db944AEE6D364, bytes32(0)),
            bytes32(uint256(uint160(0x50FCDD99D6762D1C170DC6A9111db944AEE6D364))),
            "an aggregator is left-padded"
        );
    }

    // ------------------------------------------------------------------ the environment

    function test_RunsFromTheEnvironment() public {
        vm.setEnv("MARKET_FACTORY", vm.toString(address(factory)));
        vm.setEnv("SETTLER", vm.toString(address(vpm)));
        vm.setEnv("ORACLE", vm.toString(address(oracle)));
        vm.setEnv("FEED_KEY", vm.toString(FEED));
        vm.setEnv("STRIKE8", "7700000000000");
        vm.setEnv("RESOLUTION_TIME", vm.toString(block.timestamp + 2 days));
        vm.setEnv("MAX_STALENESS", "5400");
        vm.setEnv("SEED_PER_SIDE", "2000000");
        vm.setEnv("TOKEN", vm.toString(address(token)));

        OpenMarket.Params memory p = script.params();
        assertEq(address(p.factory), address(factory), "factory");
        assertEq(p.feedKey, FEED, "feed key");
        assertEq(p.strike8, STRIKE, "strike");
        assertEq(p.maxStaleness, 5400, "bound");
        assertEq(p.seedPerSide, SEED, "seed");
        assertEq(p.voidTimeout, 3 days, "void timeout defaults to three days");
        assertEq(p.kappa, 30, "kappa defaults to 30");
        assertEq(p.direction, 0, "direction defaults to above");
        assertEq(p.residueOwner, address(0), "residue owner defaults to the sender");
        assertFalse(p.skipFeedCheck, "the feed check is on by default");

        // run() is what forge calls: it checks, plans and prints, and moves nothing.
        OpenMarket.Plan memory plan = script.run();
        assertEq(plan.marketId, 0, "first market on a fresh settler");
        assertEq(token.balanceOf(address(this)), 100e6, "nothing was sent");
        assertEq(vpm.marketCount(), 0, "nothing was opened");
    }

    /// @dev Strip a calldata's 4-byte selector.
    function _args(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = data[i + 4];
        }
    }
}
