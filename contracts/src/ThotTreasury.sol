// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./ThotCampaignReserve.sol";
import "./ThotStakingPool.sol";

/// Single launch-funding address. Acquisition budgets stay here; admitted staking
/// obligations are isolated in the bound pool. Governance may recycle unused
/// budgets, never participant principal or promised rewards. Fresh deployments only.
contract ThotTreasury is ThotCampaignReserve {
    using SafeToken for IERC20;

    ThotStakingPool public stakingPool;
    event StakingPoolBound(address indexed pool);
    event StakingBudgetFunded(uint256 indexed campaignId, uint256 amount);
    event StakingBudgetReturned(uint256 amount);

    constructor(address token_, address governor_, address operator_)
        ThotCampaignReserve(token_, governor_, operator_) {
        require(operator_ != address(0), "OPERATOR");
        // Governance membership and direct purchasing permission are separate.
        address[] memory owners = IThotCampaignGovernor(governor_).getOwners();
        for (uint256 i; i < owners.length; ++i) {
            authorizedBuyers[owners[i]] = false;
            emit BuyerAuthorizationChanged(owners[i], false);
        }
    }

    function reserveVersion() external pure override returns (uint256) { return 3; }

    // Binding verifies identity, not launch inventory. Each campaign independently
    // checks funding. The inherited RESERVE getter describes the legacy v2 cap only.
    function _initialFundingRequired() internal pure override returns (uint256) { return 0; }

    /// Unlike v2 there is no hard-coded acquisition lifetime cap: governance may
    /// allocate any actual uncommitted inventory, including returned purchases.
    /// Returns do not replenish an existing campaign's gross spending authority.
    function unallocatedBalance() public view override returns (uint256) {
        uint256 inventory = token.balanceOf(address(this));
        return inventory > totalAllocated ? inventory - totalAllocated : 0;
    }

    function bindStakingPool(address pool_) external onlyGovernor {
        require(address(stakingPool) == address(0) && pool_.code.length > 0, "POOL");
        ThotStakingPool candidate = ThotStakingPool(pool_);
        require(address(candidate.token()) == address(token) && candidate.governor() == address(this), "POOL_BINDING");
        stakingPool = candidate;
        emit StakingPoolBound(pool_);
    }

    /// Atomic funding and admission policy. Existing positions never read these
    /// future terms: each position has its reward and maturity snapshotted.
    function createStakingCampaign(uint64 startsAt, uint64 enrollmentEndsAt,
        uint256 principalCap, uint256 rewardBudget, ThotStakingPool.Term[] calldata terms)
        external onlyGovernor nonReentrant returns (uint256 campaignId)
    {
        require(address(stakingPool) != address(0), "POOL_NOT_BOUND");
        require(rewardBudget > 0 && rewardBudget <= unallocatedBalance(), "ALLOCATION_CAP");
        uint256 beforeTreasury = token.balanceOf(address(this));
        uint256 beforePool = token.balanceOf(address(stakingPool));
        token.safeTransfer(address(stakingPool), rewardBudget);
        require(token.balanceOf(address(this)) == beforeTreasury - rewardBudget
            && token.balanceOf(address(stakingPool)) == beforePool + rewardBudget, "EXACT_TRANSFER");
        campaignId = stakingPool.createCampaign(startsAt, enrollmentEndsAt, principalCap, rewardBudget, terms);
        emit StakingBudgetFunded(campaignId, rewardBudget);
    }

    function setStakingAdmissionsPaused(uint256 campaignId, bool value) external onlyGovernor {
        stakingPool.setAdmissionsPaused(campaignId, value);
    }

    /// Closing stops new deposits and frees only the unallocated reward budget.
    /// Existing positions remain fully claimable on their original schedule.
    function closeStakingCampaign(uint256 campaignId) external onlyGovernor nonReentrant {
        stakingPool.closeCampaign(campaignId);
        _returnFreeStakingBudget();
    }

    /// Also collects free inventory after permissionless expiry or donations.
    function collectFreeStakingBudget() external onlyGovernor nonReentrant {
        require(address(stakingPool) != address(0), "POOL_NOT_BOUND");
        _returnFreeStakingBudget();
    }

    function _returnFreeStakingBudget() private {
        uint256 amount = stakingPool.freeBalance();
        if (amount == 0) return;
        stakingPool.recoverFreeTokens(address(this), amount);
        emit StakingBudgetReturned(amount);
    }
}
