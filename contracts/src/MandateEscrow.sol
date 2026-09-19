// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TokenInterfaces.sol";
import "./SettlementRegistry.sol";

/// @notice Buyer-funded escrow. Only the buyer refunds; only the operator settles.
contract MandateEscrow {
    using SafeToken for IERC20;
    IERC20 public immutable paymentToken;
    SettlementRegistry public immutable registry;
    address public immutable admin;
    address public immutable operator;
    address public immutable operatorTreasury;
    address public immutable burnReserve;
    bool public paused;
    uint256 private entered;
    mapping(bytes32 => address) public buyers;
    mapping(bytes32 => uint256) public available;
    mapping(bytes32 => bool) public released;

    event Deposited(bytes32 indexed mandateId, address indexed buyer, uint256 amount);
    event Refunded(bytes32 indexed mandateId, address indexed buyer, uint256 amount);
    event Released(bytes32 indexed settlementId, bytes32 indexed mandateId, address indexed user,
        uint256 gross, uint256 directCosts, uint256 contributorAmount, uint256 burnAmount, uint256 operatorAmount);
    event PauseChanged(bool paused);

    modifier nonReentrant() {
        require(entered == 0, "REENTRANCY");
        entered = 1;
        _;
        entered = 0;
    }

    constructor(IERC20 paymentToken_, SettlementRegistry registry_, address admin_, address operator_,
        address operatorTreasury_, address burnReserve_) {
        require(address(paymentToken_).code.length > 0 && address(registry_).code.length > 0, "INVALID_CONTRACT");
        require(admin_ != address(0) && operator_ != address(0) && operatorTreasury_ != address(0)
            && burnReserve_ != address(0), "ZERO_ADDRESS");
        paymentToken = paymentToken_;
        registry = registry_;
        admin = admin_;
        operator = operator_;
        operatorTreasury = operatorTreasury_;
        burnReserve = burnReserve_;
    }

    function setPaused(bool paused_) external {
        require(msg.sender == admin, "NOT_ADMIN");
        paused = paused_;
        emit PauseChanged(paused_);
    }

    function deposit(bytes32 mandateId, uint256 amount) external nonReentrant {
        _deposit(mandateId, amount);
    }

    function createMandate(bytes32 mandateHash, address token, uint256 amount) external nonReentrant {
        require(token == address(paymentToken), "WRONG_PAYMENT_TOKEN");
        require(buyers[mandateHash] == address(0), "MANDATE_EXISTS");
        _deposit(mandateHash, amount);
    }

    function fundMandate(bytes32 mandateId, uint256 amount) external nonReentrant {
        require(buyers[mandateId] != address(0), "UNKNOWN_MANDATE");
        _deposit(mandateId, amount);
    }

    function _deposit(bytes32 mandateId, uint256 amount) private {
        require(!paused, "PAUSED");
        require(mandateId != bytes32(0) && amount > 0, "INVALID_DEPOSIT");
        address buyer = buyers[mandateId];
        require(buyer == address(0) || buyer == msg.sender, "DIFFERENT_BUYER");
        buyers[mandateId] = msg.sender;
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        require(paymentToken.balanceOf(address(this)) == beforeBalance + amount, "UNSUPPORTED_PAYMENT_TOKEN");
        available[mandateId] += amount;
        emit Deposited(mandateId, msg.sender, amount);
    }

    /// @notice Available funds remain refundable during pause; funds cannot cross mandates.
    function refund(bytes32 mandateId, uint256 amount) external nonReentrant {
        require(msg.sender == buyers[mandateId], "NOT_BUYER");
        require(amount > 0 && amount <= available[mandateId], "INSUFFICIENT_ESCROW");
        available[mandateId] -= amount;
        paymentToken.safeTransfer(msg.sender, amount);
        emit Refunded(mandateId, msg.sender, amount);
    }

    function release(bytes32 licenseHash, bytes32 mandateId, address user, uint256 gross,
        uint256 directCosts, bytes32 commitment) external nonReentrant {
        require(!paused, "PAUSED");
        require(msg.sender == operator, "NOT_OPERATOR");
        require(user != address(0) && licenseHash != bytes32(0), "ZERO_ADDRESS_OR_ID");
        require(!released[licenseHash], "SETTLEMENT_REPLAY");
        require(gross > 0 && gross <= available[mandateId], "INSUFFICIENT_ESCROW");
        require(directCosts <= gross, "INVALID_COSTS");
        (uint256 u, uint256 b, uint256 o) = registry.split(gross - directCosts);
        released[licenseHash] = true;
        available[mandateId] -= gross;
        registry.record(licenseHash, mandateId, commitment, gross, directCosts, u, b, o);
        if (u > 0) paymentToken.safeTransfer(user, u);
        if (o + directCosts > 0) paymentToken.safeTransfer(operatorTreasury, o + directCosts);
        if (b > 0) paymentToken.safeTransfer(burnReserve, b);
        emit Released(licenseHash, mandateId, user, gross, directCosts, u, b, o);
    }

    function anchorBatch(bytes32 batchId, bytes32 root, uint256 gross, uint256 directCosts,
        uint256 contributorAmount, uint256 burnAmount, uint256 operatorAmount) external {
        require(msg.sender == operator && !paused, "NOT_AUTHORIZED");
        registry.anchorBatch(batchId, root, gross, directCosts, contributorAmount, burnAmount, operatorAmount);
    }
}
