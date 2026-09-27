// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  The ERC-20 surface the market factory needs
/// @notice The settler's own `IERC20` is deliberately minimal (transfer, transferFrom). The
///         factory also approves the settler and reads its own balance, so it sees the
///         settlement token through this wider view of the same address. USDG returns `true`
///         on success and reverts on failure; a `false` return is still treated as failure.
interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);
}
