// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ChainlinkCreOracle, IReceiver, IERC165} from "../src/oracles/ChainlinkCreOracle.sol";
import {ChainlinkFeedOracle} from "../src/oracles/ChainlinkFeedOracle.sol";
import {FeedResolver} from "../src/FeedResolver.sol";
import {VestedParimutuel, IERC20} from "../src/VestedParimutuel.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {IParimutuelSettler} from "../src/interfaces/IParimutuelSettler.sol";
import {FakeAggregator} from "./Oracles.t.sol";

/// @notice The relay adapter is the one oracle here that anybody can try to write to, so most
///         of these tests are about who may. The rest pin the same shape every adapter owes the
///         resolver — 8 decimals and the second the SOURCE feed wrote it — and then settle a
///         real market through it end to end.
contract ChainlinkCreOracleTest is Test {
    ChainlinkCreOracle internal oracle;

    address internal forwarder = address(0xF0F0);
    address internal owner = address(0x0DD);
    address internal author = address(0xA17);
    bytes32 internal constant WORKFLOW = keccak256("hunch-price-relay");
    bytes32 internal constant ETH_USD = keccak256("ETH / USD");
    bytes32 internal constant BTC_USD = keccak256("BTC / USD");

    function setUp() public {
        vm.warp(1_789_000_000);
        oracle = new ChainlinkCreOracle(forwarder, owner);
        vm.prank(owner);
        oracle.setExpectedAuthor(author);
    }

    // ------------------------------------------------------------- helpers

    /// @dev What the production KeystoneForwarder passes: 62 bytes of identity and the two-byte report id.
    function _metadata(bytes32 workflowId, address workflowOwner) internal pure returns (bytes memory) {
        return abi.encodePacked(workflowId, bytes10("relay"), workflowOwner, bytes2(0x0001));
    }

    function _one(bytes32 key, int256 answer, uint8 decimals, uint64 at)
        internal
        pure
        returns (ChainlinkCreOracle.Update[] memory updates)
    {
        updates = new ChainlinkCreOracle.Update[](1);
        updates[0] = ChainlinkCreOracle.Update({feedKey: key, answer: answer, decimals: decimals, updatedAt: at});
    }

    function _deliver(ChainlinkCreOracle.Update[] memory updates) internal {
        vm.prank(forwarder);
        oracle.onReport(_metadata(WORKFLOW, author), abi.encode(updates));
    }

    // ------------------------------------------------------------- who may write

    function test_ConstructionRefusesTheZeroForwarder() public {
        vm.expectRevert(ChainlinkCreOracle.BadForwarder.selector);
        new ChainlinkCreOracle(address(0), owner);
    }

    function test_AdvertisesTheReceiverInterfaceTheForwarderChecks() public view {
        assertTrue(oracle.supportsInterface(type(IReceiver).interfaceId), "IReceiver");
        assertTrue(oracle.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(oracle.supportsInterface(0xdeadbeef), "nothing else");
    }

    function test_OnlyTheForwarderMayDeliver() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(ChainlinkCreOracle.InvalidSender.selector, address(0xBAD)));
        oracle.onReport(_metadata(WORKFLOW, author), abi.encode(_one(ETH_USD, 1, 8, 1)));
    }

    function test_AFreshDeploymentAcceptsNothingUntilAWorkflowIsNamed() public {
        // Otherwise any workflow owner on the DON could target this address and write a price.
        ChainlinkCreOracle fresh = new ChainlinkCreOracle(forwarder, owner);
        vm.prank(forwarder);
        vm.expectRevert(ChainlinkCreOracle.NotConfigured.selector);
        fresh.onReport(_metadata(WORKFLOW, author), abi.encode(_one(ETH_USD, 1, 8, 1)));
    }

    function test_AReportFromAnotherWorkflowOwnerIsRefused() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkCreOracle.InvalidAuthor.selector, address(0xE1E), author));
        oracle.onReport(_metadata(WORKFLOW, address(0xE1E)), abi.encode(_one(ETH_USD, 1, 8, 1)));
    }

    function test_AWorkflowIdCheckRefusesEveryOtherWorkflow() public {
        vm.prank(owner);
        oracle.setExpectedWorkflowId(WORKFLOW);

        bytes32 other = keccak256("other");
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ChainlinkCreOracle.InvalidWorkflowId.selector, other, WORKFLOW));
        oracle.onReport(_metadata(other, author), abi.encode(_one(ETH_USD, 1, 8, 1)));
    }

    function test_AWorkflowIdAloneIsEnoughConfiguration() public {
        ChainlinkCreOracle byId = new ChainlinkCreOracle(forwarder, owner);
        vm.prank(owner);
        byId.setExpectedWorkflowId(WORKFLOW);

        vm.prank(forwarder);
        byId.onReport(_metadata(WORKFLOW, address(0x1234)), abi.encode(_one(ETH_USD, 2_520_54000000, 8, 1_789_000_000)));
        (int256 price,) = byId.read(ETH_USD);
        assertEq(price, 2_520_54000000);
    }

    function test_TruncatedMetadataIsRefused() public {
        vm.prank(forwarder);
        vm.expectRevert(ChainlinkCreOracle.BadMetadata.selector);
        oracle.onReport(abi.encodePacked(WORKFLOW, bytes10("relay")), abi.encode(_one(ETH_USD, 1, 8, 1)));
    }

    function test_SixtyTwoBytesOfMetadataAreAlsoAccepted() public {
        // Alternate tooling passes exactly the packed identity without the report id.
        vm.prank(forwarder);
        oracle.onReport(
            abi.encodePacked(WORKFLOW, bytes10("relay"), author), abi.encode(_one(ETH_USD, 7, 8, 1_789_000_000))
        );
        (int256 price,) = oracle.read(ETH_USD);
        assertEq(price, 7);
    }

    // ------------------------------------------------------------- what lands

    function test_ReadRevertsBeforeAnyPriceHasLanded() public {
        vm.expectRevert(ChainlinkCreOracle.NoValue.selector);
        oracle.read(ETH_USD);
    }

    function test_AnEightDecimalFeedPassesThroughWithItsSourceTimestamp() public {
        vm.expectEmit(address(oracle));
        emit ChainlinkCreOracle.PriceRelayed(ETH_USD, 2_520_54000000, 1_788_999_000);
        _deliver(_one(ETH_USD, 2_520_54000000, 8, 1_788_999_000));

        (int256 price, uint256 at) = oracle.read(ETH_USD);
        assertEq(price, 2_520_54000000, "no conversion at 8 decimals");
        assertEq(at, 1_788_999_000, "the source round's second, not the relay's");
    }

    function test_OtherDecimalsNormaliseToEight() public {
        ChainlinkCreOracle.Update[] memory updates = new ChainlinkCreOracle.Update[](2);
        updates[0] = ChainlinkCreOracle.Update(ETH_USD, 2_520_540000, 6, 1_789_000_000);
        updates[1] = ChainlinkCreOracle.Update(BTC_USD, 77_279e18, 18, 1_789_000_000);
        _deliver(updates);

        (int256 eth,) = oracle.read(ETH_USD);
        (int256 btc,) = oracle.read(BTC_USD);
        assertEq(eth, 2_520_54000000, "6 decimals scale up");
        assertEq(btc, 77_279_00000000, "18 decimals scale down");
    }

    function test_AnOlderOrRepeatedRoundIsIgnoredNotReverted() public {
        _deliver(_one(ETH_USD, 100, 8, 1_789_000_000));

        vm.expectEmit(address(oracle));
        emit ChainlinkCreOracle.UpdateIgnored(ETH_USD, 1_789_000_000, ChainlinkCreOracle.Ignored.NotNewer);
        _deliver(_one(ETH_USD, 999, 8, 1_789_000_000));

        _deliver(_one(ETH_USD, 999, 8, 1_788_000_000));
        (int256 price, uint256 at) = oracle.read(ETH_USD);
        assertEq(price, 100, "a replayed or reordered report cannot move the price back");
        assertEq(at, 1_789_000_000);
    }

    function test_OneBadEntryDoesNotStopTheRestOfTheReport() public {
        ChainlinkCreOracle.Update[] memory updates = new ChainlinkCreOracle.Update[](5);
        updates[0] = ChainlinkCreOracle.Update(keccak256("neg"), -1, 8, 1_789_000_000);
        updates[1] = ChainlinkCreOracle.Update(keccak256("zero-time"), 1, 8, 0);
        updates[2] = ChainlinkCreOracle.Update(keccak256("future"), 1, 8, uint64(block.timestamp + 301));
        updates[3] = ChainlinkCreOracle.Update(keccak256("decimals"), 1, 19, 1_789_000_000);
        updates[4] = ChainlinkCreOracle.Update(ETH_USD, 2_520_54000000, 8, uint64(block.timestamp + 300));
        _deliver(updates);

        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert(ChainlinkCreOracle.NoValue.selector);
            oracle.read(updates[i].feedKey);
        }
        (int256 price,) = oracle.read(ETH_USD);
        assertEq(price, 2_520_54000000, "the good entry landed, inside the clock-skew allowance");
    }

    // ------------------------------------------------------------- configuration

    function test_OnlyTheOwnerConfigures() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(ChainlinkCreOracle.NotOwner.selector);
        oracle.setForwarder(address(1));
        vm.expectRevert(ChainlinkCreOracle.NotOwner.selector);
        oracle.setExpectedAuthor(address(1));
        vm.expectRevert(ChainlinkCreOracle.NotOwner.selector);
        oracle.setExpectedWorkflowId(bytes32(uint256(1)));
        vm.expectRevert(ChainlinkCreOracle.NotOwner.selector);
        oracle.transferOwnership(address(1));
        vm.expectRevert(ChainlinkCreOracle.NotOwner.selector);
        oracle.lock();
        vm.stopPrank();
    }

    function test_TheForwarderCannotBeClearedToZero() public {
        vm.prank(owner);
        vm.expectRevert(ChainlinkCreOracle.BadForwarder.selector);
        oracle.setForwarder(address(0));
    }

    function test_LockFreezesEveryCheckForever() public {
        vm.startPrank(owner);
        oracle.lock();
        assertTrue(oracle.locked());

        vm.expectRevert(ChainlinkCreOracle.ConfigLocked.selector);
        oracle.setForwarder(address(0xBAD));
        vm.expectRevert(ChainlinkCreOracle.ConfigLocked.selector);
        oracle.setExpectedAuthor(address(0xBAD));
        vm.expectRevert(ChainlinkCreOracle.ConfigLocked.selector);
        oracle.setExpectedWorkflowId(bytes32(uint256(1)));
        vm.expectRevert(ChainlinkCreOracle.ConfigLocked.selector);
        oracle.lock();
        vm.stopPrank();

        _deliver(_one(ETH_USD, 5, 8, 1_789_000_000));
        (int256 price,) = oracle.read(ETH_USD);
        assertEq(price, 5, "a locked oracle still relays");
    }

    function test_LockIsRefusedWhileNothingIsConfigured() public {
        ChainlinkCreOracle fresh = new ChainlinkCreOracle(forwarder, owner);
        vm.prank(owner);
        vm.expectRevert(ChainlinkCreOracle.NotConfigured.selector);
        fresh.lock();
    }

    // ------------------------------------------------------------- same shape as the direct feed

    function testFuzz_RelayedAndDirectFeedsAgree(uint64 answer, uint32 at, uint8 decimals) public {
        vm.assume(answer > 0);
        // Anything past the clock-skew allowance is refused by design, tested above.
        at = uint32(bound(at, 1, block.timestamp + oracle.MAX_FUTURE_SKEW()));
        decimals = uint8(bound(decimals, 0, 18));

        FakeAggregator feed = new FakeAggregator(decimals, int256(uint256(answer)), at);
        (int256 directPrice, uint256 directAt) =
            IPriceOracle(address(new ChainlinkFeedOracle())).read(bytes32(uint256(uint160(address(feed)))));

        _deliver(_one(ETH_USD, int256(uint256(answer)), decimals, at));
        (int256 relayedPrice, uint256 relayedAt) = oracle.read(ETH_USD);

        assertEq(relayedPrice, directPrice, "same 8-decimal price as reading the feed directly");
        assertEq(relayedAt, directAt, "same second");
    }

    // ------------------------------------------------------------- end to end

    function test_ARelayedChainlinkPriceSettlesAMarket() public {
        VestedParimutuel vpm = new VestedParimutuel();
        MockERC20 token = new MockERC20();
        FeedResolver resolver = new FeedResolver();
        uint64 freeze = uint64(block.timestamp + 1 days);

        token.mint(address(this), 200e6);
        token.approve(address(vpm), type(uint256).max);
        uint256[] memory seed = new uint256[](2);
        seed[0] = 100e6;
        seed[1] = 100e6;
        uint256 marketId =
            vpm.create(IERC20(address(token)), seed, 30, freeze, 3 days, address(resolver), address(this));

        address staker = address(0x5747A);
        token.mint(staker, 50e6);
        vm.roll(block.number + 1);
        vm.startPrank(staker);
        token.approve(address(vpm), type(uint256).max);
        vpm.enter(marketId, 1, 50e6);
        vm.stopPrank();

        bytes32 specId = resolver.register(
            FeedResolver.Spec({
                settler: address(vpm),
                marketId: marketId,
                oracle: address(oracle),
                feedKey: ETH_USD,
                strike: 2_500_00000000,
                direction: 0,
                resolutionTime: freeze,
                maxStaleness: 90 minutes
            })
        );

        vm.warp(freeze + 10 minutes);
        // ETH / USD on the source chain last moved 40 minutes ago, at $2,480.
        _deliver(_one(ETH_USD, 2_480_00000000, 8, uint64(block.timestamp - 40 minutes)));

        (bool ready, uint8 winner,, uint256 age) = resolver.preview(specId);
        assertTrue(ready, "fresh enough for a 90 minute bound");
        assertEq(winner, 1, "below the strike");
        assertEq(age, 40 minutes, "age is measured from the source round");

        vm.prank(address(0xC0FFEE));
        resolver.resolve(specId);
        (,,,,,,, uint8 status, uint8 settledWinner,,,) = IParimutuelSettler(address(vpm)).getMarket(marketId);
        assertEq(status, uint8(IParimutuelSettler.Status.Resolved), "anyone settled it from the relayed price");
        assertEq(settledWinner, 1);
    }
}
