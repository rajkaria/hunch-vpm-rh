// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "./VestedParimutuel.sol";

/// @title  Naive Vested Parimutuel — the §4.1 loop form, for gas measurement ONLY
/// @notice Rule 1 written as the paper first states it: on every accepted stake, loop
///         over every position on every opposing book and credit each one its pro-rata
///         share. O(book size) per entry. This exists so GAS.md can put a measured
///         number next to §6's "tens of millions of gas" claim; it is not a reference
///         (no block vintages, no rationing, no residue owner, single-market, no freeze).
contract NaiveVestedParimutuel {
    struct Pos {
        address owner;
        uint8 outcome;
        uint128 stake;  // packed with `vested`: one slot per position on the vesting loop
        uint128 vested;
    }

    IERC20 public immutable token;
    uint256 public immutable kappa;
    uint8 public immutable n;
    Pos[] public positions;
    uint256[][] internal book; // position ids per outcome
    uint256[] public principal; // P_w
    uint256[] public capacity; // C_w
    uint256[] public vestedIn; // V_w
    uint8 public winner;
    bool public resolved;

    constructor(IERC20 token_, uint256 kappa_, uint256[] memory seed) {
        token = token_;
        kappa = kappa_;
        n = uint8(seed.length);
        for (uint256 o = 0; o < seed.length; o++) {
            book.push();
            principal.push(0);
            capacity.push(0);
            vestedIn.push(0);
        }
        // symmetric seed only (measurement harness): legs vest into each other
        for (uint256 o = 0; o < seed.length; o++) {
            positions.push(Pos(msg.sender, uint8(o), uint128(seed[o]), 0));
            book[o].push(positions.length - 1);
            principal[o] = seed[o];
            capacity[o] = kappa * seed[o];
        }
        for (uint256 o = 0; o < seed.length; o++) {
            for (uint256 w = 0; w < seed.length; w++) {
                if (w == o) continue;
                positions[book[w][0]].vested += uint128(seed[o]);
                vestedIn[w] += seed[o];
            }
        }
    }

    /// @notice Rule 1 + Rule 2 in the loop form; every transaction is its own vintage.
    function enter(uint8 outcome, uint256 amount) external returns (uint256 id) {
        uint256 a = amount;
        for (uint256 w = 0; w < n; w++) {
            if (w == outcome) continue;
            uint256 h = capacity[w] > vestedIn[w] ? capacity[w] - vestedIn[w] : 0;
            if (h < a) a = h;
        }
        // the loop the accumulator removes: one storage write per opposing position
        for (uint256 w = 0; w < n; w++) {
            if (w == outcome || a == 0) continue;
            uint256[] storage ids = book[w];
            uint256 P = principal[w];
            uint256 len = ids.length;
            for (uint256 i = 0; i < len; i++) {
                Pos storage q = positions[ids[i]];
                q.vested += uint128((a * q.stake) / P);
            }
            vestedIn[w] += a;
        }
        id = positions.length;
        positions.push(Pos(msg.sender, outcome, uint128(a), 0));
        book[outcome].push(id);
        principal[outcome] += a;
        capacity[outcome] += kappa * a;
        require(token.transferFrom(msg.sender, address(this), amount), "pull");
        if (amount > a) require(token.transfer(msg.sender, amount - a), "refund");
    }

    function bookSize(uint8 outcome) external view returns (uint256) {
        return book[outcome].length;
    }
}
