// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {IHunchSettler} from "./interfaces/IHunchSettler.sol";

/// @title  StockRoundResolver — UP / DOWN from two proven Chainlink rounds
/// @notice Settles a binary stock market on the price IN EFFECT at each bell: the answer of
///         the last Chainlink round with `updatedAt ≤ T`, for T = the strike time (e.g. the
///         opening bell) and T = the final time (the closing bell, which is also the market's
///         freeze). Whoever calls, and whenever they call, the answer is the same: the caller
///         names the two round ids and the contract proves each is "the last round at or
///         before T" from the feed itself. The caller chooses nothing.
///
///         Outcomes: final > strike → UP (settler outcome 0); final < strike → DOWN (1);
///         the same round, or equal answers → FLAT, which voids the market (full refunds).
///         A reading older than the spec's age bound makes the market refundable through
///         `voidStale` (never through `resolve`, so a mistaken call cannot destroy a good
///         market). Robinhood's corporate-action flag (`oraclePaused()` on the Stock Token)
///         blocks resolution; if it is still set 24 h after the bell, `voidPaused` refunds.
///
///         There is no owner, no admin and no price input. A spec is immutable once
///         registered (its id is its hash), and only a market's creator can register it.
///
///         When Chainlink moves a feed to a new aggregator, the old and the new one report in
///         parallel for a while and the proxy then serves both histories, as phase p and
///         phase p + 1. "The last round at or before T" is therefore taken in the HIGHEST phase
///         that has any round at or before T (the newest aggregator that had reported by T),
///         so exactly one pair of rounds proves at any moment, however the phases overlap.
/// @dev    Round ids are proxy ids, `(phaseId << 64) | aggregatorRoundId`; "the next round" of
///         x is x + 1 in the same phase. Every feed read is a `staticcall` whose failure, short
///         return data, mismatched id or `updatedAt == 0` means "absent", so a feed that
///         reverts "No data present" and one that returns zeros are handled alike, and
///         `preview` never reverts. Soundness assumes what Chainlink guarantees: within a
///         phase, round ids are consecutive from 1 and `updatedAt` is non-decreasing, and a
///         round's `updatedAt` is the time it was written on this chain. Resolution requires
///         `block.timestamp > finalTime` (strictly), so no round written after the call can
///         carry `updatedAt ≤ finalTime`. The one exception is an aggregator confirmed behind
///         the proxy after the bell that had already reported before it: from its confirmation
///         on, its rounds are the ones in effect (the rule above), so the pair that proves can
///         change at that moment; the first settlement is final.
contract StockRoundResolver {
    // ------------------------------------------------------------------ types

    /// @param settler      the HunchVPM holding the market
    /// @param marketId     its market id
    /// @param feed         the Chainlink AggregatorV3 proxy (standard, not SVR) pricing the token
    /// @param stockToken   the Robinhood Stock Token the feed prices, for `oraclePaused()`
    /// @param strikeTime   T_s, e.g. the opening bell (unix seconds)
    /// @param finalTime    T_f, the closing bell; must equal the market's resolution time
    /// @param maxStrikeAge T_s − updatedAt(strike round) may be at most this
    /// @param maxFinalAge  T_f − updatedAt(final round) may be at most this
    struct Spec {
        address settler;
        uint256 marketId;
        address feed;
        address stockToken;
        uint64 strikeTime;
        uint64 finalTime;
        uint32 maxStrikeAge;
        uint32 maxFinalAge;
    }

    /// @dev A round the resolver has proven, with its answer and its `updatedAt`.
    struct Reading {
        int256 answer;
        uint256 at;
    }

    /// @dev Result of checking "x is the last round at or before T".
    enum Proof {
        Ok,
        BadProof,
        BadAnswer,
        PhaseBoundary
    }

    // ------------------------------------------------------------------ constants

    /// @notice `Resolved.outcome` values. UP and DOWN are also the settler's outcome indices.
    uint8 public constant UP = 0;
    uint8 public constant DOWN = 1;
    uint8 public constant FLAT = 2;

    /// @notice `preview` statuses.
    uint8 public constant STATUS_NOT_READY = 0;
    uint8 public constant STATUS_UP = 1;
    uint8 public constant STATUS_DOWN = 2;
    uint8 public constant STATUS_FLAT = 3;
    uint8 public constant STATUS_STALE = 4;
    uint8 public constant STATUS_BAD_PROOF = 5;
    uint8 public constant STATUS_PAUSED = 6;

    /// @notice Sanity band for a proven answer: 0 < answer < 1e14 (i.e. below $1,000,000 at 8
    ///         decimals). Early rounds of some Robinhood Chain feeds hold 18-decimal garbage,
    ///         so a historical round is never trusted blindly.
    int256 public constant MAX_ANSWER = 1e14;

    /// @notice How long after the final time an oracle pause must persist before anyone may
    ///         void the market with `voidPaused`.
    uint256 public constant PAUSE_GRACE = 24 hours;

    /// @notice The most feed phases a proof looks above its round's phase. Proving round x of
    ///         phase p reads the first round of every phase from p + 1 to the proxy's current
    ///         phase; a round more than this many phases below the current one is refused
    ///         (`PhaseBoundary`), which bounds the reads. Chainlink adds a phase only when it
    ///         moves a feed to a new aggregator, so this never binds in practice.
    uint256 public constant MAX_PHASE_SPAN = 8;

    // ------------------------------------------------------------------ state

    mapping(bytes32 => Spec) internal specs;
    /// @notice True once a spec has resolved or voided its market through this contract.
    mapping(bytes32 => bool) public settled;
    /// @notice The spec registered for a settler's market (zero if none). One per market.
    mapping(address => mapping(uint256 => bytes32)) public specIdOf;

    // ------------------------------------------------------------------ events

    event Registered(
        bytes32 indexed specId,
        address indexed settler,
        uint256 indexed marketId,
        address feed,
        address stockToken,
        uint64 strikeTime,
        uint64 finalTime,
        uint32 maxStrikeAge,
        uint32 maxFinalAge
    );
    event Resolved(
        bytes32 indexed specId,
        uint256 indexed marketId,
        uint8 outcome, // 0 UP, 1 DOWN, 2 FLAT (voided)
        uint80 strikeRound,
        int256 strikeAnswer,
        uint256 strikeAt,
        uint80 finalRound,
        int256 finalAnswer,
        uint256 finalAt
    );
    event VoidedStale(bytes32 indexed specId, uint256 indexed marketId, uint80 strikeRound, uint80 finalRound);
    event VoidedPaused(bytes32 indexed specId, uint256 indexed marketId);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error BadTimes();
    error NotBinary();
    error MarketNotOpen();
    error WrongResolver();
    error WrongFinalTime();
    error NotCreator();
    error AlreadyRegistered();
    error UnknownSpec();
    error AlreadySettled();
    error TooEarly();
    error BadProof();
    error BadAnswer();
    error PhaseBoundary();
    error OraclePaused();
    error Stale();
    error NotStale();
    error NotPaused();

    // ================================================================== registration

    /// @notice Record how a market resolves. Only the market's creator may call it (the
    ///         factory, in the same transaction that creates the market), and only for a
    ///         binary, open market that named this contract as its resolver with a
    ///         resolution time equal to `finalTime`. One spec per market, never editable.
    ///         Registering grants nothing: the outcome still comes only from the feed.
    /// @return specId keccak256(abi.encode(spec))
    function register(Spec calldata spec) external returns (bytes32 specId) {
        if (spec.settler == address(0) || spec.feed == address(0) || spec.stockToken == address(0)) {
            revert ZeroAddress();
        }
        if (spec.strikeTime >= spec.finalTime) revert BadTimes();
        (, address creator, address resolver,, uint64 resolutionTime,, uint8 n, uint8 status,,,,) =
            IHunchSettler(spec.settler).getMarket(spec.marketId);
        if (resolver != address(this)) revert WrongResolver();
        if (resolutionTime != spec.finalTime) revert WrongFinalTime();
        if (n != 2) revert NotBinary();
        if (status != 0) revert MarketNotOpen();
        if (creator != msg.sender) revert NotCreator();
        if (specIdOf[spec.settler][spec.marketId] != bytes32(0)) revert AlreadyRegistered();

        specId = keccak256(abi.encode(spec));
        specs[specId] = spec;
        specIdOf[spec.settler][spec.marketId] = specId;
        emit Registered(
            specId,
            spec.settler,
            spec.marketId,
            spec.feed,
            spec.stockToken,
            spec.strikeTime,
            spec.finalTime,
            spec.maxStrikeAge,
            spec.maxFinalAge
        );
    }

    // ================================================================== settlement

    /// @notice Settle a market from two proven rounds. Anyone may call it, strictly after
    ///         `finalTime`, once. `strikeRound` must be the round in effect at strikeTime and
    ///         `finalRound` the one in effect at finalTime: the last round with updatedAt ≤ T
    ///         of the highest feed phase that has any round with updatedAt ≤ T (else
    ///         `BadProof`, `BadAnswer` or `PhaseBoundary`). Reverts `OraclePaused` while the
    ///         Stock Token's oracle is paused and `Stale` if a reading exceeds its age bound
    ///         (use `voidStale`). Otherwise resolves UP or DOWN, or voids on FLAT. The caller
    ///         cannot choose the outcome and gains nothing by calling.
    function resolve(bytes32 specId, uint80 strikeRound, uint80 finalRound) external {
        Spec memory s = _unsettled(specId);
        (Reading memory strike, Reading memory fin) = _proveBoth(s, strikeRound, finalRound);
        if (_oraclePaused(s.stockToken)) revert OraclePaused();
        if (_stale(s, strike, fin)) revert Stale();

        settled[specId] = true;
        uint8 outcome = _outcome(strikeRound, finalRound, strike, fin);
        emit Resolved(
            specId, s.marketId, outcome, strikeRound, strike.answer, strike.at, finalRound, fin.answer, fin.at
        );
        if (outcome == FLAT) IHunchSettler(s.settler).voidMarket(s.marketId);
        else IHunchSettler(s.settler).resolve(s.marketId, outcome);
    }

    /// @notice Void (refund) a market whose proven reading is too old. Anyone may call it,
    ///         strictly after `finalTime`, with the same two proofs as `resolve`; it reverts
    ///         `NotStale` unless an age bound is actually exceeded, so nobody can void a
    ///         market that has a good answer.
    function voidStale(bytes32 specId, uint80 strikeRound, uint80 finalRound) external {
        Spec memory s = _unsettled(specId);
        (Reading memory strike, Reading memory fin) = _proveBoth(s, strikeRound, finalRound);
        if (!_stale(s, strike, fin)) revert NotStale();

        settled[specId] = true;
        emit VoidedStale(specId, s.marketId, strikeRound, finalRound);
        IHunchSettler(s.settler).voidMarket(s.marketId);
    }

    /// @notice Void (refund) a market whose Stock Token oracle is still paused (Robinhood's
    ///         corporate-action flag) 24 h after `finalTime`. Anyone may call it; it reverts
    ///         `NotPaused` if the flag has cleared (then `resolve` works). An unreadable flag
    ///         counts as paused.
    function voidPaused(bytes32 specId) external {
        Spec memory s = _spec(specId);
        if (settled[specId]) revert AlreadySettled();
        if (block.timestamp < uint256(s.finalTime) + PAUSE_GRACE) revert TooEarly();
        if (!_oraclePaused(s.stockToken)) revert NotPaused();

        settled[specId] = true;
        emit VoidedPaused(specId, s.marketId);
        IHunchSettler(s.settler).voidMarket(s.marketId);
    }

    // ================================================================== views

    /// @notice What `resolve(specId, strikeRound, finalRound)` would do now, without reverting:
    ///         0 not ready (at or before finalTime), 1 UP, 2 DOWN, 3 FLAT (void), 4 STALE (use
    ///         `voidStale`), 5 BADPROOF (a round is not the one in effect at its time, an
    ///         answer is out of band, a later phase has a round at or before the time (phase
    ///         boundary), or an unknown spec), 6 PAUSED. The
    ///         readings are returned whenever both rounds could be read. Anyone may call it;
    ///         it ignores `settled` (read that separately).
    function preview(bytes32 specId, uint80 strikeRound, uint80 finalRound)
        external
        view
        returns (uint8 status, int256 strikeAnswer, uint256 strikeAt, int256 finalAnswer, uint256 finalAt)
    {
        Spec memory s = specs[specId];
        if (s.settler == address(0)) return (STATUS_BAD_PROOF, 0, 0, 0, 0);
        if (block.timestamp <= s.finalTime) return (STATUS_NOT_READY, 0, 0, 0, 0);
        Proof p1;
        Proof p2;
        uint256 latest = _latestRoundId(s.feed);
        (p1, strikeAnswer, strikeAt) = _prove(s.feed, strikeRound, s.strikeTime, latest);
        (p2, finalAnswer, finalAt) = _prove(s.feed, finalRound, s.finalTime, latest);
        if (p1 != Proof.Ok || p2 != Proof.Ok || finalRound < strikeRound) {
            return (STATUS_BAD_PROOF, strikeAnswer, strikeAt, finalAnswer, finalAt);
        }
        Reading memory strike = Reading({answer: strikeAnswer, at: strikeAt});
        Reading memory fin = Reading({answer: finalAnswer, at: finalAt});
        if (_oraclePaused(s.stockToken)) status = STATUS_PAUSED;
        else if (_stale(s, strike, fin)) status = STATUS_STALE;
        else status = _outcome(strikeRound, finalRound, strike, fin) + 1; // UP 0→1, DOWN 1→2, FLAT 2→3
    }

    /// @notice A registered spec (all zero if unknown).
    function getSpec(bytes32 specId) external view returns (Spec memory) {
        return specs[specId];
    }

    // ================================================================== internals

    function _spec(bytes32 specId) internal view returns (Spec memory s) {
        s = specs[specId];
        if (s.settler == address(0)) revert UnknownSpec();
    }

    /// @dev A registered, unsettled spec whose final time has strictly passed.
    function _unsettled(bytes32 specId) internal view returns (Spec memory s) {
        s = _spec(specId);
        if (settled[specId]) revert AlreadySettled();
        if (block.timestamp <= s.finalTime) revert TooEarly();
    }

    function _proveBoth(Spec memory s, uint80 strikeRound, uint80 finalRound)
        internal
        view
        returns (Reading memory strike, Reading memory fin)
    {
        if (finalRound < strikeRound) revert BadProof();
        uint256 latest = _latestRoundId(s.feed); // one read serves both proofs
        Proof p;
        (p, strike.answer, strike.at) = _prove(s.feed, strikeRound, s.strikeTime, latest);
        _requireProof(p);
        (p, fin.answer, fin.at) = _prove(s.feed, finalRound, s.finalTime, latest);
        _requireProof(p);
    }

    function _requireProof(Proof p) internal pure {
        if (p == Proof.BadProof) revert BadProof();
        if (p == Proof.BadAnswer) revert BadAnswer();
        if (p == Proof.PhaseBoundary) revert PhaseBoundary();
    }

    /// @dev Is round `x` of `feed` the round in effect at `t`: the last round with updatedAt ≤ t
    ///      of the HIGHEST phase that has any round with updatedAt ≤ t? `latest` is the proxy's
    ///      latest round id (0 if unreadable), read once by the caller for both proofs.
    ///      (1) x exists, updatedAt(x) ≤ t, and 0 < answer(x) < MAX_ANSWER;
    ///      (2) x's phase p is at most the proxy's current phase P (the phase of `latest`; an
    ///          unreadable latest round proves nothing), and no phase from p + 1 to P has a round
    ///          at or before t: each one's first round is absent or after t (else
    ///          `PhaseBoundary`, as when P is more than MAX_PHASE_SPAN phases above p);
    ///      (3) and x is the last round at or before t of phase p: x + 1 exists with
    ///          updatedAt > t, or x + 1 is absent and x is the proxy's latest round, or x + 1
    ///          is absent, p is an earlier phase and a later phase has printed (its first
    ///          round, after t by (2)). A later phase that has not printed yet leaves the proof
    ///          pending (`BadProof`) until it does.
    ///      Unique: were x (phase p) and y (phase q > p) both accepted, y ≤ t would make the
    ///      first round of phase q at or before t, which (2) refuses for x; within one phase,
    ///      (3) admits only the last round at or before t.
    function _prove(address feed, uint80 x, uint256 t, uint256 latest)
        internal
        view
        returns (Proof, int256 answer, uint256 at)
    {
        bool present;
        (present, answer, at) = _round(feed, x);
        if (!present || at > t) return (Proof.BadProof, answer, at);
        if (answer <= 0 || answer >= MAX_ANSWER) return (Proof.BadAnswer, answer, at);

        // the top 16 bits of a uint80 proxy id are the phase; `latest` is at most a uint80
        uint256 phase = x >> 64;
        uint256 current = latest >> 64;
        if (phase > current) return (Proof.BadProof, answer, at); // incl. an unreadable latest round
        if (current - phase > MAX_PHASE_SPAN) return (Proof.PhaseBoundary, answer, at);
        bool laterPrinted = false;
        for (uint256 q = phase + 1; q <= current; q++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            (bool firstPresent,, uint256 firstAt) = _round(feed, uint80((q << 64) | 1));
            if (firstPresent) {
                if (firstAt <= t) return (Proof.PhaseBoundary, answer, at); // t belongs to phase q
                laterPrinted = true;
            }
        }

        // the low 64 bits are the aggregator round; its last value has no successor in-phase
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint64(x) != type(uint64).max) {
            (bool nextPresent,, uint256 nextAt) = _round(feed, x + 1);
            if (nextPresent) return (nextAt > t ? Proof.Ok : Proof.BadProof, answer, at);
        }
        if (x == latest || laterPrinted) return (Proof.Ok, answer, at);
        return (Proof.BadProof, answer, at);
    }

    /// @dev One round, read without ever reverting. Absent = the call failed, returned short
    ///      data, returned another round id, or has updatedAt == 0.
    function _round(address feed, uint80 id) internal view returns (bool present, int256 answer, uint256 at) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeCall(AggregatorV3Interface.getRoundData, (id)));
        if (!ok || ret.length < 160) return (false, 0, 0);
        uint256 rid;
        (rid, answer,, at,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        if (rid != id || at == 0) return (false, 0, 0);
        present = true;
    }

    /// @dev The proxy's latest round id, or 0 if it cannot be read or is not a uint80 proxy id
    ///      (0 is never a valid round).
    function _latestRoundId(address feed) internal view returns (uint256 id) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeCall(AggregatorV3Interface.latestRoundData, ()));
        if (!ok || ret.length < 160) return 0;
        id = abi.decode(ret, (uint256));
        if (id > type(uint80).max) return 0;
    }

    /// @dev Robinhood's corporate-action flag. If it cannot be read it counts as paused, so a
    ///      market never settles on a price its issuer may have flagged.
    function _oraclePaused(address stockToken) internal view returns (bool) {
        (bool ok, bytes memory ret) = stockToken.staticcall(abi.encodeCall(IStockToken.oraclePaused, ()));
        if (!ok || ret.length < 32) return true;
        return abi.decode(ret, (uint256)) != 0;
    }

    function _stale(Spec memory s, Reading memory strike, Reading memory fin) internal pure returns (bool) {
        return s.strikeTime - strike.at > s.maxStrikeAge || s.finalTime - fin.at > s.maxFinalAge;
    }

    function _outcome(uint80 strikeRound, uint80 finalRound, Reading memory strike, Reading memory fin)
        internal
        pure
        returns (uint8)
    {
        if (strikeRound == finalRound || fin.answer == strike.answer) return FLAT;
        return fin.answer > strike.answer ? UP : DOWN;
    }
}
