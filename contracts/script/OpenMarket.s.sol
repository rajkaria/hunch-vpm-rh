// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "../src/VestedParimutuel.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {FeedResolver} from "../src/FeedResolver.sol";
import {MarketFactory, IERC20Spend} from "../src/MarketFactory.sol";

/// @notice Checks one two-outcome price market against the live chain, then prints the two
///         transactions that open it (approve, then `MarketFactory.open`), the market and spec
///         ids they will produce, and the entry for `deployments/arc-<network>.json`.
/// @dev    It SENDS NOTHING, by design. Arc's USDC calls a blocklist precompile
///         (`0x1800…0001`) inside every `transferFrom`, and forge's local EVM does not implement
///         it: any forge-simulated USDC transfer on Arc reverts with `StackUnderflow`, and
///         `forge script --broadcast` simulates before it sends. So forge does the part it can
///         do exactly — every read and every refusal — and `cast send`, which goes through the
///         node, does the sending.
///
///         Everything that decides a market is hashed into its spec id and can never be edited,
///         so this refuses rather than prints when:
///
///         - an address has no code on this chain;
///         - the freeze is not in the future, or the staleness bound is zero;
///         - the sender does not hold the whole seed;
///         - the oracle does not answer for the feed key RIGHT NOW with a reading no older than
///           the market's own bound. A market opened on a feed that does not read can only ever
///           void. `SKIP_FEED_CHECK=true` is for a relay that has not delivered yet — deliberately.
///
///         MARKET_FACTORY=0x... SETTLER=0x... ORACLE=0x... CHAINLINK_FEED=0x... \
///         STRIKE8=250000000000 RESOLUTION_TIME=1790000000 MAX_STALENESS=90000 SEED_PER_SIDE=2000000 \
///         forge script contracts/script/OpenMarket.s.sol --root contracts \
///           --rpc-url "$ARC_MAINNET_RPC_URL" --sender <the address that will send>
///
///         Environment (amounts in the ERC-20 view of USDC, 6 decimals):
///           MARKET_FACTORY    required
///           SETTLER           required, VestedParimutuel or ClassicParimutuel
///           ORACLE            required, the IPriceOracle adapter
///           CHAINLINK_FEED    the aggregator address, for ChainlinkFeedOracle   } exactly one
///           FEED_KEY          bytes32, for any other adapter                    }
///           STRIKE8           required, 8 decimals, > 0
///           DIRECTION         0 = above (inclusive, default), 1 = below
///           RESOLUTION_TIME   required, unix seconds
///           MAX_STALENESS     required, seconds
///           SEED_PER_SIDE     required, > 0
///           VOID_TIMEOUT      default 259200 (3 days)
///           KAPPA             default 30
///           RESIDUE_OWNER     default the sender
///           TOKEN             default USDC at 0x3600…0000, the same on both Arc chains
///           SKIP_FEED_CHECK   default false
///           ACCOUNT           keystore name to print in the commands, default <keystore-account>
contract OpenMarket is Script {
    /// @dev USDC's ERC-20 interface on Arc: a predeploy at the same address on testnet and mainnet.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    struct Params {
        MarketFactory factory;
        address settler;
        address oracle;
        bytes32 feedKey;
        int256 strike8;
        uint8 direction;
        uint64 resolutionTime;
        uint64 maxStaleness;
        uint64 voidTimeout;
        uint256 seedPerSide;
        uint256 kappa;
        address token;
        address residueOwner;
        bool skipFeedCheck;
    }

    /// @notice The two transactions, in order, and what they will produce.
    /// @dev    `marketId` is the settler's next id at the block this ran against. If another market
    ///         opens on the same settler first, both ids move on by one — read `MarketOpened`.
    struct Plan {
        bytes approveCalldata;
        bytes openCalldata;
        uint256 marketId;
        bytes32 specId;
    }

    function run() external returns (Plan memory plan) {
        Params memory p = params();
        address opener = msg.sender; // --sender
        preflight(p, opener);
        plan = planFor(p, opener);
        _print(p, opener, plan);
    }

    /// @notice The market this run describes, read from the environment.
    function params() public view returns (Params memory p) {
        p.factory = MarketFactory(vm.envAddress("MARKET_FACTORY"));
        p.settler = vm.envAddress("SETTLER");
        p.oracle = vm.envAddress("ORACLE");
        p.feedKey = feedKeyOf(vm.envOr("CHAINLINK_FEED", address(0)), vm.envOr("FEED_KEY", bytes32(0)));
        p.strike8 = vm.envInt("STRIKE8");
        p.direction = uint8(vm.envOr("DIRECTION", uint256(0)));
        p.resolutionTime = uint64(vm.envUint("RESOLUTION_TIME"));
        p.maxStaleness = uint64(vm.envUint("MAX_STALENESS"));
        p.voidTimeout = uint64(vm.envOr("VOID_TIMEOUT", uint256(3 days)));
        p.seedPerSide = vm.envUint("SEED_PER_SIDE");
        p.kappa = vm.envOr("KAPPA", uint256(30));
        p.token = vm.envOr("TOKEN", ARC_USDC);
        p.residueOwner = vm.envOr("RESIDUE_OWNER", address(0));
        p.skipFeedCheck = vm.envOr("SKIP_FEED_CHECK", false);
    }

    /// @notice ChainlinkFeedOracle reads the aggregator's address left-padded into the word; every
    ///         other adapter defines its own key. Exactly one of the two must be given.
    function feedKeyOf(address chainlinkFeed, bytes32 feedKey) public pure returns (bytes32) {
        require(
            (chainlinkFeed == address(0)) != (feedKey == bytes32(0)),
            "set exactly one of CHAINLINK_FEED (an aggregator address) or FEED_KEY (bytes32)"
        );
        return chainlinkFeed != address(0) ? bytes32(uint256(uint160(chainlinkFeed))) : feedKey;
    }

    /// @notice Every refusal. Reverts with the reason; returns when the market is safe to open.
    function preflight(Params memory p, address opener) public view {
        require(address(p.factory).code.length != 0, "MARKET_FACTORY has no code on this chain");
        require(p.settler.code.length != 0, "SETTLER has no code on this chain");
        require(p.oracle.code.length != 0, "ORACLE has no code on this chain");
        require(p.token.code.length != 0, "TOKEN has no code on this chain");
        require(p.strike8 > 0, "STRIKE8 must be positive, at 8 decimals");
        require(p.direction <= 1, "DIRECTION is 0 (above) or 1 (below)");
        require(p.resolutionTime > block.timestamp, "RESOLUTION_TIME is not in the future");
        require(p.maxStaleness > 0, "MAX_STALENESS must be non-zero");
        require(p.seedPerSide > 0, "SEED_PER_SIDE must be positive");
        require(
            IERC20Spend(p.token).balanceOf(opener) >= p.seedPerSide * 2,
            "the sender does not hold the whole seed (two sides, 6-decimal units)"
        );

        if (p.skipFeedCheck) {
            console.log("SKIP_FEED_CHECK=true: the feed was not read");
            return;
        }
        (int256 price8, uint256 updatedAt) = _read(p);
        require(price8 > 0, "the oracle returned a non-positive price");
        require(updatedAt <= block.timestamp, "the oracle's reading is timestamped in the future");
        uint256 age = block.timestamp - updatedAt;
        require(age <= p.maxStaleness, "the feed's last reading is already older than MAX_STALENESS");
        console.log("feed reads %s (8 dp), %s s old", vm.toString(price8), age);
    }

    /// @notice The calldata for both transactions, and the ids they will produce.
    function planFor(Params memory p, address opener) public view returns (Plan memory plan) {
        uint256[] memory seed = new uint256[](2);
        seed[0] = p.seedPerSide;
        seed[1] = p.seedPerSide;

        MarketFactory.Terms memory terms = MarketFactory.Terms({
            settler: IParimutuelSettler(p.settler),
            token: IERC20(p.token),
            seed: seed,
            kappa: p.kappa,
            resolutionTime: p.resolutionTime,
            voidTimeout: p.voidTimeout,
            residueOwner: p.residueOwner == address(0) ? opener : p.residueOwner
        });
        MarketFactory.Feed memory feed = MarketFactory.Feed({
            oracle: p.oracle,
            feedKey: p.feedKey,
            strike: p.strike8,
            direction: p.direction,
            maxStaleness: p.maxStaleness
        });

        plan.approveCalldata = abi.encodeCall(IERC20Spend.approve, (address(p.factory), p.seedPerSide * 2));
        plan.openCalldata = abi.encodeCall(MarketFactory.open, (terms, feed));
        plan.marketId = IParimutuelSettler(p.settler).marketCount();
        FeedResolver resolver = p.factory.resolver();
        plan.specId = resolver.specIdOf(
            FeedResolver.Spec({
                settler: p.settler,
                marketId: plan.marketId,
                oracle: p.oracle,
                feedKey: p.feedKey,
                strike: p.strike8,
                direction: p.direction,
                resolutionTime: p.resolutionTime,
                maxStaleness: p.maxStaleness
            })
        );
    }

    function _read(Params memory p) internal view returns (int256, uint256) {
        try IPriceOracle(p.oracle).read(p.feedKey) returns (int256 price8, uint256 updatedAt) {
            return (price8, updatedAt);
        } catch {
            revert("the oracle does not answer for this feed key. SKIP_FEED_CHECK=true only if that is expected");
        }
    }

    function _print(Params memory p, address opener, Plan memory plan) internal view {
        string memory rpc = block.chainid == 5042 ? '"$ARC_MAINNET_RPC_URL"' : '"$ARC_TESTNET_RPC_URL"';
        string memory account = vm.envOr("ACCOUNT", string("<keystore-account>"));
        string memory tail = string.concat(" --rpc-url ", rpc, " --account ", account);

        console.log("");
        console.log("Checks passed on chain %s. NOTHING WAS SENT. From %s, run in order:", block.chainid, opener);
        console.log("");
        console.log(string.concat("cast send ", vm.toString(p.token), " ", vm.toString(plan.approveCalldata), tail));
        console.log(
            string.concat("cast send ", vm.toString(address(p.factory)), " ", vm.toString(plan.openCalldata), tail)
        );
        console.log("");
        console.log("Expected market id %s and spec id:", plan.marketId);
        console.log(vm.toString(plan.specId));
        console.log("Confirm both against the MarketOpened log before committing the entry below.");
        console.log("");
        console.log("{");
        console.log('  "id": "%s-%s",', vm.toLowercase(vm.toString(p.settler)), vm.toString(plan.marketId));
        console.log('  "marketId": %s,', vm.toString(plan.marketId));
        console.log('  "specId": "%s",', vm.toString(plan.specId));
        console.log('  "feedKey": "%s",', vm.toString(p.feedKey));
        console.log('  "strike8": "%s",', vm.toString(p.strike8));
        console.log('  "direction": %s,', vm.toString(uint256(p.direction)));
        console.log('  "resolutionTime": %s,', vm.toString(uint256(p.resolutionTime)));
        console.log('  "voidTimeout": %s,', vm.toString(uint256(p.voidTimeout)));
        console.log('  "maxStaleness": %s,', vm.toString(uint256(p.maxStaleness)));
        console.log('  "seed": ["%s", "%s"],', vm.toString(p.seedPerSide), vm.toString(p.seedPerSide));
        console.log('  "kappa": %s', vm.toString(p.kappa));
        console.log("}");
    }
}
