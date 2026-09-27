// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  RH: the Robinhood Chain (4663) facts the deploy kit and the fork suites pin
/// @notice Every value here was read on chain 4663 with `cast` (docs/spec/08-deployment.md and
///         04-markets-and-resolution.md hold the tables; deployments/robinhood-mainnet.json holds
///         the same addresses). DeployRH refuses to run unless the chain still answers the same,
///         and refuses a deployment JSON that disagrees with these constants.
library RH {
    uint256 internal constant CHAIN_ID = 4663;

    /// @notice Paxos USDG (UUPS proxy, 6 decimals, EIP-2612 + EIP-3009).
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @notice USDG's hardcoded EIP-712 domain: name "Global Dollar", version "1", chain 4663,
    ///         verifying contract = USDG. USDG has no `eip712Domain()`, so this is pinned.
    bytes32 internal constant USDG_DOMAIN_SEPARATOR =
        0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036;
    /// @notice keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    uint8 internal constant USDG_DECIMALS = 6;

    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    /// @notice Uniswap v3 USDG/WETH fee-100 pool, the deepest USDG holder: the fork suites and the
    ///         rehearsal fund test wallets from it (impersonated). Never used on mainnet.
    address internal constant USDG_WHALE = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;

    /// @notice The venue's staleness bound for every feed: 26 h (93,600 s).
    uint32 internal constant MAX_AGE = 93_600;
    /// @notice Chainlink equity feeds on 4663 answer with 8 decimals.
    uint8 internal constant FEED_DECIMALS = 8;
    /// @notice The deployer must hold at least this much ETH before it starts.
    uint256 internal constant MIN_DEPLOYER_ETH = 0.002 ether;

    /// @param ticker      the display ticker and the Stock Token's `symbol()`
    /// @param feed        the Chainlink AggregatorV3 standard proxy (not the SVR proxy)
    /// @param stockToken  the Robinhood Stock Token the feed prices
    /// @param description the feed's `description()`, read on chain 4663
    struct Ticker {
        string ticker;
        address feed;
        address stockToken;
        string description;
    }

    /// @notice The v1 tickers, in the order the factory allow-lists them.
    function tickers() internal pure returns (Ticker[4] memory t) {
        t[0] = Ticker({
            ticker: "NVDA",
            feed: 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
            stockToken: 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
            description: "RHNVDA / USD"
        });
        t[1] = Ticker({
            ticker: "TSLA",
            feed: 0x4A1166a659A55625345e9515b32adECea5547C38,
            stockToken: 0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
            description: "RHTSLA / USD"
        });
        t[2] = Ticker({
            ticker: "AAPL",
            feed: 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,
            stockToken: 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,
            description: "Robinhood AAPL / USD"
        });
        // description read on chain 4663 with `cast call <feed> "description()(string)"` on 2026-09-27
        t[3] = Ticker({
            ticker: "COIN",
            feed: 0xA3a468A452940B7D6b69991207B508c609a98Ef2,
            stockToken: 0x6330D8C3178a418788dF01a47479c0ce7CCF450b,
            description: "Robinhood COIN / USD"
        });
    }
}

/// @notice The read surface of a Chainlink proxy the deploy kit checks (plus `aggregator()`).
interface IChainlinkProxy {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function aggregator() external view returns (address);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice The part of USDG the deploy kit and the fork suites read.
interface IUSDG {
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    // forge-lint: disable-next-line(mixed-case-function)
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function isFrozen(address) external view returns (bool);
    function paused() external view returns (bool);
}

/// @notice The part of a Safe (v1.3+) DeployRH reads.
interface ISafeLike {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}
