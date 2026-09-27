// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal ERC-20 surface. The settlement asset MUST be transfer-exact
///      (§6 requirement (a)): no fee-on-transfer, no rebasing.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  Vested Parimutuel (VPM) — reference on-chain implementation
/// @notice One contract, many markets. Implements the mechanism of the paper
///         "The Vested Parimutuel" exactly as its reference settler does:
///           * Rule 1 (flow vesting) and Rule 2 (capacity matching), §4.1;
///           * the reserved vintage-0 seed with the Rule-2 fixed-point clamp, §4.4;
///           * block vintages with the normative batching rules (i)–(iii), §4.4;
///           * the O(1) reward-per-share accumulator in fixed point (S = 1e18), §6;
///           * pull-based claims, residue owner fixed at creation, §6 (a)–(d);
///           * resolution timestamp fixed at creation, accumulator frozen there,
///             post-freeze entries refused, void path refunding accepted principal, §12.
///         This is a readable reference, not a gas-optimised product. λ = 1 and
///         fee = 0 throughout (see README for the deviation list).
/// @dev    Block vintages are applied lazily (design "A" in the README): entries of
///         the current block are buffered with their OFFERED amount; the vintage is
///         finalized — rationed (§4.4 iii), vested against the vintage-start books
///         (§4.4 i), capacity granted (§4.4 ii) — by the first transaction of a later
///         block that touches the market (`enter`, `finalizeVintage`, `resolve`,
///         `voidMarket`, `withdrawRefund`). The refused remainder of a partial fill is
///         therefore pulled by the owner (`withdrawRefund`/`claim`) rather than pushed
///         in the entry transaction; §6 (c)'s "same-transaction refund" holds only when
///         acceptance is knowable in that transaction, which under the §4.4 batching
///         rule is never the case for an entry that is not the last of its block.
contract VestedParimutuel {
    // ------------------------------------------------------------------ constants
    /// @notice Fixed-point scale S of the accumulator (§6). Choose S ≳ s_max·m_max.
    uint256 public constant SCALE = 1e18;
    /// @notice Sentinel for κ → ∞ (§4.3: the prescription for n-way markets).
    uint256 public constant KAPPA_UNBOUNDED = type(uint256).max;
    /// @dev The seed clamp is monotone and converges in ≤ 2 passes for κ ≥ 1; the
    ///      bound only guards against a pathological input.
    uint256 internal constant MAX_CLAMP_PASSES = 64;

    // ------------------------------------------------------------------ types
    enum Status {
        Open,
        Resolved,
        Voided
    }

    /// @notice Per-outcome running scalars of §6 plus the open-vintage demand of §4.4.
    struct Book {
        uint256 principal; // P_w  — accepted principal on w
        uint256 acc;       // A_w  — reward-per-share accumulator, fixed point at SCALE
        uint256 capacity;  // C_w  — κ·P_w (saturates at KAPPA_UNBOUNDED)
        uint256 vested;    // V_w  — total accepted stake vested INTO w
        uint256 demand;    // D_w  — joint offered demand of the open vintage against w
        uint256 live;      // positions on w with accepted > 0 not yet claimed (residue gate)
    }

    struct Market {
        IERC20 token;
        address creator;
        address resolver;      // §12: who may resolve after `resolutionTime`
        address residueOwner;  // §6: fixed at creation, the only residue claimant
        uint64 resolutionTime; // §12: freeze — entries at or after this timestamp are refused
        uint64 voidTimeout;    // §12: after resolutionTime + voidTimeout anyone may void
        uint8 n;               // |O| ≥ 2
        Status status;
        uint8 winner;          // ω, valid when Resolved
        uint256 kappa;         // κ ≥ 1, or KAPPA_UNBOUNDED
        uint256 acceptedPool;  // Π — Σ_w P_w
        uint256 paidOut;       // Σ payouts claimed on the winning side
        bool residueClaimed;
        bool vintageOpen;      // an unfinalized vintage is buffered
        uint64 vintageBlock;   // its block number (= its vintage id ν)
        uint256[] pending;     // its position ids, in arrival order
        Book[] books;
    }

    /// @notice The complete transferable state of a position (§6, §11): four numbers
    ///         (outcome, accepted principal, entry accumulator, vintage) plus bookkeeping.
    /// @dev    Three storage slots: [marketId|owner|outcome|flags] [vintage|offered]
    ///         [accepted|entryAcc], so finalizing an entry writes two slots, not four.
    ///         Amounts are therefore bounded by 2^128 − 1 units (AmountTooLarge).
    struct Position {
        uint64 marketId;
        address owner;
        uint8 outcome;
        bool finalized;
        bool refunded;     // the refused remainder (offered − accepted) has been withdrawn
        bool claimed;      // the settlement claim has been paid
        uint64 vintage;    // block number; 0 is the reserved seed vintage
        uint128 offered;   // c_k — stake offered at entry
        uint128 accepted;  // s_i — principal accepted under Rule 2 (known after finalization)
        uint128 entryAcc;  // A_o(τ_i) — the accumulator of its outcome at entry
    }

    // ------------------------------------------------------------------ storage
    Market[] internal markets;
    Position[] public positions;
    uint256 private locked = 1;

    // ------------------------------------------------------------------ events / errors
    event MarketCreated(uint256 indexed marketId, address indexed creator, uint8 n, uint256 kappa, uint64 resolutionTime);
    event Entered(uint256 indexed marketId, uint256 indexed positionId, address indexed owner, uint8 outcome, uint256 offered, uint64 vintage);
    event VintageFinalized(uint256 indexed marketId, uint64 indexed vintage, uint256 entries);
    event Resolved(uint256 indexed marketId, uint8 winner);
    event Voided(uint256 indexed marketId);
    event Claimed(uint256 indexed positionId, address indexed to, uint256 payout, uint256 refund);
    event ResidueClaimed(uint256 indexed marketId, address indexed to, uint256 amount);
    event PositionTransferred(uint256 indexed positionId, address indexed from, address indexed to);

    error InvalidKappa();
    error InvalidSeed();          // F3 / P11: a leg left unbacked voids the market at creation
    error InvalidOutcomes();
    error BadResolutionTime();
    error Frozen();               // §12: entry at or after the resolution timestamp
    error NotOpen();
    error NotSettled();
    error NotResolver();
    error TooEarly();
    error NotOwner();
    error AlreadyClaimed();
    error NothingToRefund();
    error NotFinalized();
    error NotResidueOwner();
    error WinnersOutstanding();
    error ClampDidNotConverge();
    error TransferFailed();
    error Reentrancy();
    error AmountTooLarge();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    // ================================================================== creation (§4.4)

    /// @notice Open a market by posting the creator's seed on every outcome in the
    ///         reserved vintage 0. `seed[o]` is the amount OFFERED on outcome o; the
    ///         accepted legs are the greatest a_o ≤ seed[o] with a_o ≤ κ·min_{w≠o} a_w
    ///         (the Rule-2 fixed point, integer arithmetic). Any leg accepted at 0 voids
    ///         the market at creation, which on-chain is a revert: nothing is created,
    ///         nothing moves. Only the ACCEPTED total is pulled from the creator, so the
    ///         refused part of an asymmetric seed never leaves the creator's wallet.
    /// @param  token          transfer-exact settlement asset (§6 a)
    /// @param  seed           offered amount per outcome; length n = |O| ≥ 2
    /// @param  kappa          capacity coefficient κ ≥ 1, or KAPPA_UNBOUNDED
    /// @param  resolutionTime the freeze (§12), fixed now and never movable
    /// @param  voidTimeout    seconds after resolutionTime from which anyone may void
    /// @param  resolver       the address allowed to resolve (or void early)
    /// @param  residueOwner   the residue's named owner (§6)
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

        uint256 total = _seedVintage(m, marketId, seed, kappa);
        m.acceptedPool = total;
        emit MarketCreated(marketId, msg.sender, uint8(n), kappa, resolutionTime);

        _pull(token, msg.sender, total);
    }

    /// @dev Vintage 0: clamp the seed, open the books, record the legs. The legs are each
    ///      other's counterparties: each leg vests its accepted principal into every other
    ///      leg's book (the books ARE the seed legs), so book w receives total − a_w against
    ///      P_w = a_w. Seed positions record A = 0, i.e. BEFORE these increments.
    function _seedVintage(Market storage m, uint256 marketId, uint256[] calldata seed, uint256 kappa)
        internal
        returns (uint256 total)
    {
        uint256[] memory acc = _seedClamp(seed, kappa);
        total = _sum(acc);
        for (uint256 w = 0; w < acc.length; w++) {
            Book storage b = m.books.push();
            b.principal = acc[w];
            b.capacity = _times(kappa, acc[w]);
            b.vested = total - acc[w];
            b.acc = ((total - acc[w]) * SCALE) / acc[w];
            b.live = 1;
            _pushSeedPosition(marketId, uint8(w), seed[w], acc[w]);
        }
    }

    function _pushSeedPosition(uint256 marketId, uint8 w, uint256 offered, uint256 accepted) internal {
        positions.push(
            Position({
                marketId: uint64(marketId),
                owner: msg.sender,
                outcome: w,
                finalized: true,
                refunded: true, // the refused part was never pulled
                claimed: false,
                vintage: 0,
                offered: _u128(offered),
                accepted: _u128(accepted),
                entryAcc: 0
            })
        );
        emit Entered(marketId, positions.length - 1, msg.sender, w, offered, 0);
    }

    function _sum(uint256[] memory xs) internal pure returns (uint256 t) {
        for (uint256 i = 0; i < xs.length; i++) t += xs[i];
    }

    /// @dev §4.4 creation: a_o ← min(offered_o, κ·min_{w≠o} a_w), iterated to a fixed
    ///      point. Monotone non-increasing from `offered`, so it terminates; reverts
    ///      InvalidSeed if any leg ends at 0 (a missing leg, a zero leg, or a leg the
    ///      clamp drives to zero).
    function _seedClamp(uint256[] calldata offered, uint256 kappa) internal pure returns (uint256[] memory acc) {
        uint256 n = offered.length;
        acc = new uint256[](n);
        for (uint256 o = 0; o < n; o++) acc[o] = offered[o];
        bool converged;
        for (uint256 pass = 0; pass < MAX_CLAMP_PASSES && !converged; pass++) {
            converged = true;
            for (uint256 o = 0; o < n; o++) {
                uint256 cap = type(uint256).max;
                for (uint256 w = 0; w < n; w++) {
                    if (w == o) continue;
                    uint256 c = _times(kappa, acc[w]);
                    if (c < cap) cap = c;
                }
                uint256 next = offered[o] < cap ? offered[o] : cap;
                if (next != acc[o]) {
                    acc[o] = next;
                    converged = false;
                }
            }
        }
        if (!converged) revert ClampDidNotConverge();
        for (uint256 o = 0; o < n; o++) {
            if (acc[o] == 0) revert InvalidSeed();
        }
    }

    // ================================================================== entry (§4.1, §4.4)

    /// @notice Offer `amount` on `outcome`. The entry joins the vintage of the current
    ///         block; its accepted amount is fixed when that vintage is finalized
    ///         (rationed per §4.4 iii against the headroom as of vintage start). The
    ///         full offered amount is escrowed now; the refused remainder becomes
    ///         withdrawable once the vintage is finalized.
    function enter(uint256 marketId, uint8 outcome, uint256 amount) external nonReentrant returns (uint256 positionId) {
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        if (outcome >= m.n) revert InvalidOutcomes();
        if (amount == 0) revert InvalidOutcomes();
        // §12 freeze: the market ends at its declared time; a post-freeze entry is
        // refused in full (it would vest into a frozen accumulator and break P1).
        if (block.timestamp >= m.resolutionTime) revert Frozen();

        _rollVintage(marketId);
        if (!m.vintageOpen) {
            m.vintageOpen = true;
            m.vintageBlock = uint64(block.number);
        }

        positionId = positions.length;
        positions.push(
            Position({
                marketId: uint64(marketId),
                owner: msg.sender,
                outcome: outcome,
                finalized: false,
                refunded: false,
                claimed: false,
                vintage: uint64(block.number),
                offered: _u128(amount),
                accepted: 0,
                entryAcc: 0
            })
        );
        m.pending.push(positionId);
        // Rule 1: a stake is assigned in full to EVERY opposing branch, so it is demand
        // against every opposing book (§3).
        uint256 n = m.n;
        for (uint256 w = 0; w < n; w++) {
            if (w != outcome) m.books[w].demand += amount;
        }
        emit Entered(marketId, positionId, msg.sender, outcome, amount, uint64(block.number));

        _pull(m.token, msg.sender, amount);
    }

    /// @notice Finalize the buffered vintage if its block has passed. Anyone may poke.
    function finalizeVintage(uint256 marketId) external {
        _rollVintage(marketId);
    }

    function _rollVintage(uint256 marketId) internal {
        Market storage m = markets[marketId];
        if (m.vintageOpen && block.number > m.vintageBlock) _finalizeVintage(marketId);
    }

    /// @dev The §4.4 batching rule, in the §6 O(1)-per-outcome form:
    ///        (iii) headroom H_w = C_w − V_w snapshotted at vintage start; joint demand
    ///              D_w; each entry's cap on w is ⌊c·H_w/D_w⌋ if D_w > H_w else c; the
    ///              accepted amount is the minimum over opposing books (single pass —
    ///              headroom an entry leaves unused because it was cut on another book
    ///              is NOT redistributed within the vintage);
    ///        (i)   the summed accepted inflow into each book is applied to A_w once,
    ///              against the vintage-start P_w, and every entry records A_o AFTER
    ///              the increments, so same-vintage entries never vest to each other;
    ///        (ii)  principal and capacity are booked last, usable from the next vintage.
    function _finalizeVintage(uint256 marketId) internal {
        Market storage m = markets[marketId];
        uint256 n = m.n;
        uint256 k = m.pending.length;
        uint256[] memory head = new uint256[](n);
        uint256[] memory inflow = new uint256[](n);
        for (uint256 w = 0; w < n; w++) head[w] = _headroom(m.books[w]);

        // (iii) acceptance
        for (uint256 i = 0; i < k; i++) {
            Position storage p = positions[m.pending[i]];
            uint256 c = p.offered;
            uint256 a = c;
            for (uint256 w = 0; w < n; w++) {
                if (w == p.outcome) continue;
                uint256 d = m.books[w].demand;
                if (head[w] != KAPPA_UNBOUNDED && d > head[w]) {
                    uint256 cap = (c * head[w]) / d;
                    if (cap < a) a = cap;
                }
            }
            p.accepted = _u128(a);
            for (uint256 w = 0; w < n; w++) {
                if (w != p.outcome) inflow[w] += a;
            }
        }
        // (i) vesting against the vintage-start books
        for (uint256 w = 0; w < n; w++) {
            Book storage b = m.books[w];
            if (inflow[w] > 0) {
                b.acc += (inflow[w] * SCALE) / b.principal; // P_w > 0 by the creation rule
                b.vested += inflow[w];
            }
            b.demand = 0;
        }
        // record entries, then (ii) book principal and capacity
        for (uint256 i = 0; i < k; i++) {
            Position storage p = positions[m.pending[i]];
            Book storage b = m.books[p.outcome];
            p.entryAcc = _u128(b.acc);
            p.finalized = true;
            uint256 a = p.accepted;
            if (a > 0) {
                b.principal += a;
                b.capacity = _addCapacity(b.capacity, _times(m.kappa, a));
                b.live += 1;
                m.acceptedPool += a;
            }
        }
        emit VintageFinalized(marketId, m.vintageBlock, k);
        delete m.pending;
        m.vintageOpen = false;
    }

    // ================================================================== resolution (§12)

    /// @notice Declare the realized outcome. Only the resolver, only at or after the
    ///         freeze. The accumulator was frozen at `resolutionTime` by construction
    ///         (no entry can land after it), so resolution latency has zero payoff impact.
    function resolve(uint256 marketId, uint8 winner) external {
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        if (msg.sender != m.resolver) revert NotResolver();
        if (block.timestamp < m.resolutionTime) revert TooEarly();
        if (winner >= m.n) revert InvalidOutcomes();
        _rollVintage(marketId);
        m.status = Status.Resolved;
        m.winner = winner;
        emit Resolved(marketId, winner);
    }

    /// @notice Void the market: the resolver may at any time after the freeze, anyone
    ///         after `resolutionTime + voidTimeout`. Every position then refunds at its
    ///         accepted principal (§12, case V4). The seed legs refund at accepted
    ///         principal too; §12's timeout forfeiture of the resolver's seed is venue
    ///         policy layered on top of this identity and is not implemented here.
    function voidMarket(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        bool resolverEarly = msg.sender == m.resolver && block.timestamp >= m.resolutionTime;
        bool timedOut = block.timestamp >= uint256(m.resolutionTime) + m.voidTimeout;
        if (!resolverEarly && !timedOut) revert TooEarly();
        _rollVintage(marketId);
        m.status = Status.Voided;
        emit Voided(marketId);
    }

    // ================================================================== claims (§6, pull-based)

    /// @notice Withdraw the refused remainder of a partial fill (offered − accepted).
    ///         Available once the position's vintage is finalized, before or after
    ///         resolution. `claim` also pays it if still outstanding.
    function withdrawRefund(uint256 positionId) external nonReentrant {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        Market storage m = markets[p.marketId];
        if (m.status == Status.Open) _rollVintage(p.marketId);
        if (!p.finalized) revert NotFinalized();
        if (p.refunded) revert NothingToRefund();
        p.refunded = true;
        uint256 refund = p.offered - p.accepted;
        if (refund == 0) revert NothingToRefund();
        emit Claimed(positionId, msg.sender, 0, refund);
        _push(m.token, msg.sender, refund);
    }

    /// @notice Settle a position after resolution or void. Independent of every other
    ///         position (§6 b): Π_i = s_i·(S + A_ω(T) − A_ω(τ_i)) / S if o_i = ω, else 0;
    ///         on void, s_i. Any un-withdrawn refused remainder is paid alongside.
    function claim(uint256 positionId) external nonReentrant {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.claimed) revert AlreadyClaimed();
        Market storage m = markets[p.marketId];
        if (m.status == Status.Open) revert NotSettled();
        // resolve/void finalized the last vintage, so p.finalized holds here.

        uint256 payout;
        if (m.status == Status.Resolved) {
            if (p.outcome == m.winner && p.accepted > 0) {
                Book storage b = m.books[m.winner];
                payout = (p.accepted * (SCALE + b.acc - p.entryAcc)) / SCALE;
                m.paidOut += payout;
                b.live -= 1;
            }
        } else {
            payout = p.accepted; // void: refund at accepted principal, exactly
        }
        uint256 refund;
        if (!p.refunded) {
            p.refunded = true;
            refund = p.offered - p.accepted;
        }
        p.claimed = true;
        emit Claimed(positionId, msg.sender, payout, refund);
        if (payout + refund > 0) _push(m.token, msg.sender, payout + refund);
    }

    /// @notice The fixed-point residue, `accepted pool − Σ payouts` (§6), claimable only
    ///         by the residue owner named at creation, once every winning position has
    ///         claimed (the sum of floors is not known before the last claim). A void
    ///         market has no residue: every accepted unit refunds exactly.
    function claimResidue(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        if (msg.sender != m.residueOwner) revert NotResidueOwner();
        if (m.status != Status.Resolved) revert NotSettled();
        if (m.books[m.winner].live != 0) revert WinnersOutstanding();
        if (m.residueClaimed) revert AlreadyClaimed();
        m.residueClaimed = true;
        uint256 residue = m.acceptedPool - m.paidOut;
        emit ResidueClaimed(marketId, msg.sender, residue);
        if (residue > 0) _push(m.token, msg.sender, residue);
    }

    // ================================================================== exit (§4.4, §11)

    /// @notice Transfer a position whole: principal, vested claims and vintage move
    ///         intact and the pool is untouched. Split/merge are out of scope here.
    function transferPosition(uint256 positionId, address to) external {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.claimed) revert AlreadyClaimed();
        p.owner = to;
        emit PositionTransferred(positionId, msg.sender, to);
    }

    // ================================================================== views

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function positionCount() external view returns (uint256) {
        return positions.length;
    }

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
            Status status,
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
            m.status,
            m.winner,
            m.kappa,
            m.acceptedPool,
            m.paidOut
        );
    }

    function getBook(uint256 marketId, uint8 outcome) external view returns (Book memory) {
        return markets[marketId].books[outcome];
    }

    function pendingCount(uint256 marketId) external view returns (uint256) {
        return markets[marketId].pending.length;
    }

    /// @notice Acceptance headroom H_w = C_w − V_w of a book as it stands now
    ///         (KAPPA_UNBOUNDED when κ is unbounded).
    function headroom(uint256 marketId, uint8 outcome) external view returns (uint256) {
        return _headroom(markets[marketId].books[outcome]);
    }

    /// @notice What `claim` would pay a finalized position on a resolved market (payout only).
    function previewPayout(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        Market storage m = markets[p.marketId];
        if (m.status != Status.Resolved || p.outcome != m.winner || !p.finalized) return 0;
        return (p.accepted * (SCALE + m.books[m.winner].acc - p.entryAcc)) / SCALE;
    }

    // ================================================================== internals

    function _headroom(Book storage b) internal view returns (uint256) {
        if (b.capacity == KAPPA_UNBOUNDED) return KAPPA_UNBOUNDED;
        return b.capacity > b.vested ? b.capacity - b.vested : 0;
    }

    /// @dev κ·x with the unbounded sentinel: ∞·0 = 0, ∞·x = ∞.
    function _times(uint256 kappa, uint256 x) internal pure returns (uint256) {
        if (kappa == KAPPA_UNBOUNDED) return x == 0 ? 0 : KAPPA_UNBOUNDED;
        return kappa * x;
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert AmountTooLarge();
        return uint128(x);
    }

    function _addCapacity(uint256 c, uint256 d) internal pure returns (uint256) {
        if (c == KAPPA_UNBOUNDED || d == KAPPA_UNBOUNDED) return KAPPA_UNBOUNDED;
        return c + d;
    }

    function _pull(IERC20 token, address from, uint256 amount) internal {
        if (amount == 0) return;
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(IERC20 token, address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
