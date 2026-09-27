// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEIP3009} from "./interfaces/IEIP3009.sol"; // D5: USDG's signed pull (EIP-3009)

/// @dev Minimal ERC-20 surface. The settlement asset MUST be transfer-exact
///      (§6 requirement (a)): no fee-on-transfer, no rebasing.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  HunchVPM — the reference Vested Parimutuel plus diffs D1–D9 and nothing else
/// @notice One contract, many markets. Implements the mechanism of the paper
///         "The Vested Parimutuel" exactly as its reference settler does:
///           * Rule 1 (flow vesting) and Rule 2 (capacity matching), §4.1;
///           * the reserved vintage-0 seed with the Rule-2 fixed-point clamp, §4.4;
///           * block vintages with the normative batching rules (i)–(iii), §4.4;
///           * the O(1) reward-per-share accumulator in fixed point (S = 1e18), §6;
///           * pull-based claims, residue owner fixed at creation, §6 (a)–(d);
///           * resolution timestamp fixed at creation, accumulator frozen there,
///             post-freeze entries refused, void path refunding accepted principal, §12.
///         λ = 1. The product adds, around that unchanged mechanism: D1 a fee on
///         winners' gains, D2 claims deliverable by anyone (to the owner only), D3 per-market
///         entry bounds, D4 a guardian switch that pauses new entries and nothing else, D5
///         gasless entry through a signed USDG transfer (EIP-3009), D6 views, D7 events, and
///         two safety fixes. D8: `resolve` / `voidMarket` finalize the last vintage even when
///         `block.number` has not advanced. On Robinhood Chain `block.number` is the L1 block
///         (~12 s) while timestamps are L2, so a market can settle in the same "block" as its
///         last entry; the reference would then leave that vintage pending, pay its entries
///         back as refunds, and let a later `finalizeVintage` vest the same stake into the
///         winners again, which drains other markets' escrow (test/SameBlockSettlement.t.sol).
///         D9: lock prevention. Every path out of a market finalizes its pending vintage
///         first, so finalizing must always fit in a block and must never revert: a vintage
///         holds at most MAX_VINTAGE_ENTRIES entries and at most MAX_VINTAGE_WORK
///         entry-outcome pairs (finalizing is linear in both), and a finite κ is at most
///         MAX_KAPPA (κ·a at finalization could otherwise overflow and revert every exit).
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
///         D1–D9: every line changed relative to src/reference/VestedParimutuel.sol carries
///         its diff tag; scripts/diff-reference.sh (contracts/DIFF.md) rejects untagged hunks.
contract HunchVPM {
    // ------------------------------------------------------------------ constants
    /// @notice Fixed-point scale S of the accumulator (§6). Choose S ≳ s_max·m_max.
    uint256 public constant SCALE = 1e18;
    /// @notice Sentinel for κ → ∞ (§4.3: the prescription for n-way markets).
    uint256 public constant KAPPA_UNBOUNDED = type(uint256).max;
    /// @dev The seed clamp is monotone and converges in ≤ 2 passes for κ ≥ 1; the
    ///      bound only guards against a pathological input.
    uint256 internal constant MAX_CLAMP_PASSES = 64;
    /// @notice D1: the highest fee a market may charge, in basis points of a winner's gain (5%).
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice D5: the type hash inside `enterNonce`, which binds a signed USDG transfer to
    ///         one market, one side and one amount.
    bytes32 public constant ENTER_TYPEHASH =
        keccak256("HunchEnter(uint256 marketId,uint8 outcome,uint256 amount,bytes32 salt)");
    /// @notice D9: the most entries one vintage (one L1 block, ~12 s) may hold, so finalizing a
    ///         vintage always fits in a block (~34,000 gas per entry, under 7.5M gas here).
    uint256 public constant MAX_VINTAGE_ENTRIES = 200;
    /// @notice D9: the most entry-outcome pairs one vintage may hold (entries × n): finalizing
    ///         loops over every outcome for every entry, so on a many-outcome market the entry
    ///         cap alone does not bound its gas. 200 entries up to 64 outcomes, fewer above.
    uint256 public constant MAX_VINTAGE_WORK = 12_800;
    /// @notice D9: the largest finite κ `create` accepts (KAPPA_UNBOUNDED is also accepted).
    ///         κ·a is computed at finalization; a larger κ could overflow there and lock the market.
    uint256 public constant MAX_KAPPA = 1e9;

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
        uint16 feeBps;         // D1: fee on a winner's gain, basis points (packs with `status`)
        uint128 minEntry;      // D3: smallest offered amount `enter` accepts, 0 = no bound
        uint256 kappa;         // κ ≥ 1, or KAPPA_UNBOUNDED
        uint256 acceptedPool;  // Π — Σ_w P_w
        uint256 paidOut;       // Σ payouts claimed on the winning side
        bool residueClaimed;
        bool vintageOpen;      // an unfinalized vintage is buffered
        uint64 vintageBlock;   // its block number (= its vintage id ν)
        uint128 maxEntry;      // D3: largest offered amount `enter` accepts, 0 = no bound
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
    /// @notice D4: the only address that may pause new entries (the Safe). It can do nothing else.
    address public immutable guardian;
    /// @notice D1: the only address swept fees can go to (the Safe). Fixed at deployment.
    address public immutable treasury;
    /// @notice D4: while true, `enter` and `enterWithAuthorization` revert; nothing else changes.
    bool public entriesPaused;
    /// @notice D1: fees taken from winners' gains and not yet swept, per settlement token.
    mapping(address => uint256) public feesAccrued;
    /// @dev D6: every position id of a market (seed legs first, then entries in arrival
    ///      order), packed four to a slot. Write-only bookkeeping for `marketPositions`.
    mapping(uint256 => uint64[]) internal marketPositionIds;

    // ------------------------------------------------------------------ events / errors
    event MarketCreated(uint256 indexed marketId, address indexed creator, uint8 n, uint256 kappa, uint64 resolutionTime);
    event Entered(uint256 indexed marketId, uint256 indexed positionId, address indexed owner, uint8 outcome, uint256 offered, uint64 vintage);
    event VintageFinalized(uint256 indexed marketId, uint64 indexed vintage, uint256 entries);
    event Resolved(uint256 indexed marketId, uint8 winner);
    event Voided(uint256 indexed marketId);
    event Claimed(uint256 indexed positionId, address indexed to, uint256 payout, uint256 refund);
    event ResidueClaimed(uint256 indexed marketId, address indexed to, uint256 amount);
    event PositionTransferred(uint256 indexed positionId, address indexed from, address indexed to);
    event FeeAccrued(uint256 indexed positionId, uint256 fee); // D1, D7
    event FeesSwept(address indexed token, address indexed to, uint256 amount); // D1, D7
    event EntriesPaused(bool paused); // D4, D7

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
    error FeeTooHigh();           // D1: feeBps above MAX_FEE_BPS
    error InvalidEntryBounds();   // D3: minEntry above a non-zero maxEntry
    error EntryTooSmall();        // D3: offered amount below the market's minEntry
    error EntryTooLarge();        // D3: offered amount above the market's maxEntry
    error EntriesArePaused();     // D4: the guardian has paused new entries
    error NotGuardian();          // D4
    error ZeroAddress();          // D1, D4, D5
    error VintageFull();          // D9: this block's vintage is full (MAX_VINTAGE_ENTRIES or MAX_VINTAGE_WORK)

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    /// @notice D1, D4: fixes the guardian and the treasury for the life of the contract.
    ///         There is no owner and no way to change either address.
    /// @param  guardian_ may pause and unpause new entries, and nothing else (D4)
    /// @param  treasury_ receives swept fees, and nothing else (D1)
    constructor(address guardian_, address treasury_) {
        if (guardian_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        treasury = treasury_;
    }

    /// @notice D4: pause or unpause NEW entries (`enter`, `enterWithAuthorization`) in every
    ///         market. Only the guardian may call it. It can never block resolution, voids,
    ///         claims, refunds, residue, fee sweeps or position transfers, and moves no funds.
    function setEntriesPaused(bool paused) external {
        if (msg.sender != guardian) revert NotGuardian();
        entriesPaused = paused;
        emit EntriesPaused(paused);
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
    /// @param  kappa          capacity coefficient 1 ≤ κ ≤ MAX_KAPPA, or KAPPA_UNBOUNDED (D9)
    /// @param  resolutionTime the freeze (§12), fixed now and never movable
    /// @param  voidTimeout    seconds after resolutionTime from which anyone may void
    /// @param  resolver       the address allowed to resolve (or void early)
    /// @param  residueOwner   the residue's named owner (§6)
    /// @param  feeBps         D1: fee on each winning claim's gain, basis points, ≤ MAX_FEE_BPS
    /// @param  minEntry       D3: smallest offered amount per entry, 0 = no bound (immutable)
    /// @param  maxEntry       D3: largest offered amount per entry, 0 = no bound (immutable)
    ///         Anyone may create a market; the creator gains no power over it beyond owning
    ///         its seed legs. Nothing about a market can be changed after this call.
    function create(
        IERC20 token,
        uint256[] calldata seed,
        uint256 kappa,
        uint64 resolutionTime,
        uint64 voidTimeout,
        address resolver,
        address residueOwner,
        uint16 feeBps, // D1
        uint128 minEntry, // D3
        uint128 maxEntry // D3
    ) external nonReentrant returns (uint256 marketId) {
        if (seed.length < 2 || seed.length > 255) revert InvalidOutcomes(); // D1, D3: `n` inlined (stack)
        if (kappa < 1) revert InvalidKappa();
        if (kappa > MAX_KAPPA && kappa != KAPPA_UNBOUNDED) revert InvalidKappa(); // D9: κ·a never overflows
        if (resolutionTime <= block.timestamp) revert BadResolutionTime();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(); // D1
        if (maxEntry != 0 && minEntry > maxEntry) revert InvalidEntryBounds(); // D3

        marketId = markets.length;
        Market storage m = markets.push();
        m.token = token;
        m.creator = msg.sender;
        m.resolver = resolver;
        m.residueOwner = residueOwner;
        m.resolutionTime = resolutionTime;
        m.voidTimeout = voidTimeout;
        m.n = uint8(seed.length); // D1, D3: `n` inlined to make stack room for the new arguments
        m.kappa = kappa;
        m.feeBps = feeBps; // D1
        m.minEntry = minEntry; // D3
        m.maxEntry = maxEntry; // D3

        uint256 total = _seedVintage(m, marketId, seed, kappa);
        m.acceptedPool = total;
        emit MarketCreated(marketId, msg.sender, uint8(seed.length), kappa, resolutionTime); // D1, D3: stack

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
        marketPositionIds[marketId].push(uint64(positions.length - 1)); // D6: seed legs first
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
    ///         D3/D4/D5: anyone may call it, for themselves only (the position's owner is
    ///         `msg.sender`); it pays with `transferFrom`, so it needs an allowance.
    function enter(uint256 marketId, uint8 outcome, uint256 amount) external nonReentrant returns (uint256 positionId) {
        positionId = _enter(msg.sender, marketId, outcome, amount); // D5: the one entry path
        _pull(markets[marketId].token, msg.sender, amount);
    }

    /// @notice D5: the same entry as `enter`, paid with a USDG ReceiveWithAuthorization
    ///         (EIP-3009) that `from` signed, so a bettor needs no ETH and no approval.
    ///         Anyone may relay it; the position always belongs to `from`, never to the
    ///         relayer. The signed nonce is `enterNonce(marketId, outcome, amount, salt)`, so
    ///         a relayer can never change the market, the side or the amount (the token's
    ///         signature check fails), and the token marks the nonce used, so it can never
    ///         be replayed. The authorization's payee is this contract, which only this
    ///         contract can redeem (EIP-3009 requires `to == msg.sender`).
    /// @param  from        the bettor who signed, and the position's owner
    /// @param  validAfter  the authorization is valid strictly after this unix time
    /// @param  validBefore the authorization is valid strictly before this unix time
    /// @param  salt        any bettor-chosen value, so the same bet can be signed twice
    /// @param  signature   65-byte ECDSA (r, s, v) or an ERC-1271 smart-wallet signature
    function enterWithAuthorization(
        address from,
        uint256 marketId,
        uint8 outcome,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external nonReentrant returns (uint256 positionId) {
        if (from == address(0)) revert ZeroAddress(); // D5
        bytes32 nonce = enterNonce(marketId, outcome, amount, salt); // D5: binds market, side, amount
        positionId = _enter(from, marketId, outcome, amount); // D5: checks, roll, book for `from`
        IEIP3009(address(markets[marketId].token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, signature
        ); // D5: pulled last; the token reverts on a wrong signature, time window or reuse
    }

    /// @notice D5: the EIP-3009 nonce a bettor signs for one entry. It binds the chain, this
    ///         contract, the market, the side and the amount (plus the bettor's salt).
    function enterNonce(uint256 marketId, uint8 outcome, uint256 amount, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(ENTER_TYPEHASH, block.chainid, address(this), marketId, outcome, amount, salt));
    }

    /// @dev The reference `enter` body with the owner passed in (D5), preceded by the
    ///      entries-pause check (D4) and the market's entry bounds on the OFFERED amount (D3).
    function _enter(address owner, uint256 marketId, uint8 outcome, uint256 amount)
        internal
        returns (uint256 positionId)
    {
        if (entriesPaused) revert EntriesArePaused(); // D4
        Market storage m = markets[marketId];
        if (m.status != Status.Open) revert NotOpen();
        if (outcome >= m.n) revert InvalidOutcomes();
        if (amount == 0) revert InvalidOutcomes();
        // §12 freeze: the market ends at its declared time; a post-freeze entry is
        // refused in full (it would vest into a frozen accumulator and break P1).
        if (block.timestamp >= m.resolutionTime) revert Frozen();
        if (amount < m.minEntry) revert EntryTooSmall(); // D3
        if (m.maxEntry != 0 && amount > m.maxEntry) revert EntryTooLarge(); // D3

        _rollVintage(marketId);
        if (!m.vintageOpen) {
            m.vintageOpen = true;
            m.vintageBlock = uint64(block.number);
        }
        if (m.pending.length >= MAX_VINTAGE_ENTRIES || (m.pending.length + 1) * m.n > MAX_VINTAGE_WORK) {
            revert VintageFull(); // D9: entries and entry-outcome pairs capped; try the next block
        }

        positionId = positions.length;
        positions.push(
            Position({
                marketId: uint64(marketId),
                owner: owner, // D5: `from` when relayed, `msg.sender` otherwise
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
        marketPositionIds[marketId].push(uint64(positionId)); // D6
        // Rule 1: a stake is assigned in full to EVERY opposing branch, so it is demand
        // against every opposing book (§3).
        uint256 n = m.n;
        for (uint256 w = 0; w < n; w++) {
            if (w != outcome) m.books[w].demand += amount;
        }
        emit Entered(marketId, positionId, owner, outcome, amount, uint64(block.number)); // D5: the payer pulls
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
        if (m.vintageOpen) _finalizeVintage(marketId); // D8: even in the last entry's L1 block
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
        if (m.vintageOpen) _finalizeVintage(marketId); // D8: even in the last entry's L1 block
        m.status = Status.Voided;
        emit Voided(marketId);
    }

    // ================================================================== claims (§6, pull-based)

    /// @notice Withdraw the refused remainder of a partial fill (offered − accepted).
    ///         Available once the position's vintage is finalized, before or after
    ///         resolution. `claim` also pays it if still outstanding.
    ///         D2: only the owner may call this form; `withdrawRefundFor` is the same for
    ///         any caller. Both pay the position's owner and nobody else.
    function withdrawRefund(uint256 positionId) external nonReentrant {
        if (positions[positionId].owner != msg.sender) revert NotOwner(); // D2
        _withdrawRefund(positionId); // D2
    }

    /// @notice D2: deliver a position's refused remainder to its OWNER. Anyone may call it
    ///         (the keeper does, so nobody has to come back for a refund). It can never pay
    ///         anyone but `positions[positionId].owner`, and never pays twice.
    function withdrawRefundFor(uint256 positionId) external nonReentrant {
        _withdrawRefund(positionId);
    }

    /// @dev D2: the reference `withdrawRefund` body, paying the owner rather than the caller.
    function _withdrawRefund(uint256 positionId) internal {
        Position storage p = positions[positionId];
        address to = p.owner; // D2: the only possible recipient
        Market storage m = markets[p.marketId];
        if (m.status == Status.Open) _rollVintage(p.marketId);
        if (!p.finalized) revert NotFinalized();
        if (p.refunded) revert NothingToRefund();
        p.refunded = true;
        uint256 refund = p.offered - p.accepted;
        if (refund == 0) revert NothingToRefund();
        emit Claimed(positionId, to, 0, refund); // D2
        _push(m.token, to, refund); // D2
    }

    /// @notice Settle a position after resolution or void. Independent of every other
    ///         position (§6 b): Π_i = s_i·(S + A_ω(T) − A_ω(τ_i)) / S if o_i = ω, else 0;
    ///         on void, s_i. Any un-withdrawn refused remainder is paid alongside.
    ///         D1: a winning claim pays Π_i − fee, fee = ⌊(Π_i − s_i)·feeBps / 10⁴⌋, taken
    ///         from the gain only; losses, voids, refunds and residue carry no fee.
    ///         D2: only the owner may call this form; `claimFor` is the same for any caller.
    function claim(uint256 positionId) external nonReentrant {
        if (positions[positionId].owner != msg.sender) revert NotOwner(); // D2
        _claim(positionId); // D2
    }

    /// @notice D2: deliver a position's settlement (and any refused remainder) to its
    ///         OWNER. Anyone may call it; the keeper pushes every payout this way after
    ///         resolution. It can never pay anyone but `positions[positionId].owner`, and a
    ///         claim that cannot be paid (e.g. a frozen owner) reverts alone.
    function claimFor(uint256 positionId) external nonReentrant {
        _claim(positionId);
    }

    /// @dev D1, D2: the reference `claim` body, paying the owner, net of the fee on the gain.
    function _claim(uint256 positionId) internal {
        Position storage p = positions[positionId];
        address to = p.owner; // D2: the only possible recipient
        if (p.claimed) revert AlreadyClaimed();
        Market storage m = markets[p.marketId];
        if (m.status == Status.Open) revert NotSettled();
        // resolve/void finalized the last vintage, so p.finalized holds here.

        uint256 payout;
        uint256 fee; // D1
        if (m.status == Status.Resolved) {
            if (p.outcome == m.winner && p.accepted > 0) {
                Book storage b = m.books[m.winner];
                payout = (p.accepted * (SCALE + b.acc - p.entryAcc)) / SCALE;
                m.paidOut += payout;
                b.live -= 1;
                fee = ((payout - p.accepted) * m.feeBps) / 10_000; // D1: gain only (payout ≥ s by P2)
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
        if (fee > 0) { // D1: paidOut above stays GROSS, so the residue is the reference's
            feesAccrued[address(m.token)] += fee;
            emit FeeAccrued(positionId, fee);
            payout -= fee; // Claimed.payout is what the owner receives for the settlement
        }
        emit Claimed(positionId, to, payout, refund); // D2
        if (payout + refund > 0) _push(m.token, to, payout + refund); // D2
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

    /// @notice D1: send every accrued fee in `token` to the treasury and zero the balance.
    ///         Anyone may call it; it can pay nobody but `treasury`. It is separate from
    ///         claims on purpose, so a treasury transfer can never make a claim revert.
    ///         A call with nothing accrued does nothing.
    function sweepFees(IERC20 token) external nonReentrant {
        uint256 amount = feesAccrued[address(token)];
        if (amount == 0) return;
        feesAccrued[address(token)] = 0;
        emit FeesSwept(address(token), treasury, amount);
        _push(token, treasury, amount);
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

    /// @notice D6: what a finalized position would be paid (gross of the fee) if its outcome
    ///         won as the books stand now: s·(S + A_o(now) − entryAcc) / S. Never decreases
    ///         while the market is open (P2) and equals `previewPayout` once its outcome has
    ///         won. 0 before the position's vintage is finalized. An entry vintage whose
    ///         block has passed but which nobody has finalized yet is not counted until
    ///         someone calls `finalizeVintage`.
    function accrued(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        if (!p.finalized) return 0;
        uint256 acc = markets[p.marketId].books[p.outcome].acc;
        return (uint256(p.accepted) * (SCALE + acc - p.entryAcc)) / SCALE;
    }

    /// @notice D1, D6: the fee a winning claim of this position takes: 0 unless the market
    ///         is resolved and the position is on the winning side. Like `previewPayout`, it
    ///         does not look at whether the position has already been claimed.
    function previewFee(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        Market storage m = markets[p.marketId];
        if (m.status != Status.Resolved || p.outcome != m.winner || !p.finalized) return 0;
        uint256 payout = (p.accepted * (SCALE + m.books[m.winner].acc - p.entryAcc)) / SCALE;
        return ((payout - p.accepted) * m.feeBps) / 10_000;
    }

    /// @notice D1, D3, D6: a market's fee and entry bounds (0 = no bound). `getMarket` keeps the
    ///         reference's twelve fields unchanged, so these are read here.
    function marketTerms(uint256 marketId) external view returns (uint16 feeBps, uint128 minEntry, uint128 maxEntry) {
        Market storage m = markets[marketId];
        return (m.feeBps, m.minEntry, m.maxEntry);
    }

    /// @notice D6: how many positions a market has, seed legs included.
    function marketPositionCount(uint256 marketId) external view returns (uint256) {
        return marketPositionIds[marketId].length;
    }

    /// @notice D6: up to `count` of a market's position ids (global ids, seed legs first, then
    ///         entries in arrival order), starting at index `from`. Empty past the end.
    function marketPositions(uint256 marketId, uint256 from, uint256 count)
        external
        view
        returns (uint256[] memory ids)
    {
        uint64[] storage all = marketPositionIds[marketId];
        uint256 len = all.length;
        if (from >= len) return new uint256[](0);
        uint256 end = count < len - from ? from + count : len;
        ids = new uint256[](end - from);
        for (uint256 i = from; i < end; i++) ids[i - from] = all[i];
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
