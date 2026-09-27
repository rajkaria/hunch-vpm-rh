// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HunchVPM, IERC20} from "./HunchVPM.sol";
import {StockRoundResolver} from "./StockRoundResolver.sol";
import {IERC20Like} from "./interfaces/IERC20Like.sol";

/// @title  HunchMarketFactory — list an UP/DOWN stock market in one transaction
/// @notice An allow-listed opener (the keeper's hot wallet) lists a market on an
///         allow-listed Chainlink feed: the factory pulls the opener's seed, creates the
///         market on HunchVPM with the venue's fixed terms (κ 30, fee 2% of gains, 72 h void
///         timeout, the treasury as residue owner), registers its resolution spec with the
///         StockRoundResolver in the same transaction (so no stake can land against rules
///         nobody committed to), hands both seed legs to the opener, and keeps nothing.
///
///         The owner (the Safe, two-step transfer) allow-lists feeds with their Stock Token and
///         staleness bounds, and adds or removes openers. Neither the owner nor an opener can
///         change a listed market: its feed, times, bounds, seed, fee and caps are fixed in
///         HunchVPM and in the resolver's spec the moment it is opened.
/// @dev    The factory is HunchVPM's `msg.sender` during `create`, so it owns the seed legs
///         for the length of the call; it transfers both to the opener, zeroes its allowance
///         and returns any refused seed before returning, so it ends every call holding no
///         tokens and no positions (asserted in the tests). `listings` lets a web client
///         enumerate every market with view calls only.
contract HunchMarketFactory {
    // ------------------------------------------------------------------ types

    /// @param stockToken   the Robinhood Stock Token the feed prices (for `oraclePaused()`)
    /// @param maxStrikeAge the loosest strike staleness bound a market on this feed may use
    /// @param maxFinalAge  the loosest final staleness bound a market on this feed may use
    /// @param allowed      whether openers may list markets on this feed
    /// @param ticker       display ticker, e.g. "NVDA"
    struct FeedConfig {
        address stockToken;
        uint32 maxStrikeAge;
        uint32 maxFinalAge;
        bool allowed;
        string ticker;
    }

    /// @param feed         an allow-listed Chainlink proxy
    /// @param strikeTime   the opening bell the market starts from (unix seconds)
    /// @param finalTime    the closing bell it settles at, which is also its freeze
    /// @param maxStrikeAge 0 = the feed's bound; otherwise at most the feed's bound
    /// @param maxFinalAge  0 = the feed's bound; otherwise at most the feed's bound
    /// @param seedPerLeg   USDG the opener stakes on each side (at least 1 USDG)
    /// @param minEntry     smallest entry, USDG base units (0 = no bound)
    /// @param maxEntry     largest entry, USDG base units (0 = no bound)
    struct UpDown {
        address feed;
        uint64 strikeTime;
        uint64 finalTime;
        uint32 maxStrikeAge;
        uint32 maxFinalAge;
        uint128 seedPerLeg;
        uint128 minEntry;
        uint128 maxEntry;
    }

    /// @notice One listed market, readable without logs.
    struct Listing {
        uint256 marketId;
        bytes32 specId;
        address feed;
        uint64 strikeTime;
        uint64 finalTime;
        uint32 maxStrikeAge;
        uint32 maxFinalAge;
        uint128 seedPerLeg;
        uint128 minEntry;
        uint128 maxEntry;
        address opener;
        uint64 openedAt;
    }

    // ------------------------------------------------------------------ constants

    /// @notice The venue's market terms, fixed in code.
    uint256 public constant KAPPA = 30;
    uint16 public constant FEE_BPS = 200;
    uint64 public constant VOID_TIMEOUT = 72 hours;
    uint256 public constant MAX_WINDOW = 8 days;
    uint128 public constant MIN_SEED_PER_LEG = 1e6;

    // ------------------------------------------------------------------ immutables

    // lower-case names: they are the frozen ABI getters settler(), resolver(), usdg(), treasury()
    // forge-lint: disable-start(screaming-snake-case-immutable)
    HunchVPM public immutable settler;
    StockRoundResolver public immutable resolver;
    IERC20Like public immutable usdg;
    /// @notice Residue owner of every market this factory opens (the Safe).
    address public immutable treasury;
    // forge-lint: disable-end(screaming-snake-case-immutable)

    // ------------------------------------------------------------------ state

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public openers;
    mapping(address => FeedConfig) public feeds;
    address[] internal feedList;
    mapping(address => bool) internal feedListed;
    Listing[] public listings;
    /// @notice Index + 1 of a market's listing; 0 if this factory did not open it.
    mapping(uint256 => uint256) public listingIndexOf;

    // ------------------------------------------------------------------ events

    event MarketOpened(
        uint256 indexed marketId,
        bytes32 indexed specId,
        address indexed feed,
        string ticker,
        uint64 strikeTime,
        uint64 finalTime,
        uint128 seedPerLeg,
        uint128 minEntry,
        uint128 maxEntry
    );
    event FeedSet(
        address indexed feed,
        address indexed stockToken,
        string ticker,
        uint32 maxStrikeAge,
        uint32 maxFinalAge,
        bool allowed
    );
    event OpenerSet(address indexed opener, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error NotOwner();
    error NotPendingOwner();
    error NotOpener();
    error FeedNotAllowed();
    error BadFeedConfig();
    error BadTimes();
    error WindowTooLong();
    error SeedTooSmall();
    error BoundTooLoose();
    error TransferFailed();
    error ApprovalFailed();

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    modifier onlyOpener() {
        _checkOpener();
        _;
    }

    // ================================================================== setup

    /// @param settler_  the HunchVPM markets are created on
    /// @param resolver_ the StockRoundResolver every market names as its resolver
    /// @param usdg_     the settlement token (USDG)
    /// @param owner_    the Safe: manages feeds and openers, nothing else
    /// @param treasury_ residue owner of every market (the Safe)
    constructor(HunchVPM settler_, StockRoundResolver resolver_, IERC20Like usdg_, address owner_, address treasury_) {
        if (
            address(settler_) == address(0) || address(resolver_) == address(0) || address(usdg_) == address(0)
                || owner_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        settler = settler_;
        resolver = resolver_;
        usdg = usdg_;
        owner = owner_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ================================================================== owner

    /// @notice Allow-list (or delist) a feed with its Stock Token, ticker and the loosest
    ///         staleness bounds markets on it may use. Owner only. It never touches a market
    ///         already opened: each market's feed, token and bounds live in its immutable spec.
    function setFeed(
        address feed,
        address stockToken,
        string calldata ticker,
        uint32 maxStrikeAge,
        uint32 maxFinalAge,
        bool allowed
    ) external onlyOwner {
        if (feed == address(0)) revert ZeroAddress();
        if (allowed && (stockToken == address(0) || maxStrikeAge == 0 || maxFinalAge == 0 || bytes(ticker).length == 0))
        {
            revert BadFeedConfig();
        }
        feeds[feed] = FeedConfig({
            stockToken: stockToken,
            maxStrikeAge: maxStrikeAge,
            maxFinalAge: maxFinalAge,
            allowed: allowed,
            ticker: ticker
        });
        if (!feedListed[feed]) {
            feedListed[feed] = true;
            feedList.push(feed);
        }
        emit FeedSet(feed, stockToken, ticker, maxStrikeAge, maxFinalAge, allowed);
    }

    /// @notice Add or remove an opener. Owner only. An opener can list new markets (paying the
    ///         seed itself) and can never change or close an existing one.
    function setOpener(address opener, bool allowed) external onlyOwner {
        if (opener == address(0)) revert ZeroAddress();
        openers[opener] = allowed;
        emit OpenerSet(opener, allowed);
    }

    /// @notice Start a two-step ownership transfer. Owner only; `newOwner` must accept.
    ///         Passing the zero address cancels a pending transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete a transfer. Only the pending owner may call it.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ================================================================== opening a market

    /// @notice List one UP/DOWN market. Only an allow-listed opener may call it; the opener
    ///         pays `2 · seedPerLeg` USDG (it must have approved this factory) and receives
    ///         both seed legs. Checks: feed allow-listed; now < finalTime; strikeTime <
    ///         finalTime; finalTime − strikeTime ≤ 8 days; seedPerLeg ≥ 1 USDG; each age bound
    ///         0 (the feed's) or no looser than the feed's. It can never change an existing
    ///         market, and the factory keeps no tokens or positions afterwards.
    /// @return marketId the HunchVPM market
    /// @return specId   its StockRoundResolver spec
    function openUpDown(UpDown calldata p) external onlyOpener returns (uint256 marketId, bytes32 specId) {
        FeedConfig storage f = feeds[p.feed];
        if (!f.allowed) revert FeedNotAllowed();
        if (block.timestamp >= p.finalTime || p.strikeTime >= p.finalTime) revert BadTimes();
        if (p.finalTime - p.strikeTime > MAX_WINDOW) revert WindowTooLong();
        if (p.seedPerLeg < MIN_SEED_PER_LEG) revert SeedTooSmall();
        uint32 strikeAge = _tighten(p.maxStrikeAge, f.maxStrikeAge);
        uint32 finalAge = _tighten(p.maxFinalAge, f.maxFinalAge);

        uint256 firstSeed = settler.positionCount();
        marketId = _create(p);
        specId = resolver.register(
            StockRoundResolver.Spec({
                settler: address(settler),
                marketId: marketId,
                feed: p.feed,
                stockToken: f.stockToken,
                strikeTime: p.strikeTime,
                finalTime: p.finalTime,
                maxStrikeAge: strikeAge,
                maxFinalAge: finalAge
            })
        );
        _handOver(firstSeed);
        _list(p, marketId, specId, strikeAge, finalAge);
        emit MarketOpened(
            marketId, specId, p.feed, f.ticker, p.strikeTime, p.finalTime, p.seedPerLeg, p.minEntry, p.maxEntry
        );
    }

    // ================================================================== views

    /// @notice How many feeds have ever been configured (allowed or not); read `feeds(feedAt(i))`.
    function feedCount() external view returns (uint256) {
        return feedList.length;
    }

    /// @notice The i-th configured feed, in the order it was first set.
    function feedAt(uint256 i) external view returns (address) {
        return feedList[i];
    }

    /// @notice How many markets this factory has listed; read each with `listings(i)`.
    function listingCount() external view returns (uint256) {
        return listings.length;
    }

    // ================================================================== internals

    function _checkOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _checkOpener() internal view {
        if (!openers[msg.sender]) revert NotOpener();
    }

    /// @dev 0 means "the feed's bound"; anything else must be at least as strict.
    function _tighten(uint32 requested, uint32 allowed) internal pure returns (uint32) {
        if (requested == 0) return allowed;
        if (requested > allowed) revert BoundTooLoose();
        return requested;
    }

    /// @dev Pull 2 · seed from the opener and create the market with the venue's terms. The
    ///      settler pulls only the accepted seed (all of it, for a symmetric seed).
    function _create(UpDown calldata p) internal returns (uint256 marketId) {
        uint256 total = 2 * uint256(p.seedPerLeg);
        if (!usdg.transferFrom(msg.sender, address(this), total)) revert TransferFailed();
        if (!usdg.approve(address(settler), total)) revert ApprovalFailed();
        uint256[] memory seed = new uint256[](2);
        seed[0] = p.seedPerLeg;
        seed[1] = p.seedPerLeg;
        marketId = settler.create(
            IERC20(address(usdg)),
            seed,
            KAPPA,
            p.finalTime,
            VOID_TIMEOUT,
            address(resolver),
            treasury,
            FEE_BPS,
            p.minEntry,
            p.maxEntry
        );
    }

    /// @dev Give the opener both seed legs, drop the allowance, return anything left over
    ///      (the refused part of a clamped seed; nothing for a symmetric one).
    function _handOver(uint256 firstSeed) internal {
        settler.transferPosition(firstSeed, msg.sender);
        settler.transferPosition(firstSeed + 1, msg.sender);
        if (!usdg.approve(address(settler), 0)) revert ApprovalFailed();
        uint256 left = usdg.balanceOf(address(this));
        if (left > 0) {
            bool sent = usdg.transfer(msg.sender, left);
            if (!sent) revert TransferFailed();
        }
    }

    function _list(UpDown calldata p, uint256 marketId, bytes32 specId, uint32 strikeAge, uint32 finalAge) internal {
        listings.push(
            Listing({
                marketId: marketId,
                specId: specId,
                feed: p.feed,
                strikeTime: p.strikeTime,
                finalTime: p.finalTime,
                maxStrikeAge: strikeAge,
                maxFinalAge: finalAge,
                seedPerLeg: p.seedPerLeg,
                minEntry: p.minEntry,
                maxEntry: p.maxEntry,
                opener: msg.sender,
                openedAt: uint64(block.timestamp)
            })
        );
        listingIndexOf[marketId] = listings.length;
    }
}
