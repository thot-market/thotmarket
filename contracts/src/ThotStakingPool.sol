// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./TokenInterfaces.sol";

/// Fixed-term, non-transferable THOT positions with rewards funded before enrollment.
/// This is a separate pool: it does not spend the trace-acquisition reserve or mint tokens.
/// New campaigns may offer different terms. Admitted positions and campaign terms are immutable.
/// The immutable controller supplies the governance approval policy; this pool adds no delay.
/// Only fixed-balance, exact-transfer ERC20 tokens are supported, never fee/rebase tokens.
contract ThotStakingPool {
    using SafeToken for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_TERMS = 8;
    uint256 public constant MAX_ACTIVE_POSITIONS = 64;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 730 days;

    IERC20 public immutable token;
    address public immutable governor;

    struct Term { uint64 duration; uint16 rewardBps; }
    struct Campaign {
        uint64 startsAt;
        uint64 enrollmentEndsAt;
        uint256 principalCap;
        uint256 totalDeposited;
        uint256 rewardBudget;
        uint256 unallocatedReward;
        uint256 outstandingReward;
        bool admissionsPaused;
        bool closed;
    }
    struct Position {
        address owner;
        uint256 campaignId;
        uint256 principal;
        uint256 reward;
        uint64 depositedAt;
        uint64 unlockAt;
        bool claimed;
    }

    uint256 public campaignCount;
    uint256 public positionCount;
    uint256 public totalPrincipal;
    uint256 public totalRewardLiability;
    uint256 public totalUnallocatedRewards;
    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => Term[]) private _terms;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) private _activePositions;
    mapping(uint256 => uint256) private _positionIndex;
    uint256 private entered;

    event Funded(address indexed sponsor, uint256 amount);
    event CampaignCreated(uint256 indexed campaignId, uint64 startsAt, uint64 enrollmentEndsAt,
        uint256 principalCap, uint256 rewardBudget);
    event TermCommitted(uint256 indexed campaignId, uint256 indexed termIndex, uint64 duration, uint16 rewardBps);
    event AdmissionsPaused(uint256 indexed campaignId, bool paused);
    event CampaignClosed(uint256 indexed campaignId, uint256 unusedRewardReleased);
    event Staked(address indexed owner, uint256 indexed positionId, uint256 indexed campaignId,
        uint256 termIndex, uint256 principal, uint256 reward, uint64 unlockAt);
    event Claimed(address indexed owner, uint256 indexed positionId, uint256 principal, uint256 reward);
    event FreeTokensRecovered(address indexed recipient, uint256 amount);

    modifier onlyGovernor() { require(msg.sender == governor, "GOVERNOR"); _; }
    modifier nonReentrant() { require(entered == 0, "REENTRANT"); entered = 1; _; entered = 0; }

    constructor(address token_, address governor_) {
        require(token_.code.length > 0 && governor_.code.length > 0, "CONTRACTS");
        token = IERC20(token_);
        governor = governor_;
    }

    /// Sponsors may also transfer tokens directly; available inventory always comes from balanceOf.
    function fund(uint256 amount) external nonReentrant {
        require(amount > 0, "AMOUNT");
        _receiveExact(msg.sender, amount);
        emit Funded(msg.sender, amount);
    }

    /// A percentage of principal for this term, rounded down to the smallest token unit.
    /// Division before multiplication avoids overflow for any uint256 principal and <=100% rate.
    function rewardFor(uint256 principal, uint16 rewardBps) public pure returns (uint256) {
        require(rewardBps > 0 && rewardBps <= BPS, "RATE");
        return (principal / BPS) * rewardBps + ((principal % BPS) * rewardBps) / BPS;
    }

    function protectedBalance() public view returns (uint256) {
        return totalPrincipal + totalRewardLiability + totalUnallocatedRewards;
    }

    function freeBalance() public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 protected = protectedBalance();
        require(balance >= protected, "INSOLVENT");
        return balance - protected;
    }

    function terms(uint256 campaignId) external view returns (Term[] memory) {
        _requireCampaign(campaignId);
        return _terms[campaignId];
    }

    /// Returns only unclaimed positions; bounded to MAX_ACTIVE_POSITIONS, including matured ones.
    /// Permanent position history remains available by ID and Staked/Claimed events.
    function activePositionIds(address owner) external view returns (uint256[] memory) {
        return _activePositions[owner];
    }

    /// Reserves this campaign's reward inventory immediately, before any participant deposits.
    /// Budget covers the entire principal cap at the highest offered rate, even if every user
    /// chooses that term. Concurrent campaigns cannot reserve the same tokens twice.
    function createCampaign(uint64 startsAt, uint64 enrollmentEndsAt, uint256 principalCap,
        uint256 rewardBudget, Term[] calldata campaignTerms)
        external onlyGovernor nonReentrant returns (uint256 campaignId)
    {
        require(startsAt >= block.timestamp && enrollmentEndsAt > startsAt, "ENROLLMENT");
        require(principalCap > 0 && campaignTerms.length > 0 && campaignTerms.length <= MAX_TERMS, "CAMPAIGN");
        uint16 highestRate;
        uint64 previousDuration;
        for (uint256 i; i < campaignTerms.length; ++i) {
            Term calldata term = campaignTerms[i];
            require(term.duration >= MIN_DURATION && term.duration <= MAX_DURATION &&
                term.duration > previousDuration && term.rewardBps > 0 && term.rewardBps <= BPS, "TERM");
            previousDuration = term.duration;
            if (term.rewardBps > highestRate) highestRate = term.rewardBps;
        }
        require(uint256(enrollmentEndsAt) + previousDuration <= type(uint64).max, "TIME_OVERFLOW");
        require(rewardBudget > 0 && rewardBudget >= rewardFor(principalCap, highestRate), "REWARD_BUDGET");
        require(freeBalance() >= rewardBudget, "PREFUND_REWARDS");
        campaignId = ++campaignCount;
        campaigns[campaignId] = Campaign(startsAt, enrollmentEndsAt, principalCap, 0,
            rewardBudget, rewardBudget, 0, false, false);
        totalUnallocatedRewards += rewardBudget;
        for (uint256 i; i < campaignTerms.length; ++i) {
            _terms[campaignId].push(campaignTerms[i]);
            emit TermCommitted(campaignId, i, campaignTerms[i].duration, campaignTerms[i].rewardBps);
        }
        emit CampaignCreated(campaignId, startsAt, enrollmentEndsAt, principalCap, rewardBudget);
    }

    function setAdmissionsPaused(uint256 campaignId, bool paused) external onlyGovernor {
        _requireCampaign(campaignId);
        Campaign storage campaign = campaigns[campaignId];
        require(!campaign.closed && block.timestamp < campaign.enrollmentEndsAt, "CLOSED");
        campaign.admissionsPaused = paused;
        emit AdmissionsPaused(campaignId, paused);
    }

    /// Governance may cancel unused enrollment immediately; after expiry anyone may close it.
    /// Only unallocated rewards become free. Accepted positions remain fully backed and claimable.
    function closeCampaign(uint256 campaignId) external nonReentrant {
        _requireCampaign(campaignId);
        Campaign storage campaign = campaigns[campaignId];
        require(msg.sender == governor || block.timestamp >= campaign.enrollmentEndsAt, "GOVERNOR_OR_EXPIRED");
        require(!campaign.closed, "CLOSED");
        campaign.closed = true;
        uint256 released = campaign.unallocatedReward;
        campaign.unallocatedReward = 0;
        totalUnallocatedRewards -= released;
        emit CampaignClosed(campaignId, released);
    }

    function stake(uint256 campaignId, uint256 termIndex, uint256 amount)
        external nonReentrant returns (uint256 positionId)
    {
        _requireCampaign(campaignId);
        Campaign storage campaign = campaigns[campaignId];
        require(!campaign.closed && !campaign.admissionsPaused && block.timestamp >= campaign.startsAt &&
            block.timestamp < campaign.enrollmentEndsAt, "ADMISSIONS_CLOSED");
        require(amount > 0 && amount <= campaign.principalCap - campaign.totalDeposited, "PRINCIPAL_CAP");
        require(termIndex < _terms[campaignId].length, "TERM_INDEX");
        require(_activePositions[msg.sender].length < MAX_ACTIVE_POSITIONS, "POSITION_LIMIT");
        Term memory term = _terms[campaignId][termIndex];
        uint256 reward = rewardFor(amount, term.rewardBps);
        require(reward > 0 && reward <= campaign.unallocatedReward, "REWARD_BUDGET");
        // Check backing before receiving principal: the deposit cannot fund its own reward.
        freeBalance();
        uint64 unlockAt = uint64(block.timestamp + term.duration);
        positionId = ++positionCount;
        positions[positionId] = Position(msg.sender, campaignId, amount, reward, uint64(block.timestamp), unlockAt, false);
        _positionIndex[positionId] = _activePositions[msg.sender].length;
        _activePositions[msg.sender].push(positionId);
        campaign.totalDeposited += amount;
        campaign.unallocatedReward -= reward;
        campaign.outstandingReward += reward;
        totalUnallocatedRewards -= reward;
        totalRewardLiability += reward;
        totalPrincipal += amount;
        _receiveExact(msg.sender, amount);
        emit Staked(msg.sender, positionId, campaignId, termIndex, amount, reward, unlockAt);
    }

    /// Only the position owner receives principal and the full fixed reward at maturity.
    /// No operator approval, sale requirement, auto-renewal, or compounding is involved.
    function claim(uint256 positionId) external nonReentrant {
        Position storage position = positions[positionId];
        require(position.owner == msg.sender && !position.claimed, "OWNER_OR_CLAIMED");
        require(block.timestamp >= position.unlockAt, "LOCKED");
        freeBalance();
        position.claimed = true;
        totalPrincipal -= position.principal;
        totalRewardLiability -= position.reward;
        campaigns[position.campaignId].outstandingReward -= position.reward;
        uint256[] storage active = _activePositions[msg.sender];
        uint256 index = _positionIndex[positionId];
        uint256 lastId = active[active.length - 1];
        active[index] = lastId;
        _positionIndex[lastId] = index;
        active.pop();
        delete _positionIndex[positionId];
        _sendExact(msg.sender, position.principal + position.reward);
        emit Claimed(msg.sender, positionId, position.principal, position.reward);
    }

    /// No generic call or approval escape hatch exists. Only inventory outside every campaign,
    /// participant principal and earned/future promised reward can be recovered by governance.
    function recoverFreeTokens(address recipient, uint256 amount) external onlyGovernor nonReentrant {
        require(recipient != address(0) && recipient != address(this) && amount > 0, "RECIPIENT_OR_AMOUNT");
        require(amount <= freeBalance(), "PROTECTED_FUNDS");
        _sendExact(recipient, amount);
        emit FreeTokensRecovered(recipient, amount);
    }

    function _requireCampaign(uint256 campaignId) private view {
        require(campaignId > 0 && campaignId <= campaignCount, "CAMPAIGN_ID");
    }

    function _receiveExact(address sender, uint256 amount) private {
        uint256 balance = token.balanceOf(address(this));
        uint256 senderBalance = token.balanceOf(sender);
        token.safeTransferFrom(sender, address(this), amount);
        require(token.balanceOf(address(this)) == balance + amount &&
            token.balanceOf(sender) == senderBalance - amount, "EXACT_TRANSFER");
    }

    function _sendExact(address recipient, uint256 amount) private {
        uint256 balance = token.balanceOf(address(this));
        uint256 recipientBalance = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        require(token.balanceOf(address(this)) == balance - amount &&
            token.balanceOf(recipient) == recipientBalance + amount, "EXACT_TRANSFER");
    }
}
