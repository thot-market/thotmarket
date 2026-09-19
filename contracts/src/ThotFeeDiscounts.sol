// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import "./TokenInterfaces.sol";
import "./ThotStakingPool.sol";

interface IThotDiscountTreasury {
    function token() external view returns (address);
    function governor() external view returns (address);
    function stakingPool() external view returns (address);
    function reserveVersion() external view returns (uint256);
}

/// Prospective fee reductions, paid solely by foregoing protocol revenue.
/// This contract never holds, mints or transfers reward tokens.
contract ThotFeeDiscounts {
    IERC20 public immutable token;
    ThotStakingPool public immutable staking;
    address public immutable governor;
    uint256 public firstThreshold;
    uint256 public secondThreshold;
    uint16 public firstBps;
    uint16 public secondBps;
    uint256 public version;
    uint256 public lockThreshold;
    uint64 public lockDuration;
    uint16 public lockBps;
    event LockPolicyChanged(uint256 version, uint256 threshold, uint64 duration, uint16 bps);
    event PolicyChanged(uint256 version, uint256 firstThreshold, uint256 secondThreshold, uint16 firstBps, uint16 secondBps);
    constructor(address token_, address staking_, address governor_) {
        require(token_.code.length > 0 && staking_.code.length > 0 && governor_.code.length > 0, "CONTRACTS");
        token = IERC20(token_); staking = ThotStakingPool(staking_); governor = governor_;
        require(address(staking.token()) == token_, "BINDING");
        address poolGovernor = staking.governor();
        if (poolGovernor != governor_) {
            // A shared treasury controls pool budgets, while the same financial
            // governor controls fee policy. Require the complete reciprocal graph.
            IThotDiscountTreasury treasury = IThotDiscountTreasury(poolGovernor);
            require(treasury.reserveVersion() == 3 && treasury.token() == token_
                && treasury.governor() == governor_ && treasury.stakingPool() == staking_, "BINDING");
        }
    }
    function setPolicy(uint256 first, uint256 second, uint16 low, uint16 high) external {
        require(msg.sender == governor, "GOVERNOR");
        require(first > 0 && second > first && low <= high && high <= 3500, "POLICY");
        firstThreshold = first; secondThreshold = second; firstBps = low; secondBps = high; ++version;
        emit PolicyChanged(version, first, second, low, high);
    }
    function setLockPolicy(uint256 threshold, uint64 duration, uint16 bps) external {
        require(msg.sender == governor, "GOVERNOR");
        require(threshold > 0 && duration > 0 && duration <= 730 days && bps <= 3500, "POLICY");
        lockThreshold = threshold; lockDuration = duration; lockBps = bps; ++version;
        emit LockPolicyChanged(version, threshold, duration, bps);
    }
    function lockedQualifyingBalance(address owner) public view returns (uint256 balance) {
        uint256[] memory ids = staking.activePositionIds(owner);
        require(ids.length <= 64, "POSITION_BOUND");
        for (uint256 i; i < ids.length; ++i) {
            (address account,,uint256 principal,,uint64 depositedAt,uint64 unlockAt,bool claimed) = staking.positions(ids[i]);
            require(account == owner && !claimed, "POSITION_BINDING");
            if (unlockAt > block.timestamp && unlockAt - depositedAt >= lockDuration) balance += principal;
        }
    }
    function rateBps(address owner) public view returns (uint256 rate) {
        if (version == 0) return 0;
        uint256 balance = qualifyingBalance(owner);
        rate = secondThreshold > 0 && balance >= secondThreshold ? secondBps
            : firstThreshold > 0 && balance >= firstThreshold ? firstBps : 0;
        if (lockThreshold > 0 && lockBps > rate && lockedQualifyingBalance(owner) >= lockThreshold) rate = lockBps;
    }
    function qualifyingBalance(address owner) public view returns (uint256 balance) {
        balance = token.balanceOf(owner);
        uint256[] memory ids = staking.activePositionIds(owner);
        require(ids.length <= 64, "POSITION_BOUND");
        for (uint256 i; i < ids.length; ++i) {
            (address account,,uint256 principal,,,,bool claimed) = staking.positions(ids[i]);
            require(account == owner && !claimed, "POSITION_BINDING");
            balance += principal;
        }
    }
    function discount(address owner, uint256 fee, uint256 contribution) external view returns (uint256 amount) {
        if (version == 0) return 0;
        uint256 rate = rateBps(owner);
        amount = fee / 10000 * rate + fee % 10000 * rate / 10000;
        // Reserve the maximum existing referral and the full direct cost. Each
        // side has its own half, so one party's eligibility never changes the other.
        uint256 referral = contribution / 5;
        uint256 ceiling = (contribution - referral) / 2;
        if (amount > ceiling) amount = ceiling;
    }
}
