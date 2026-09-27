// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./VestedParimutuel.sol";
import {IParimutuelSettler} from "./interfaces/IParimutuelSettler.sol";

/// @title The classic pool, on-chain, behind the same interface as the vested one
/// @notice A port of the settlement rule Hunch runs in production today: the pool is every
///         stake, winning or losing, and each winner takes it in proportion to stake —
///         `floor(pool * stake_i / winningPrincipal)`. Nothing vests, nothing is rationed,
///         and a unit staked one second before the freeze is worth exactly as much as a unit
///         staked at open. That last property is the whole reason this contract exists: it
///         is the comparison card next to `VestedParimutuel`, not the venue's default.
/// @dev    `kappa` is accepted and stored so the two settlers share a creation signature,
///         but it is never read — a classic pool has no capacity to ration against, so
///         `headroom` is unbounded and every offer is accepted in full.
contract ClassicParimutuel is IParimutuelSettler {
    // ------------------------------------------------------------------ types

    struct Book {
        uint256 principal; // stake accepted on this outcome
        uint256 live; // unclaimed positions with principal > 0, the residue gate
    }

    struct Market {
        IERC20 token;
        address creator;
        address resolver;
        address residueOwner;
        uint64 resolutionTime;
        uint64 voidTimeout;
        uint8 n;
        Status status;
        uint8 winner;
        uint256 kappa; // recorded for interface parity; never read
        uint256 acceptedPool;
        uint256 paidOut;
        bool residueClaimed;
        uint256 distinctParticipants;
        Book[] books;
    }

    struct Position {
        uint64 marketId;
        address owner;
        uint8 outcome;
        bool claimed;
        uint128 offered; // always equal to `accepted`; kept for interface parity
        uint128 accepted;
    }

    // ------------------------------------------------------------------ state

    Market[] internal markets;
    Position[] internal positions;
    /// @dev market => participant => has staked, so a one-participant market can be voided.
    mapping(uint256 => mapping(address => bool)) internal seen;

    uint256 private locked = 1;

    // ------------------------------------------------------------------ events

    event MarketCreated(
        uint256 indexed marketId, address indexed creator, uint8 n, uint256 kappa, uint64 resolutionTime
    );
    event Entered(
        uint256 indexed marketId, uint256 indexed positionId, address indexed owner, uint8 outcome, uint256 offered
    );
    event Resolved(uint256 indexed marketId, uint8 winner);
    event Voided(uint256 indexed marketId);
    event Claimed(uint256 indexed positionId, address indexed to, uint256 payout, uint256 refund);
    event ResidueClaimed(uint256 indexed marketId, address indexed to, uint256 amount);
    event PositionTransferred(uint256 indexed positionId, address indexed from, address indexed to);

    // ------------------------------------------------------------------ errors

    error InvalidKappa();
    error InvalidSeed();
    error InvalidOutcomes();
    error BadResolutionTime();
    error Frozen();
    error NotOpen();
    error NotSettled();
    error NotResolver();
    error TooEarly();
    error NotOwner();
    error AlreadyClaimed();
    error NothingToRefund();
    error NotResidueOwner();
    error WinnersOutstanding();
    error TransferFailed();
    error Reentrancy();
    error AmountTooLarge();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    // ------------------------------------------------------------------ creation

    /// @inheritdoc IParimutuelSettler
    /// @dev Unlike the vested settler there is no Rule-2 clamp: every seed leg is accepted
    ///      in full. A zero leg still voids at creation, because a pool with an empty side
    ///      has no counterparty and the live product refuses it.
    function create(
        IERC20 token,
        uint256[] calldata seed,
        uint256 kappa,
        uint64 resolutionTime,
        uint64 voidTimeout,
        address resolver,
        address residueOwner
    ) external nonReentrant returns (uint256 marketId) {
        uint256 n = seed.length;
        if (n < 2 || n > 255) revert InvalidOutcomes();
        if (kappa < 1) revert InvalidKappa();
        if (resolutionTime <= block.timestamp) revert BadResolutionTime();

        marketId = markets.length;
        Market storage m = markets.push();
        m.token = token;
        m.creator = msg.sender;
        m.resolver = resolver;
        m.residueOwner = residueOwner;
        m.resolutionTime = resolutionTime;
        m.voidTimeout = voidTimeout;
        m.n = uint8(n);
        m.kappa = kappa;

        uint256 total;
        for (uint256 o = 0; o < n; o++) {
            uint256 amount = seed[o];
            if (amount == 0) revert InvalidSeed();
            if (amount > type(uint128).max) revert AmountTooLarge();
            m.books.push(Book({principal: amount, live: 1}));
            positions.push(
                Position({
                    marketId: uint64(marketId),
                    owner: msg.sender,
                    outcome: uint8(o),
                    claimed: false,
                    offered: uint128(amount),
                    accepted: uint128(amount)
                })
            );
            emit Entered(marketId, positions.length - 1, msg.sender, uint8(o), amount);
            total += amount;
        }

        m.acceptedPool = total;
        seen[marketId][msg.sender] = true;
        m.distinctParticipants = 1;
        emit MarketCreated(marketId, msg.sender, uint8(n), kappa, resolutionTime);

        _pull(token, msg.sender, total);
    }

    // ------------------------------------------------------------------ entry

    /// @inheritdoc IParimutuelSettler
    /// @dev Accepted in full, always. There is no capacity and no vintage: the classic
    ///      pool has no notion of when a stake arrived, which is exactly the property the
    ///      vested settler was written to remove.
    function enter(uint256 marketId, uint8 outcome, uint256 amount) external nonReentrant returns (uint256 positionId) {
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        if (block.timestamp >= m.resolutionTime) revert Frozen();
        if (outcome >= m.n) revert InvalidOutcomes();
        if (amount == 0) revert InvalidSeed();
        if (amount > type(uint128).max) revert AmountTooLarge();

        m.books[outcome].principal += amount;
        m.books[outcome].live += 1;
        m.acceptedPool += amount;

        if (!seen[marketId][msg.sender]) {
            seen[marketId][msg.sender] = true;
            m.distinctParticipants += 1;
        }

        positionId = positions.length;
        positions.push(
            Position({
                marketId: uint64(marketId),
                owner: msg.sender,
                outcome: outcome,
                claimed: false,
                offered: uint128(amount),
                accepted: uint128(amount)
            })
        );
        emit Entered(marketId, positionId, msg.sender, outcome, amount);

        _pull(m.token, msg.sender, amount);
    }

    // ------------------------------------------------------------------ resolution

    /// @inheritdoc IParimutuelSettler
    /// @dev A market only one address ever staked in cannot be settled against anyone, so
    ///      it voids and refunds — the same rule the live product applies.
    function resolve(uint256 marketId, uint8 winner) external {
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        if (msg.sender != m.resolver) revert NotResolver();
        if (block.timestamp < m.resolutionTime) revert TooEarly();
        if (winner >= m.n) revert InvalidOutcomes();

        if (m.distinctParticipants < 2 || m.books[winner].principal == 0) {
            m.status = Status.Voided;
            emit Voided(marketId);
            return;
        }

        m.status = Status.Resolved;
        m.winner = winner;
        emit Resolved(marketId, winner);
    }

    /// @inheritdoc IParimutuelSettler
    function voidMarket(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        bool resolverEarly = msg.sender == m.resolver && block.timestamp >= m.resolutionTime;
        bool timedOut = block.timestamp >= uint256(m.resolutionTime) + m.voidTimeout;
        if (!resolverEarly && !timedOut) revert TooEarly();
        m.status = Status.Voided;
        emit Voided(marketId);
    }

    // ------------------------------------------------------------------ claims

    /// @inheritdoc IParimutuelSettler
    function claim(uint256 positionId) external nonReentrant {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.claimed) revert AlreadyClaimed();

        Market storage m = markets[p.marketId];
        if (m.status == Status.Open) revert NotSettled();

        uint256 payout;
        uint256 refund;
        if (m.status == Status.Voided) {
            refund = p.accepted;
        } else {
            payout = _payout(m, p);
            m.paidOut += payout;
        }

        p.claimed = true;
        if (p.accepted > 0) m.books[p.outcome].live -= 1;

        emit Claimed(positionId, msg.sender, payout, refund);
        _push(m.token, msg.sender, payout + refund);
    }

    /// @inheritdoc IParimutuelSettler
    /// @dev Nothing is ever refused here, so there is never a remainder to withdraw. The
    ///      method exists so the two settlers present one surface; it always reverts.
    function withdrawRefund(uint256) external pure {
        revert NothingToRefund();
    }

    /// @inheritdoc IParimutuelSettler
    /// @dev Settlement follows the position, not the address that opened it — which is what
    ///      lets a factory open a market on someone's behalf and hand them the seed legs.
    function transferPosition(uint256 positionId, address to) external {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.claimed) revert AlreadyClaimed();
        p.owner = to;
        emit PositionTransferred(positionId, msg.sender, to);
    }

    /// @notice Sweep the flooring remainder once every winning position has been paid.
    function claimResidue(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        if (m.status != Status.Resolved) revert NotSettled();
        if (msg.sender != m.residueOwner) revert NotResidueOwner();
        if (m.residueClaimed) revert AlreadyClaimed();
        if (m.books[m.winner].live != 0) revert WinnersOutstanding();

        uint256 amount = m.acceptedPool - m.paidOut;
        m.residueClaimed = true;
        emit ResidueClaimed(marketId, msg.sender, amount);
        _push(m.token, msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IParimutuelSettler
    /// @dev Unbounded: a classic pool never refuses stake for want of capacity. Returning
    ///      `type(uint256).max` rather than reverting keeps agent code written against the
    ///      interface working unchanged across both settlers.
    function headroom(uint256, uint8) external pure returns (uint256) {
        return type(uint256).max;
    }

    /// @inheritdoc IParimutuelSettler
    function previewPayout(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        Market storage m = markets[p.marketId];
        if (m.status != Status.Resolved) return 0;
        return _payout(m, p);
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function positionCount() external view returns (uint256) {
        return positions.length;
    }

    function getBook(uint256 marketId, uint8 outcome) external view returns (Book memory) {
        return markets[marketId].books[outcome];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    /// @inheritdoc IParimutuelSettler
    function getMarket(uint256 marketId)
        external
        view
        returns (
            IERC20 token,
            address creator,
            address resolver,
            address residueOwner,
            uint64 resolutionTime,
            uint64 voidTimeout,
            uint8 n,
            uint8 status,
            uint8 winner,
            uint256 kappa,
            uint256 acceptedPool,
            uint256 paidOut
        )
    {
        Market storage m = markets[marketId];
        return (
            m.token,
            m.creator,
            m.resolver,
            m.residueOwner,
            m.resolutionTime,
            m.voidTimeout,
            m.n,
            uint8(m.status),
            m.winner,
            m.kappa,
            m.acceptedPool,
            m.paidOut
        );
    }

    // ------------------------------------------------------------------ internals

    /// @dev `floor(pool * stake / winningPrincipal)`, the live product's rule exactly, and
    ///      zero for anything not on the winning side. The losing-side guard lives here
    ///      rather than in the callers so `claim` and `previewPayout` cannot drift apart —
    ///      they did, and the conservation fuzz caught it paying losers out of the pool.
    ///      Flooring per position is what guarantees the distributed total never exceeds
    ///      the pool; the sub-unit remainder is the residue.
    function _payout(Market storage m, Position storage p) internal view returns (uint256) {
        if (p.outcome != m.winner) return 0;
        uint256 winningPrincipal = m.books[m.winner].principal;
        if (winningPrincipal == 0) return 0;
        return (m.acceptedPool * uint256(p.accepted)) / winningPrincipal;
    }

    function _pull(IERC20 token, address from, uint256 amount) internal {
        if (amount == 0) return;
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
