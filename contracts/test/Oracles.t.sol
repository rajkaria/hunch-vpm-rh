// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ChainlinkFeedOracle, AggregatorV3Interface} from "../src/oracles/ChainlinkFeedOracle.sol";
import {StorkOracle, IStork} from "../src/oracles/StorkOracle.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";

contract FakeAggregator is AggregatorV3Interface {
    uint8 internal d;
    int256 internal answer;
    uint256 internal at;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        d = decimals_;
        answer = answer_;
        at = updatedAt_;
    }

    function decimals() external view returns (uint8) {
        return d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, at, at, 1);
    }
}

contract FakeStork is IStork {
    mapping(bytes32 => TemporalNumericValue) internal v;

    function set(bytes32 id, uint64 timestampNs, int192 quantizedValue) external {
        v[id] = TemporalNumericValue({timestampNs: timestampNs, quantizedValue: quantizedValue});
    }

    function getTemporalNumericValueV1(bytes32 id) external view returns (TemporalNumericValue memory) {
        return v[id];
    }
}

/// @notice Every adapter has to answer the same question the same way: a price at 8
///         decimals and the second it was written. These tests pin that contract per
///         provider, including the decimal and unit conversions that are easy to get
///         backwards and impossible to notice until a market settles wrong.
contract OraclesTest is Test {
    bytes32 internal constant KEY = bytes32(uint256(uint160(address(0xFEED))));

    function test_ChainlinkPassesEightDecimalFeedsThrough() public {
        FakeAggregator feed = new FakeAggregator(8, 4_512_00000000, 1_757_000_000);
        ChainlinkFeedOracle oracle = new ChainlinkFeedOracle();
        (int256 price, uint256 at) = oracle.read(bytes32(uint256(uint160(address(feed)))));
        assertEq(price, 4_512_00000000, "an 8-decimal feed needs no conversion");
        assertEq(at, 1_757_000_000, "timestamp passes through");
    }

    function test_ChainlinkScalesUpFromFewerDecimals() public {
        FakeAggregator feed = new FakeAggregator(6, 4_512_000000, 1_757_000_000);
        ChainlinkFeedOracle oracle = new ChainlinkFeedOracle();
        (int256 price,) = oracle.read(bytes32(uint256(uint160(address(feed)))));
        assertEq(price, 4_512_00000000, "6 decimals scales up to 8");
    }

    function test_ChainlinkScalesDownFromMoreDecimals() public {
        FakeAggregator feed = new FakeAggregator(18, 4_512e18, 1_757_000_000);
        ChainlinkFeedOracle oracle = new ChainlinkFeedOracle();
        (int256 price,) = oracle.read(bytes32(uint256(uint160(address(feed)))));
        assertEq(price, 4_512_00000000, "18 decimals scales down to 8");
    }

    function test_ChainlinkRejectsAnUnwrittenRound() public {
        FakeAggregator feed = new FakeAggregator(8, 1, 0);
        ChainlinkFeedOracle oracle = new ChainlinkFeedOracle();
        vm.expectRevert(ChainlinkFeedOracle.StaleRound.selector);
        oracle.read(bytes32(uint256(uint160(address(feed)))));
    }

    function test_ChainlinkRejectsANonPositiveAnswer() public {
        FakeAggregator feed = new FakeAggregator(8, 0, 1_757_000_000);
        ChainlinkFeedOracle oracle = new ChainlinkFeedOracle();
        vm.expectRevert(ChainlinkFeedOracle.NegativeAnswer.selector);
        oracle.read(bytes32(uint256(uint160(address(feed)))));
    }

    function test_ChainlinkRejectsTheZeroAddress() public {
        ChainlinkFeedOracle oracle = new ChainlinkFeedOracle();
        vm.expectRevert(ChainlinkFeedOracle.BadFeed.selector);
        oracle.read(bytes32(0));
    }

    function test_StorkNormalisesEighteenDecimalsAndNanoseconds() public {
        FakeStork feed = new FakeStork();
        feed.set(KEY, 1_757_000_000_000_000_000, 4_512e18);
        StorkOracle oracle = new StorkOracle(IStork(address(feed)));

        (int256 price, uint256 at) = oracle.read(KEY);
        assertEq(price, 4_512_00000000, "18 decimals down to 8");
        assertEq(at, 1_757_000_000, "nanoseconds down to seconds");
    }

    function test_StorkRejectsAnUnwrittenValue() public {
        FakeStork feed = new FakeStork();
        StorkOracle oracle = new StorkOracle(IStork(address(feed)));
        vm.expectRevert(StorkOracle.NoValue.selector);
        oracle.read(KEY);
    }

    function test_MockAnswersWhateverItWasGiven() public {
        MockOracle oracle = new MockOracle();
        oracle.set(KEY, 1234, 99);
        (int256 price, uint256 at) = oracle.read(KEY);
        assertEq(price, 1234);
        assertEq(at, 99);
    }

    function testFuzz_EveryAdapterAnswersTheSameShape(uint64 answer, uint32 updatedAt) public {
        vm.assume(answer > 0 && updatedAt > 0);

        FakeAggregator chainlinkFeed = new FakeAggregator(8, int256(uint256(answer)), updatedAt);
        IPriceOracle chainlink = new ChainlinkFeedOracle();
        (int256 clPrice, uint256 clAt) = chainlink.read(bytes32(uint256(uint160(address(chainlinkFeed)))));

        FakeStork storkFeed = new FakeStork();
        storkFeed.set(KEY, uint64(updatedAt) * 1e9, int192(uint192(answer)) * int192(1e10));
        IPriceOracle stork = new StorkOracle(IStork(address(storkFeed)));
        (int256 stPrice, uint256 stAt) = stork.read(KEY);

        assertEq(clPrice, stPrice, "both adapters must land on the same 8-decimal price");
        assertEq(clAt, stAt, "both adapters must land on the same second");
    }
}
