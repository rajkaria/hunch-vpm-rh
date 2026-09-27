// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice The interface Chainlink's `KeystoneForwarder` delivers verified CRE reports through.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title Chainlink Data Feeds relayed by a CRE workflow, behind IPriceOracle
/// @notice Chainlink publishes Data Feeds on Arc mainnet but not on Arc testnet. On testnet the
///         Chainlink-native way to get one on chain is the Chainlink Runtime Environment: a
///         workflow reads the Data Feed where it lives (Ethereum Sepolia), reaches consensus
///         across the DON, and the `KeystoneForwarder` on Arc delivers the signed report here.
///         On a chain that has the feed itself, use `ChainlinkFeedOracle` and skip the relay.
///
///         `feedKey` is `keccak256(bytes(description))` of the source feed — `"ETH / USD"` —
///         so a key names the Chainlink feed it came from and nothing else.
///
/// @dev    Trust, stated plainly. A report is accepted only from the configured forwarder and
///         only for a configured workflow owner and/or workflow id; with neither configured it
///         refuses everything, so a fresh deployment cannot be written by some other workflow
///         that happens to target it. Until `lock` is called the owner can re-point all of
///         that, so the owner is trusted until then; after it, only the forwarder's signature
///         check and the named workflow are.
///
///         `updatedAt` is the SOURCE feed's round timestamp, not the relay time: a relay that
///         runs every five minutes over a feed with a one-hour heartbeat still reports an age
///         of up to an hour, and that is the truth a market's `maxStaleness` should judge.
contract ChainlinkCreOracle is IPriceOracle, IReceiver {
    /// @notice One feed's latest round, as the workflow read it on the source chain.
    struct Update {
        bytes32 feedKey;
        int256 answer;
        uint8 decimals;
        uint64 updatedAt;
    }

    struct Reading {
        int256 price8;
        uint64 updatedAt;
    }

    /// @notice Why an entry in an otherwise accepted report was not applied.
    enum Ignored {
        NotNewer,
        NonPositive,
        FromTheFuture,
        BadDecimals
    }

    /// @notice How far past this chain's clock a source timestamp may sit. Chains disagree
    ///         about the second; a report minutes ahead of this block is not a clock skew.
    uint256 public constant MAX_FUTURE_SKEW = 300;

    address public owner;
    address public forwarder;
    address public expectedAuthor;
    bytes32 public expectedWorkflowId;
    bool public locked;

    mapping(bytes32 => Reading) internal readings;

    event PriceRelayed(bytes32 indexed feedKey, int256 price8, uint64 updatedAt);
    event UpdateIgnored(bytes32 indexed feedKey, uint64 updatedAt, Ignored reason);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ForwarderSet(address indexed forwarder);
    event ExpectedAuthorSet(address indexed author);
    event ExpectedWorkflowIdSet(bytes32 indexed workflowId);
    event Locked();

    error NotOwner();
    error ConfigLocked();
    error BadForwarder();
    error InvalidSender(address sender);
    error NotConfigured();
    error BadMetadata();
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error NoValue();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier unlocked() {
        if (locked) revert ConfigLocked();
        _;
    }

    constructor(address forwarder_, address owner_) {
        if (forwarder_ == address(0)) revert BadForwarder();
        forwarder = forwarder_;
        owner = owner_;
        emit ForwarderSet(forwarder_);
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ reports

    /// @inheritdoc IReceiver
    /// @dev Metadata is `abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address
    ///      workflowOwner)` — 62 bytes — and the production forwarder appends the two-byte
    ///      report id, so 64 arrive. Only the first 62 are read.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender);
        if (expectedAuthor == address(0) && expectedWorkflowId == bytes32(0)) revert NotConfigured();
        if (metadata.length < 62) revert BadMetadata();

        bytes32 workflowId = bytes32(metadata[0:32]);
        address workflowOwner = address(bytes20(metadata[42:62]));
        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }
        if (expectedAuthor != address(0) && workflowOwner != expectedAuthor) {
            revert InvalidAuthor(workflowOwner, expectedAuthor);
        }

        Update[] memory updates = abi.decode(report, (Update[]));
        for (uint256 i = 0; i < updates.length; i++) {
            _apply(updates[i]);
        }
    }

    /// @dev One bad entry is skipped, not reverted: a report carries several feeds, and one
    ///      of them being a round behind must not stop the others from landing.
    function _apply(Update memory u) internal {
        Ignored reason;
        if (u.decimals > 18) {
            reason = Ignored.BadDecimals;
        } else if (u.answer <= 0) {
            reason = Ignored.NonPositive;
        } else if (u.updatedAt <= readings[u.feedKey].updatedAt) {
            // Covers a zero timestamp too, and a replayed or reordered report.
            reason = Ignored.NotNewer;
        } else if (u.updatedAt > block.timestamp + MAX_FUTURE_SKEW) {
            reason = Ignored.FromTheFuture;
        } else {
            int256 price8 = _to8(u.answer, u.decimals);
            readings[u.feedKey] = Reading({price8: price8, updatedAt: u.updatedAt});
            emit PriceRelayed(u.feedKey, price8, u.updatedAt);
            return;
        }
        emit UpdateIgnored(u.feedKey, u.updatedAt, reason);
    }

    function _to8(int256 answer, uint8 decimals_) internal pure returns (int256) {
        if (decimals_ == 8) return answer;
        if (decimals_ < 8) return answer * int256(10 ** uint256(8 - decimals_));
        return answer / int256(10 ** uint256(decimals_ - 8));
    }

    // ------------------------------------------------------------------ reads

    /// @inheritdoc IPriceOracle
    function read(bytes32 feedKey) external view returns (int256 price8, uint256 updatedAt) {
        Reading memory r = readings[feedKey];
        if (r.updatedAt == 0) revert NoValue();
        return (r.price8, r.updatedAt);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ------------------------------------------------------------------ configuration

    function setForwarder(address forwarder_) external onlyOwner unlocked {
        if (forwarder_ == address(0)) revert BadForwarder();
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    /// @notice The CRE workflow owner whose reports are accepted. Zero disables the check.
    function setExpectedAuthor(address author) external onlyOwner unlocked {
        expectedAuthor = author;
        emit ExpectedAuthorSet(author);
    }

    /// @notice The one CRE workflow whose reports are accepted. Zero disables the check.
    function setExpectedWorkflowId(bytes32 workflowId) external onlyOwner unlocked {
        expectedWorkflowId = workflowId;
        emit ExpectedWorkflowIdSet(workflowId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Freeze the forwarder and the workflow checks forever. After this the owner can
    ///         change nothing that decides which prices land, so nobody has to trust the owner.
    ///         Refused while unconfigured, because a locked oracle that accepts nothing is a
    ///         bricked one.
    function lock() external onlyOwner unlocked {
        if (expectedAuthor == address(0) && expectedWorkflowId == bytes32(0)) revert NotConfigured();
        locked = true;
        emit Locked();
    }
}
