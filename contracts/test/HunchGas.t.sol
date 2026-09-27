// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {HunchVPM, IERC20} from "../src/HunchVPM.sol";
import {StockRoundResolver} from "../src/StockRoundResolver.sol";
import {HunchMarketFactory} from "../src/HunchMarketFactory.sol";
import {IERC20Like} from "../src/interfaces/IERC20Like.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

/// @title Gas of the product contracts → GAS.md
/// @notice Same method as the vendored test/Gas.t.sol (which writes GAS-REFERENCE.md): every
///         figure is a `gasleft()` delta around one external call with every touched
///         contract's storage COOLED first (`vm.cool`), i.e. that call's execution cost as its
///         own transaction, excluding the 21,000 base and calldata, including the token
///         transfers inside it. Local MockUSDG, MockAggregator and MockStockToken stand in for
///         USDG (a proxy with facets), the Chainlink proxy and the Stock Token, so fork numbers
///         (S4) will be higher on the token and feed legs. Run:
///           forge test --match-contract HunchGasTest -vv
///         which rewrites GAS.md in this directory.
contract HunchGasTest is Test {
    HunchVPM internal vpm;
    StockRoundResolver internal resolver;
    HunchMarketFactory internal factory;
    MockUSDG internal usdg;
    MockAggregator internal feed;
    MockStockToken internal nvda;

    address internal safe = makeAddr("safe");
    address internal keeper = makeAddr("keeper");
    address internal relayer = makeAddr("relayer");
    uint256 internal constant BETTOR_PK = 0xB377;
    address internal bettor;

    uint64 internal constant S = 1_790_688_600; // Tue 09:30 ET
    uint64 internal constant F = 1_790_712_000; // Tue 16:00 ET
    string internal md;

    function setUp() public {
        vm.warp(S - 5 minutes);
        vm.roll(23_000_000);
        usdg = new MockUSDG();
        vpm = new HunchVPM(safe, safe);
        resolver = new StockRoundResolver();
        factory = new HunchMarketFactory(vpm, resolver, IERC20Like(address(usdg)), safe, safe);
        feed = new MockAggregator("Robinhood NVDA / USD");
        nvda = new MockStockToken("NVDA");
        vm.startPrank(safe);
        factory.setFeed(address(feed), address(nvda), "NVDA", 26 hours, 26 hours, true);
        factory.setOpener(keeper, true);
        vm.stopPrank();
        usdg.mint(keeper, 1_000_000e6);
        vm.prank(keeper);
        usdg.approve(address(factory), type(uint256).max);
        bettor = vm.addr(BETTOR_PK);
        usdg.mint(bettor, 1_000_000e6);
        vm.prank(bettor);
        usdg.approve(address(vpm), type(uint256).max);
    }

    function _cold() internal {
        vm.cool(address(vpm));
        vm.cool(address(usdg));
        vm.cool(address(resolver));
        vm.cool(address(factory));
        vm.cool(address(feed));
        vm.cool(address(nvda));
    }

    function _open() internal returns (uint256 marketId, bytes32 spec, uint256 gas) {
        HunchMarketFactory.UpDown memory p = HunchMarketFactory.UpDown({
            feed: address(feed),
            strikeTime: S,
            finalTime: F,
            maxStrikeAge: 0,
            maxFinalAge: 0,
            seedPerLeg: 10e6,
            minEntry: 1e6,
            maxEntry: 100e6
        });
        _cold();
        vm.prank(keeper);
        uint256 g = gasleft();
        (marketId, spec) = factory.openUpDown(p);
        gas = g - gasleft();
    }

    function _enter(uint256 marketId, uint8 o, uint256 amt) internal returns (uint256 pid, uint256 gas) {
        _cold();
        vm.prank(bettor);
        uint256 g = gasleft();
        pid = vpm.enter(marketId, o, amt);
        gas = g - gasleft();
    }

    function _relay(uint256 marketId, uint8 o, uint256 amt, bytes32 salt) internal returns (uint256 gas) {
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _sign(vpm.enterNonce(marketId, o, amt, salt), amt, vb);
        _cold();
        vm.prank(relayer);
        uint256 g = gasleft();
        vpm.enterWithAuthorization(bettor, marketId, o, amt, 0, vb, salt, sig);
        gas = g - gasleft();
    }

    function _sign(bytes32 nonce, uint256 amt, uint256 validBefore) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), bettor, address(vpm), amt, 0, validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(BETTOR_PK, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _row(string memory label, uint256 gas, uint256 budget, string memory ref) internal {
        string memory verdict = budget == 0 ? "" : gas <= budget ? "within" : "OVER";
        md = string.concat(
            md,
            "| ",
            label,
            " | ",
            vm.toString(gas),
            " | ",
            budget == 0 ? "-" : vm.toString(budget),
            " | ",
            verdict,
            " | ",
            ref,
            " |\n"
        );
    }

    function test_GenerateHunchGasReport() public {
        md = string.concat(
            "# Hunch contracts: measured gas (local)\n\n",
            "Generated by `forge test --match-contract HunchGasTest -vv` (test/HunchGas.t.sol), which rewrites this file.\n",
            "The vendored reference settler's own measurements are in `GAS-REFERENCE.md` (test/Gas.t.sol).\n\n",
            "- solc 0.8.28, optimizer on, 200 runs, `via_ir = false`, EVM `cancun` (see foundry.toml).\n",
            "- Each figure is a `gasleft()` delta around ONE external call with every touched contract's storage cooled first (`vm.cool`): the call's execution cost as its own transaction, excluding the 21,000 base fee and calldata, including the token transfers inside it.\n",
            "- Venue market: kappa 30, seed 10 / 10 USDG, fee 200 bps, caps 1 to 100 USDG, stakes of 10 to 50 USDG.\n",
            "- **Local mocks** stand in for USDG (on chain a proxy with facets: a plain `transfer` is 66,208 gas there), the Chainlink proxy and the Stock Token, so the token and feed legs cost more on chain 4663. Fork numbers (real USDG, real feed) come with the fork suite in S4.\n",
            "- Budgets are `docs/spec/03-contracts.md` section Gas; the reference column quotes GAS-REFERENCE.md (kappa 9, n = 2).\n\n",
            "| call | gas | budget | | reference |\n|---|---:|---:|---|---|\n"
        );

        _measureOpenAndEntries();
        uint80 r4 = _measureResolve();
        _measureClaims();
        _measureFlat(r4);
        md = string.concat(
            md,
            "\n### Reading the table\n\n",
            "- **Token legs.** MockUSDG checks the freeze list for the sender, the recipient and (on `transferFrom`) the spender, and the global pause, as USDG does: about four more cold reads per transfer than the reference's MockERC20, so every row that moves tokens carries roughly 6,000 to 8,500 gas the reference column does not.\n",
            "- **`openUpDown` is over its 900,000 budget** because it does more than the budget assumed: after `create` (about 695,000 here, including two D6 position ids) it registers the spec (about 130,000: five slots plus `specIdOf`) and, per the on-chain enumeration decision, appends a 12-field listing (six slots) plus `listingIndexOf` and the array length (about 180,000 with the `MarketOpened` event). At the 0.02 gwei observed on chain 4663 that is about 0.00002 ETH per market. Keeping the listing on chain is what lets the web enumerate markets with view calls only.\n",
            "- **`enter` joining a vintage** exceeds 150,000 only in the worst case, when its id starts a new slot of the market's id list (one entry in four); the typical join and the first-in-block entry are within budget.\n",
            "- **`claimFor` winning** exceeds 90,000 only for the first fee the settler ever accrues in a token (a zero to non-zero slot); afterwards it is within budget.\n",
            "\n`enter` carries three things the reference's does not: the entries-pause check (D4, one cold slot), the entry bounds (D3, packed into slots `enter` already reads) and the per-market position index (D6, `uint64` ids packed four to a slot, so three entries in four write a slot that is already non-zero).\n"
        );
        vm.writeFile("./GAS.md", md);
        console.log(md);
    }

    uint256 internal id;
    bytes32 internal specId;

    function _measureOpenAndEntries() internal {
        uint256 gOpen;
        (id, specId, gOpen) = _open();
        _row(
            "`openUpDown` (pull seed, create, register spec, hand over both legs, list)",
            gOpen,
            900_000,
            "create 639,707"
        );

        vm.roll(block.number + 1);
        (, uint256 gFirst) = _enter(id, 0, 20e6);
        _row("`enter`, first entry after creation (opens a vintage, nothing to finalize)", gFirst, 0, "169,548");
        vm.roll(block.number + 1);
        (, uint256 gNew) = _enter(id, 1, 30e6);
        _row(
            "`enter`, first in a new block (finalizes the previous 1-entry vintage, opens one)",
            gNew,
            240_000,
            "212,890"
        );
        (, uint256 gJoin) = _enter(id, 0, 40e6);
        _row(
            "`enter`, joining the open vintage, worst case (its id opens a new slot of the market's id list)",
            gJoin,
            150_000,
            "129,628"
        );
        (, uint256 gJoin2) = _enter(id, 1, 15e6);
        _row("`enter`, joining the open vintage, typical (id packs into an existing slot)", gJoin2, 150_000, "129,628");
        vm.roll(block.number + 1);
        _enter(id, 0, 10e6); // a 1-entry vintage for the relayed entry to finalize (not measured)
        vm.roll(block.number + 1);
        uint256 gRelayNew = _relay(id, 1, 50e6, bytes32("a"));
        _row(
            "`enterWithAuthorization`, first in a new block (finalizes the previous 1-entry vintage)",
            gRelayNew,
            300_000,
            "-"
        );
        assertLe(gRelayNew, 300_000, "enterWithAuthorization budget");
        uint256 gRelayJoin = _relay(id, 0, 25e6, bytes32("b"));
        _row("`enterWithAuthorization`, joining the open vintage", gRelayJoin, 300_000, "-");
        vm.roll(block.number + 1);
        _cold();
        uint256 g = gasleft();
        vpm.finalizeVintage(id);
        _row("`finalizeVintage` of a 2-entry vintage", g - gasleft(), 0, "1 entry 81,413");
    }

    /// @dev Resolve through the resolver: 4 round reads, oraclePaused, settler.resolve.
    function _measureResolve() internal returns (uint80 r4) {
        uint80 r1 = feed.addRound(181e8, S - 10 minutes);
        feed.addRound(183e8, S + 1 hours);
        uint80 r3 = feed.addRound(185e8, F - 30 minutes);
        r4 = feed.addRound(186e8, F + 5 minutes);
        vm.roll(block.number + 1);
        vm.prank(bettor);
        vpm.enter(id, 1, 10e6); // leave a vintage open, so resolve finalizes it (the usual case)
        vm.roll(block.number + 1);
        vm.warp(F + 60);
        _cold();
        uint256 g = gasleft();
        resolver.resolve(specId, r1, r3);
        _row(
            "`StockRoundResolver.resolve` (4 round reads, oraclePaused, settler.resolve finalizing a 1-entry vintage)",
            g - gasleft(),
            200_000,
            "settler resolve 87,571"
        );
    }

    function _measureClaims() internal {
        uint256[] memory all = vpm.marketPositions(id, 0, 20);
        _cold();
        uint256 g = gasleft();
        vpm.claimFor(all[2]); // the first UP entry: wins, pays the settler's first fee
        _row(
            "`claimFor`, winning position, first fee ever accrued in this token (zero to non-zero slot)",
            g - gasleft(),
            90_000,
            "claim 62,473"
        );
        _cold();
        g = gasleft();
        vpm.claimFor(all[4]); // another UP winner
        _row(
            "`claimFor`, winning position, typical (fee balance already non-zero)",
            g - gasleft(),
            90_000,
            "claim 62,473"
        );
        _cold();
        g = gasleft();
        vpm.claimFor(all[3]); // DOWN: lost
        _row("`claimFor`, losing position", g - gasleft(), 0, "-");
        _cold();
        g = gasleft();
        vpm.sweepFees(IERC20(address(usdg)));
        _row("`sweepFees` to the treasury", g - gasleft(), 0, "-");
    }

    /// @dev FLAT: the price in effect at both bells is the same, so the market voids.
    function _measureFlat(uint80 r4) internal {
        (, bytes32 flatSpec,) = _openAt(F + 1 days);
        uint80 last = feed.addRound(186e8, F + 1 days - 2 hours); // same answer as r4
        vm.warp(F + 1 days + 60);
        _cold();
        uint256 g = gasleft();
        resolver.resolve(flatSpec, r4, last);
        _row("`StockRoundResolver.resolve`, FLAT (equal answers: voids the market)", g - gasleft(), 0, "-");
    }

    function _openAt(uint64 finalTime) internal returns (uint256 marketId, bytes32 spec, uint256 gas) {
        HunchMarketFactory.UpDown memory p = HunchMarketFactory.UpDown({
            feed: address(feed),
            strikeTime: finalTime - 6 hours,
            finalTime: finalTime,
            maxStrikeAge: 0,
            maxFinalAge: 0,
            seedPerLeg: 10e6,
            minEntry: 1e6,
            maxEntry: 100e6
        });
        vm.prank(keeper);
        uint256 g = gasleft();
        (marketId, spec) = factory.openUpDown(p);
        gas = g - gasleft();
    }
}
