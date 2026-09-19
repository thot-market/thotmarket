// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Router choice, quotes, limits, and deployment addresses are production decisions.
interface IBurnExecutor {
    event BurnExecuted(bytes32 indexed burnId, uint256 amountIn, uint256 thotBurned);
    function executeBurn(bytes32 burnId, uint256 amountIn, uint256 minThotOut, uint256 deadline)
        external returns (uint256 thotBurned);
}
