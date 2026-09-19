// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./TokenInterfaces.sol";

/// Non-transferable principal custody. No owner, sweep, yield, or early exit.
/// Supports the fixed 18-decimal ERC20 selected for THOT; fee/rebase tokens are unsupported.
contract ThotLockVault {
    using SafeToken for IERC20;
    IERC20 public immutable token;
    uint256 public constant MIN_TERM = 90 days;
    uint256 public constant SEASONING = 7 days;
    uint256 public constant MIN_REMAINING = 10 days;
    uint256 public constant MAX_ACTIVE_LOTS = 64;
    struct Lot { uint256 amount; uint64 depositedAt; uint64 unlockAt; }
    mapping(address => Lot[]) private _lots;
    uint256 public totalPrincipal;
    uint256 private entered;
    event Locked(address indexed owner, uint256 indexed lotId, uint256 amount, uint64 unlockAt);
    event Extended(address indexed owner, uint256 indexed lotId, uint64 unlockAt);
    event Withdrawn(address indexed owner, uint256 indexed lotId, uint256 amount);
    modifier nonReentrant() { require(entered == 0, "REENTRANT"); entered = 1; _; entered = 0; }
    constructor(address token_) { require(token_.code.length > 0, "TOKEN"); token = IERC20(token_); }
    function lotCount(address owner) external view returns (uint256) { return _lots[owner].length; }
    function lot(address owner, uint256 index) external view returns (Lot memory) { return _lots[owner][index]; }
    function deposit(uint256 amount, uint64 unlockAt) external nonReentrant returns (uint256 lotId) {
        require(amount > 0 && unlockAt >= block.timestamp + MIN_TERM, "TERM_OR_AMOUNT");
        // Reuse a withdrawn slot without inheriting its seasoning. Bound all eligibility reads.
        Lot[] storage lots = _lots[msg.sender];
        lotId = lots.length;
        for (uint256 i; i < lots.length; ++i) if (lots[i].amount == 0) { lotId = i; break; }
        require(lotId < MAX_ACTIVE_LOTS, "LOT_LIMIT");
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "EXACT_TRANSFER");
        Lot memory next = Lot(amount, uint64(block.timestamp), unlockAt);
        if (lotId == lots.length) lots.push(next); else lots[lotId] = next;
        totalPrincipal += amount;
        emit Locked(msg.sender, lotId, amount, unlockAt);
    }
    function extend(uint256 lotId, uint64 unlockAt) external {
        Lot storage item = _lots[msg.sender][lotId];
        require(item.amount > 0 && block.timestamp < item.unlockAt && unlockAt > item.unlockAt, "EXTENSION");
        item.unlockAt = unlockAt;
        emit Extended(msg.sender, lotId, unlockAt);
    }
    function withdraw(uint256 lotId) external nonReentrant {
        Lot storage item = _lots[msg.sender][lotId];
        require(item.amount > 0 && block.timestamp >= item.unlockAt, "LOCKED");
        uint256 amount = item.amount;
        item.amount = 0;
        totalPrincipal -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, lotId, amount);
    }
    function qualifiedBalance(address owner) public view returns (uint256 amount) {
        Lot[] storage lots = _lots[owner];
        for (uint256 i; i < lots.length; ++i) {
            Lot storage item = lots[i];
            if (block.timestamp >= uint256(item.depositedAt) + SEASONING &&
                item.unlockAt >= block.timestamp + MIN_REMAINING) amount += item.amount;
        }
    }
    /// Compatibility ceilings only. Actual sale proceeds come from the market's
    /// quoted cost tariff. Custodied principal supplies no spendable working capital.
    function sellerBps(address) external pure returns (uint16) { return 10_000; }
    function referralBps(address) external pure returns (uint16) { return 2_000; }
    function sellerBpsFor(uint256) public pure returns (uint16) { return 10_000; }
    function referralBpsFor(uint256) public pure returns (uint16) { return 2_000; }
}
