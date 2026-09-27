// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HunchMarketFactory} from "../src/HunchMarketFactory.sol";
import {RH, IUSDG} from "./RH.sol";

/// @title  OpenUpDown: list one UP/DOWN market by hand, without the keeper
/// @notice For an allow-listed opener (normally the keeper's wallet) who wants to list a market
///         from the command line:
///
///           FEED=0x379E...9F15 STRIKE_TIME=1790688600 FINAL_TIME=1790712000 \
///           forge script contracts/script/OpenUpDown.s.sol:OpenUpDown --root contracts \
///             --rpc-url $RH_RPC_URL --account <opener keystore> --sender <OPENER> --broadcast
///
///         Env: FEED, STRIKE_TIME, FINAL_TIME (unix seconds: the opening bell the market starts
///         from and the closing bell it settles at, which is also when bets stop). Optional:
///         MAX_STRIKE_AGE / MAX_FINAL_AGE (seconds, 0 = the feed's allow-listed bound, default 0),
///         SEED_PER_LEG / MIN_ENTRY / MAX_ENTRY (USDG base units, default the JSON's `params`),
///         FACTORY (default the JSON's HunchMarketFactory), DEPLOYMENT_JSON (default
///         ../deployments/robinhood-mainnet.json, relative to contracts/).
///
///         Checks everything the factory would check, plus the opener's USDG, before sending
///         anything; approves exactly 2 · seed if the allowance is short; then opens the market
///         and prints its market id and resolution spec id. The opener pays both seed legs and
///         owns them (they come back when the market settles).
contract OpenUpDown is Script {
    string internal constant DEFAULT_JSON = "../deployments/robinhood-mainnet.json";

    function run() external returns (uint256 marketId, bytes32 specId) {
        address opener = msg.sender;
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(vm.envOr("DEPLOYMENT_JSON", string(DEFAULT_JSON)));
        HunchMarketFactory factory =
            HunchMarketFactory(vm.envOr("FACTORY", vm.parseJsonAddress(json, ".contracts.HunchMarketFactory.address")));
        HunchMarketFactory.UpDown memory p = HunchMarketFactory.UpDown({
            feed: vm.envAddress("FEED"),
            strikeTime: uint64(vm.envUint("STRIKE_TIME")),
            finalTime: uint64(vm.envUint("FINAL_TIME")),
            maxStrikeAge: uint32(vm.envOr("MAX_STRIKE_AGE", uint256(0))),
            maxFinalAge: uint32(vm.envOr("MAX_FINAL_AGE", uint256(0))),
            seedPerLeg: uint128(vm.envOr("SEED_PER_LEG", vm.parseJsonUint(json, ".params.seedPerLeg"))),
            minEntry: uint128(vm.envOr("MIN_ENTRY", vm.parseJsonUint(json, ".params.minEntry"))),
            maxEntry: uint128(vm.envOr("MAX_ENTRY", vm.parseJsonUint(json, ".params.maxEntry")))
        });

        string memory ticker = _preflight(factory, opener, p);
        uint256 total = 2 * uint256(p.seedPerLeg);
        IUSDG usdg = IUSDG(address(factory.usdg()));

        vm.startBroadcast(opener);
        if (usdg.allowance(opener, address(factory)) < total) usdg.approve(address(factory), total);
        (marketId, specId) = factory.openUpDown(p);
        vm.stopBroadcast();

        console.log(string.concat("Listed ", ticker, " UP/DOWN market ", vm.toString(marketId)));
        console.log("  spec id    ", vm.toString(specId));
        console.log("  strike time", p.strikeTime, " final time (bets stop)", p.finalTime);
        console.log("  seed per leg", p.seedPerLeg, " entries min/max", p.minEntry);
        console.log("                                  ", p.maxEntry);
        console.log("  listing index", factory.listingIndexOf(marketId) - 1);
    }

    function _preflight(HunchMarketFactory factory, address opener, HunchMarketFactory.UpDown memory p)
        internal
        view
        returns (string memory ticker)
    {
        if (block.chainid != RH.CHAIN_ID) _fail(string.concat("chain id is ", vm.toString(block.chainid)));
        if (opener == DEFAULT_SENDER) _fail("pass --sender <OPENER> with --account (or --private-key on anvil)");
        if (address(factory).code.length == 0) {
            _fail("no HunchMarketFactory at the JSON's address: deploy first, or set FACTORY");
        }
        if (!factory.openers(opener)) {
            _fail(string.concat(vm.toString(opener), " is not an opener (the Safe adds openers with setOpener)"));
        }
        (, uint32 strikeBound, uint32 finalBound, bool allowed, string memory t) = factory.feeds(p.feed);
        if (!allowed) _fail(string.concat("feed ", vm.toString(p.feed), " is not allow-listed"));
        ticker = t;
        if (block.timestamp >= p.finalTime) _fail("FINAL_TIME is not in the future");
        if (p.strikeTime >= p.finalTime) _fail("STRIKE_TIME must be before FINAL_TIME");
        if (p.finalTime - p.strikeTime > factory.MAX_WINDOW()) _fail("the window is longer than 8 days");
        if (p.seedPerLeg < factory.MIN_SEED_PER_LEG()) _fail("SEED_PER_LEG is below 1 USDG (1000000)");
        if (p.minEntry < factory.MIN_ENTRY() || p.maxEntry == 0) {
            _fail("every listed market needs MIN_ENTRY >= 1 USDG (1000000) and a non-zero MAX_ENTRY");
        }
        if (p.minEntry > p.maxEntry) _fail("MIN_ENTRY is above MAX_ENTRY");
        if (p.maxStrikeAge > strikeBound || p.maxFinalAge > finalBound) {
            _fail("an age bound is looser than the feed's allow-listed bound");
        }
        uint256 balance = IUSDG(address(factory.usdg())).balanceOf(opener);
        if (balance < 2 * uint256(p.seedPerLeg)) {
            _fail(
                string.concat("the opener holds ", vm.toString(balance), " USDG base units; it needs 2 x SEED_PER_LEG")
            );
        }
    }

    function _fail(string memory why) internal pure {
        revert(string.concat("OpenUpDown: ", why));
    }
}
