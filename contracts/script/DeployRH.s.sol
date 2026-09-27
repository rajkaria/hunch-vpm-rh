// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HunchVPM} from "../src/HunchVPM.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {HunchMarketFactory} from "../src/HunchMarketFactory.sol";
import {IERC20Like} from "../src/interfaces/IERC20Like.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {RH, IChainlinkProxy, IUSDG, ISafeLike} from "./RH.sol";

/// @title  DeployRH: the Hunch venue on Robinhood Chain (4663), in one run
/// @notice The operator runs (docs/OPERATOR.md step 6):
///
///           forge script contracts/script/DeployRH.s.sol:DeployRH --root contracts \
///             --rpc-url $RH_RPC_URL --account hunch-deployer --sender <DEPLOYER> --broadcast --slow
///
///         then `bash scripts/post-deploy.sh` (tx hashes, L2 blocks, time, git commit).
///         Inputs by env var name only: SAFE_ADDRESS, KEEPER_ADDRESS, optional ALLOW_1OF1=1,
///         optional DEPLOYMENTS_OUT (default ../deployments/robinhood-mainnet.json, relative to
///         contracts/), optional DEPLOYMENTS_TEMPLATE (default: the same file), optional
///         GIT_COMMIT. The signer comes from forge's flags (keystore or, on anvil only, a test
///         key); no key is ever read from the environment.
///
///         Preflight (any failure reverts with a message naming what to fix): chain id 4663;
///         the Safe has code and a threshold of at least 2 (or ALLOW_1OF1=1); USDG has 6
///         decimals, its pinned EIP-712 domain separator and is not paused; every feed has 8
///         decimals, the pinned description and a sane latest answer; every Stock Token has the
///         ticker as its symbol; the deployer holds at least 0.002 ETH; the deployment JSON
///         agrees with the pinned facts and is not already "deployed".
///
///         Deploys StockRoundResolver → HunchVPM(guardian = treasury = Safe) →
///         HunchMarketFactory(owner = deployer, treasury = Safe), allow-lists NVDA, TSLA, AAPL and
///         COIN (26 h bounds), sets the keeper as the only opener and starts the two-step
///         ownership transfer to the Safe (the Safe then calls acceptOwnership()). Writes the
///         deployment JSON with status "deployed", the addresses, the Safe, the keeper and each
///         feed's current aggregator; deploy tx hashes, blocks, startBlock and deployedAt stay
///         null until scripts/post-deploy.sh reads them from the broadcast receipts (on 4663,
///         `block.number` inside the EVM is the L1 estimate, not the L2 block).
contract DeployRH is Script {
    string internal constant DEFAULT_JSON = "../deployments/robinhood-mainnet.json";

    struct Config {
        address deployer;
        address safe;
        address keeper;
        bool allow1of1;
        string template;
        string out;
        string gitCommit;
    }

    struct Deployed {
        StockRoundResolver resolver;
        HunchVPM vpm;
        HunchMarketFactory factory;
    }

    // ================================================================== entry point

    function run() external returns (Deployed memory d) {
        Config memory c = _config();
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(c.template);
        address[4] memory aggregators = _preflight(c, json);

        uint64 nonce = vm.getNonce(c.deployer);
        console.log("Preflight passed. Deploying from", c.deployer, "starting at nonce", nonce);
        console.log("  StockRoundResolver will be", vm.computeCreateAddress(c.deployer, nonce));
        console.log("  HunchVPM           will be", vm.computeCreateAddress(c.deployer, nonce + 1));
        console.log("  HunchMarketFactory will be", vm.computeCreateAddress(c.deployer, nonce + 2));

        RH.Ticker[4] memory t = RH.tickers();
        vm.startBroadcast(c.deployer);
        d.resolver = new StockRoundResolver();
        d.vpm = new HunchVPM(c.safe, c.safe);
        d.factory = new HunchMarketFactory(d.vpm, d.resolver, IERC20Like(RH.USDG), c.deployer, c.safe);
        for (uint256 i = 0; i < t.length; i++) {
            d.factory.setFeed(t[i].feed, t[i].stockToken, t[i].ticker, RH.MAX_AGE, RH.MAX_AGE, true);
        }
        d.factory.setOpener(c.keeper, true);
        d.factory.transferOwnership(c.safe);
        vm.stopBroadcast();

        _postflight(c, d, json);
        _write(c, json, d, aggregators);
        _summary(c, d);
    }

    // ================================================================== inputs

    function _config() internal view returns (Config memory c) {
        c.deployer = msg.sender;
        c.safe = vm.envOr("SAFE_ADDRESS", address(0));
        c.keeper = vm.envOr("KEEPER_ADDRESS", address(0));
        string memory one = vm.envOr("ALLOW_1OF1", string(""));
        c.allow1of1 = _eq(one, "1") || _eq(one, "true");
        c.out = vm.envOr("DEPLOYMENTS_OUT", string(DEFAULT_JSON));
        c.template = vm.envOr("DEPLOYMENTS_TEMPLATE", string(DEFAULT_JSON));
        c.gitCommit = vm.envOr("GIT_COMMIT", string(""));
    }

    // ================================================================== preflight

    /// @return aggregators each feed's current aggregator, written to the JSON
    function _preflight(Config memory c, string memory json) internal view returns (address[4] memory aggregators) {
        // chain
        if (block.chainid != RH.CHAIN_ID) {
            _fail(string.concat("chain id is ", vm.toString(block.chainid), ", expected 4663 (check --rpc-url)"));
        }

        // deployer
        if (c.deployer == DEFAULT_SENDER || c.deployer == address(0)) {
            _fail("no deployer: pass --sender <DEPLOYER_ADDRESS> with --account hunch-deployer");
        }
        if (c.deployer.balance < RH.MIN_DEPLOYER_ETH) {
            _fail(
                string.concat(
                    "deployer ",
                    vm.toString(c.deployer),
                    " holds ",
                    vm.toString(c.deployer.balance),
                    " wei; it needs at least 0.002 ETH (docs/OPERATOR.md step 4)"
                )
            );
        }

        // Safe (owner of the factory, guardian and treasury of the settler)
        if (c.safe == address(0)) _fail("SAFE_ADDRESS is not set");
        if (c.safe.code.length == 0) {
            _fail(string.concat("SAFE_ADDRESS ", vm.toString(c.safe), " has no code: create the Safe first (step 2)"));
        }
        uint256 threshold;
        try ISafeLike(c.safe).getThreshold() returns (uint256 th) {
            threshold = th;
        } catch {
            _fail(string.concat("SAFE_ADDRESS ", vm.toString(c.safe), " is not a Safe (getThreshold() failed)"));
        }
        uint256 owners = ISafeLike(c.safe).getOwners().length;
        if (threshold == 0) _fail("the Safe has threshold 0: it is not set up");
        if (threshold < 2 && !c.allow1of1) {
            _fail(
                string.concat(
                    "the Safe is ",
                    vm.toString(threshold),
                    "-of-",
                    vm.toString(owners),
                    ": use a threshold of at least 2, or set ALLOW_1OF1=1 and say so in the README"
                )
            );
        }
        if (c.safe == c.deployer) _fail("SAFE_ADDRESS equals the deployer");

        // keeper (the only opener; its key lives in Vercel)
        if (c.keeper == address(0)) _fail("KEEPER_ADDRESS is not set");
        if (c.keeper == c.safe) _fail("KEEPER_ADDRESS equals SAFE_ADDRESS");
        if (c.keeper == c.deployer) _fail("KEEPER_ADDRESS equals the deployer: use two wallets (step 1)");

        // USDG
        if (RH.USDG.code.length == 0) _fail("USDG has no code at 0x5fc5...d168: wrong chain?");
        if (IUSDG(RH.USDG).decimals() != RH.USDG_DECIMALS) _fail("USDG decimals() is not 6");
        if (IUSDG(RH.USDG).DOMAIN_SEPARATOR() != RH.USDG_DOMAIN_SEPARATOR) {
            _fail("USDG DOMAIN_SEPARATOR() changed: signed (gasless) bets would fail; stop and investigate");
        }
        if (IUSDG(RH.USDG).paused()) _fail("USDG is paused by Paxos");

        // feeds and Stock Tokens
        RH.Ticker[4] memory t = RH.tickers();
        for (uint256 i = 0; i < t.length; i++) {
            aggregators[i] = _checkTicker(t[i]);
        }

        // the deployment JSON
        _checkJson(c, json, t);
    }

    function _checkTicker(RH.Ticker memory t) internal view returns (address aggregator) {
        string memory who = string.concat(t.ticker, " feed ", vm.toString(t.feed));
        if (t.feed.code.length == 0) _fail(string.concat(who, " has no code"));
        IChainlinkProxy feed = IChainlinkProxy(t.feed);
        if (feed.decimals() != RH.FEED_DECIMALS) _fail(string.concat(who, ": decimals() is not 8"));
        string memory desc = feed.description();
        if (!_eq(desc, t.description)) {
            _fail(string.concat(who, ': description() is "', desc, '", expected "', t.description, '"'));
        }
        (uint80 id, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || answer >= 1e14 || updatedAt == 0 || id == 0) {
            _fail(string.concat(who, ": latestRoundData() is not a sane price"));
        }
        aggregator = feed.aggregator();

        string memory tok = string.concat(t.ticker, " Stock Token ", vm.toString(t.stockToken));
        if (t.stockToken.code.length == 0) _fail(string.concat(tok, " has no code"));
        string memory sym = IStockToken(t.stockToken).symbol();
        if (!_eq(sym, t.ticker)) _fail(string.concat(tok, ': symbol() is "', sym, '"'));
        if (IStockToken(t.stockToken).oraclePaused()) {
            console.log("NOTE:", t.ticker, "oraclePaused() is true right now (corporate action); markets wait for it");
        }
        console.log(
            string.concat(
                "  ok ",
                t.ticker,
                ' "',
                desc,
                '" answer ',
                vm.toString(answer),
                " updatedAt ",
                vm.toString(updatedAt),
                " aggregator ",
                vm.toString(aggregator)
            )
        );
    }

    /// @dev The JSON must describe the chain and the venue exactly as the script and the
    ///      contracts do, so the keeper and the web never read a different world.
    function _checkJson(Config memory c, string memory json, RH.Ticker[4] memory t) internal view {
        if (vm.parseJsonUint(json, ".chainId") != RH.CHAIN_ID) _fail("deployment JSON chainId is not 4663");
        if (vm.parseJsonAddress(json, ".usdg") != RH.USDG) _fail("deployment JSON usdg is not the canonical USDG");
        if (vm.parseJsonAddress(json, ".multicall3") != RH.MULTICALL3) _fail("deployment JSON multicall3 differs");
        if (keccak256(bytes(c.out)) == keccak256(bytes(c.template))) {
            string memory status = vm.parseJsonString(json, ".status");
            if (!_eq(status, "not-deployed")) {
                _fail(
                    string.concat(
                        c.out,
                        ' says status "',
                        status,
                        '": refusing to overwrite a deployment (set DEPLOYMENTS_OUT to write elsewhere)'
                    )
                );
            }
        }
        if (vm.keyExistsJson(json, string.concat(".feeds[", vm.toString(t.length), "]"))) {
            _fail("deployment JSON lists a feed this script does not pin (script/RH.sol)");
        }
        for (uint256 i = 0; i < t.length; i++) {
            string memory k = string.concat(".feeds[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) _fail(string.concat("deployment JSON misses feed ", t[i].ticker));
            if (!_eq(vm.parseJsonString(json, string.concat(k, ".ticker")), t[i].ticker)) {
                _fail(
                    string.concat("deployment JSON ", k, " is not ", t[i].ticker, " (keep the order of script/RH.sol)")
                );
            }
            if (vm.parseJsonAddress(json, string.concat(k, ".feed")) != t[i].feed) {
                _fail(string.concat("deployment JSON ", t[i].ticker, " feed differs from script/RH.sol"));
            }
            if (vm.parseJsonAddress(json, string.concat(k, ".stockToken")) != t[i].stockToken) {
                _fail(string.concat("deployment JSON ", t[i].ticker, " stockToken differs from script/RH.sol"));
            }
            if (
                vm.parseJsonUint(json, string.concat(k, ".maxStrikeAge")) != RH.MAX_AGE
                    || vm.parseJsonUint(json, string.concat(k, ".maxFinalAge")) != RH.MAX_AGE
            ) {
                _fail(string.concat("deployment JSON ", t[i].ticker, " bounds are not 93600 s"));
            }
        }
    }

    // ================================================================== postflight

    /// @dev Read back everything the run set, in the simulation, before anything is written.
    function _postflight(Config memory c, Deployed memory d, string memory json) internal view {
        HunchMarketFactory f = d.factory;
        // the JSON's venue terms are what the factory hardcodes (the keeper and the web read the JSON)
        if (vm.parseJsonUint(json, ".params.kappa") != f.KAPPA()) _fail("JSON params.kappa differs from the factory");
        if (vm.parseJsonUint(json, ".params.feeBps") != f.FEE_BPS()) {
            _fail("JSON params.feeBps differs from the factory");
        }
        if (vm.parseJsonUint(json, ".params.voidTimeoutSec") != f.VOID_TIMEOUT()) {
            _fail("JSON params.voidTimeoutSec differs from the factory");
        }
        if (vm.parseJsonUint(json, ".params.seedPerLeg") < f.MIN_SEED_PER_LEG()) {
            _fail("JSON params.seedPerLeg < 1 USDG");
        }
        uint256 minEntry = vm.parseJsonUint(json, ".params.minEntry");
        uint256 maxEntry = vm.parseJsonUint(json, ".params.maxEntry");
        if (minEntry < f.MIN_ENTRY() || maxEntry == 0 || maxEntry < minEntry) {
            _fail("JSON params.minEntry / maxEntry would be refused by openUpDown (floor 1 USDG, non-zero cap)");
        }
        if (f.owner() != c.deployer || f.pendingOwner() != c.safe) _fail("factory ownership hand-over not started");
        if (address(f.settler()) != address(d.vpm) || address(f.resolver()) != address(d.resolver)) {
            _fail("factory wiring");
        }
        if (address(f.usdg()) != RH.USDG || f.treasury() != c.safe) _fail("factory USDG or treasury");
        if (d.vpm.guardian() != c.safe || d.vpm.treasury() != c.safe) _fail("settler guardian or treasury");
        if (!f.openers(c.keeper)) _fail("keeper is not an opener");
        RH.Ticker[4] memory t = RH.tickers();
        if (f.feedCount() != t.length) _fail("factory feed count");
        for (uint256 i = 0; i < t.length; i++) {
            (address stockToken, uint32 strikeAge, uint32 finalAge, bool allowed, string memory ticker) =
                f.feeds(t[i].feed);
            if (
                !allowed || stockToken != t[i].stockToken || strikeAge != RH.MAX_AGE || finalAge != RH.MAX_AGE
                    || !_eq(ticker, t[i].ticker) || f.feedAt(i) != t[i].feed
            ) _fail(string.concat("factory feed config for ", t[i].ticker));
        }
    }

    // ================================================================== deployment JSON

    function _write(Config memory c, string memory json, Deployed memory d, address[4] memory aggregators) internal {
        // a rehearsal (DEPLOYMENTS_OUT elsewhere) starts from a fresh copy of the template
        // forge-lint: disable-next-line(unsafe-cheatcode)
        if (keccak256(bytes(c.out)) != keccak256(bytes(c.template))) vm.writeFile(c.out, json);
        vm.writeJson('"deployed"', c.out, ".status");
        vm.writeJson("null", c.out, ".deployedAt");
        vm.writeJson(_gitCommit(c.gitCommit), c.out, ".gitCommit");
        vm.writeJson("null", c.out, ".startBlock");
        _writeContract(c.out, "StockRoundResolver", address(d.resolver));
        _writeContract(c.out, "HunchVPM", address(d.vpm));
        _writeContract(c.out, "HunchMarketFactory", address(d.factory));
        vm.writeJson(_quote(c.safe), c.out, ".safe");
        vm.writeJson(_quote(c.keeper), c.out, ".keeper");
        for (uint256 i = 0; i < aggregators.length; i++) {
            vm.writeJson(_quote(aggregators[i]), c.out, string.concat(".feeds[", vm.toString(i), "].aggregator"));
        }
    }

    function _writeContract(string memory out, string memory name, address a) internal {
        string memory k = string.concat(".contracts.", name);
        vm.writeJson(_quote(a), out, string.concat(k, ".address"));
        vm.writeJson("null", out, string.concat(k, ".deployTx"));
        vm.writeJson("null", out, string.concat(k, ".block"));
    }

    /// @dev "null" unless GIT_COMMIT is a hex commit, optionally with a "-dirty" suffix.
    function _gitCommit(string memory g) internal pure returns (string memory) {
        bytes memory b = bytes(g);
        if (b.length == 0) return "null";
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 x = b[i];
            bool ok = (x >= "0" && x <= "9") || (x >= "a" && x <= "z") || x == "-";
            if (!ok) _fail("GIT_COMMIT must look like a git commit (hex, optional -dirty)");
        }
        return string.concat('"', g, '"');
    }

    // ================================================================== output

    function _summary(Config memory c, Deployed memory d) internal pure {
        console.log("");
        console.log("Deployed on Robinhood Chain (4663):");
        console.log("  StockRoundResolver ", address(d.resolver));
        console.log("  HunchVPM           ", address(d.vpm));
        console.log("  HunchMarketFactory ", address(d.factory));
        console.log("  Safe (pending owner, guardian, treasury)", c.safe);
        console.log("  Keeper (opener)                         ", c.keeper);
        console.log("Wrote", c.out);
        console.log("Next: bash scripts/post-deploy.sh   (tx hashes, L2 blocks, time, git commit; then pnpm wire)");
        console.log("Then: bash scripts/verify-contracts.sh, and acceptOwnership() from the Safe (step 8)");
    }

    // ================================================================== helpers

    function _quote(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _fail(string memory why) internal pure {
        revert(string.concat("DeployRH: ", why));
    }
}
