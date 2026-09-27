// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  MockSettler: records what a resolver asks of a settler
/// @notice Serves `getMarket` from values the test sets and records `resolve` / `voidMarket`
///         calls, enforcing what HunchVPM enforces (resolver only, at or after the freeze,
///         market still open). Used by the resolver suites and the fork proof (T5f), where the
///         resolver is exercised without a real settler.
contract MockSettler {
    struct M {
        address creator;
        address resolver;
        uint64 resolutionTime;
        uint8 n;
        uint8 status; // 0 open, 1 resolved, 2 voided
        uint8 winner;
    }

    mapping(uint256 => M) public markets;
    uint256 public calls;

    error NotResolver();
    error TooEarly();
    error NotOpen();

    function setMarket(uint256 id, address creator, address resolver, uint64 resolutionTime, uint8 n) external {
        markets[id] =
            M({creator: creator, resolver: resolver, resolutionTime: resolutionTime, n: n, status: 0, winner: 0});
    }

    function setStatus(uint256 id, uint8 status) external {
        markets[id].status = status;
    }

    function getMarket(uint256 id)
        external
        view
        returns (
            address token,
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
        M memory m = markets[id];
        return (address(0), m.creator, m.resolver, address(0), m.resolutionTime, 0, m.n, m.status, m.winner, 0, 0, 0);
    }

    function resolve(uint256 id, uint8 winner) external {
        M storage m = markets[id];
        _check(m);
        m.status = 1;
        m.winner = winner;
        calls++;
    }

    function voidMarket(uint256 id) external {
        M storage m = markets[id];
        _check(m);
        m.status = 2;
        calls++;
    }

    function _check(M storage m) internal view {
        if (msg.sender != m.resolver) revert NotResolver();
        if (block.timestamp < m.resolutionTime) revert TooEarly();
        if (m.status != 0) revert NotOpen();
    }
}
