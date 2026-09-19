// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TokenInterfaces.sol";
import "./IBurnExecutor.sol";

/// @notice TEST ONLY. Uses pre-funded THOT inventory at a fixed ratio; this is not a DEX.
contract MockBurnExecutor is IBurnExecutor {
    using SafeToken for IERC20;
    bool public constant isMock = true;
    IERC20 public immutable paymentToken;
    IBurnableToken public immutable thotToken;
    address public immutable operator;
    address public immutable mockPaymentSink;
    uint256 public immutable numerator;
    uint256 public immutable denominator;
    bool public failing;
    bool private entered;
    mapping(bytes32 => bool) public executed;

    constructor(IERC20 paymentToken_, IBurnableToken thotToken_, address operator_, address sink_,
        uint256 numerator_, uint256 denominator_) {
        require(address(paymentToken_).code.length > 0 && address(thotToken_).code.length > 0, "INVALID_TOKEN");
        require(operator_ != address(0) && sink_ != address(0), "ZERO_ADDRESS");
        require(numerator_ > 0 && denominator_ > 0, "INVALID_RATE");
        paymentToken = paymentToken_; thotToken = thotToken_; operator = operator_; mockPaymentSink = sink_;
        numerator = numerator_; denominator = denominator_;
    }

    function setFailing(bool failing_) external {
        require(msg.sender == operator, "NOT_OPERATOR");
        failing = failing_;
    }

    function executeBurn(bytes32 burnId, uint256 amountIn, uint256 minThotOut, uint256 deadline)
        external returns (uint256 thotBurned) {
        require(msg.sender == operator, "NOT_OPERATOR");
        require(!entered, "REENTRANCY");
        require(!failing, "MOCK_SWAP_FAILED");
        require(burnId != bytes32(0) && !executed[burnId], "BURN_REPLAY");
        require(amountIn > 0 && minThotOut > 0 && block.timestamp <= deadline, "INVALID_BURN");
        thotBurned = amountIn * numerator / denominator;
        require(thotBurned >= minThotOut, "SLIPPAGE");
        entered = true;
        executed[burnId] = true;
        paymentToken.safeTransfer(mockPaymentSink, amountIn);
        thotToken.burn(thotBurned);
        entered = false;
        emit BurnExecuted(burnId, amountIn, thotBurned);
    }
}
