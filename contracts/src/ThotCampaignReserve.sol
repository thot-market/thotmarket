// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./TokenInterfaces.sol";
import "./ThotMarket.sol";

interface IThotCampaignApprove { function approve(address spender, uint256 amount) external returns (bool); }
interface IThotCampaignGovernor {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
}

/// Multiple acquisition campaigns share a finite reserve. Governance allocates
/// budgets; authorized buyers choose actual purchases. Unspent allowance carries
/// forward inside a campaign, but refunds never replenish gross purchase authority.
/// There are no arbitrary withdrawals, approvals, calls, or successor transfers.
contract ThotCampaignReserve {
    using SafeToken for IERC20;

    struct Campaign {
        bytes32 policyHash;
        uint256 budget;
        uint256 committed;
        uint64 startAt;
        uint64 endAt;
        uint256 upfront;
        bool paused;
        bool closed;
    }

    IERC20 public immutable token;
    address public immutable governor;
    address public operator;
    ThotMarket public market;
    uint256 public constant RESERVE = 470_000_000 ether;
    uint256 public constant MAX_CAMPAIGN_DURATION = 365 days;
    uint256 public constant GOVERNANCE_DELAY = 0;
    uint256 public campaignCount;
    uint256 public totalAllocated;
    uint256 public totalGrossCommitted;
    bool public paused;
    mapping(uint256 => Campaign) private campaigns;
    mapping(address => bool) public authorizedBuyers;
    mapping(bytes32 => address) public acquisitionBuyer;
    mapping(bytes32 => uint256) public acquisitionCampaign;
    uint256 private entered;

    event MarketBound(address indexed market);
    event CampaignCreated(uint256 indexed campaignId, bytes32 indexed policyHash, uint256 budget, uint64 startAt, uint64 endAt, uint256 upfront);
    event CampaignPaused(uint256 indexed campaignId, bool paused);
    event CampaignClosed(uint256 indexed campaignId, uint256 releasedAllocation);
    event AcquisitionCommitted(bytes32 indexed id, uint256 indexed campaignId, uint256 gross, bytes32 indexed reviewHash);
    event OperatorChanged(address indexed operator);
    event BuyerAuthorizationChanged(address indexed buyer, bool allowed);
    event Paused(bool paused);

    modifier onlyGovernor() { require(msg.sender == governor, "GOVERNOR"); _; }
    modifier onlyBuyer() { require(authorizedBuyers[msg.sender], "BUYER"); _; }
    modifier nonReentrant() { require(entered == 0, "REENTRANT"); entered = 1; _; entered = 0; }

    constructor(address token_, address governor_, address operator_) {
        require(token_.code.length > 0 && governor_.code.length > 0, "CONFIG");
        token = IERC20(token_);
        governor = governor_;
        operator = operator_;
        IThotCampaignGovernor controller = IThotCampaignGovernor(governor_);
        address[] memory owners = controller.getOwners();
        require(owners.length == 3 && controller.getThreshold() == 1, "GOVERNOR_CONFIG");
        for (uint256 i; i < owners.length; i++) {
            address buyer = owners[i];
            require(buyer != address(0) && !authorizedBuyers[buyer] && controller.isOwner(buyer), "GOVERNOR_OWNERS");
            authorizedBuyers[buyer] = true;
            emit BuyerAuthorizationChanged(buyer, true);
        }
    }

    function reserveVersion() external pure virtual returns (uint256) { return 2; }

    /// The controller must review the market implementation before binding it.
    /// Matching getters are compatibility checks, not proof of authentic bytecode.
    function bindMarket(address market_) external onlyGovernor {
        require(address(market) == address(0) && market_.code.length > 0, "MARKET");
        ThotMarket candidate = ThotMarket(market_);
        require(address(candidate.token()) == address(token) && candidate.acquisitionVault() == address(this), "MARKET_BINDING");
        require(token.balanceOf(address(this)) >= _initialFundingRequired(), "RESERVE_NOT_FUNDED");
        market = candidate;
        emit MarketBound(market_);
    }

    function _initialFundingRequired() internal pure virtual returns (uint256) { return RESERVE; }

    function createCampaign(bytes32 policyHash, uint256 budget, uint64 start, uint64 duration, uint256 upfront)
        external onlyGovernor returns (uint256 campaignId)
    {
        require(address(market) != address(0), "MARKET_NOT_BOUND");
        require(policyHash != bytes32(0) && budget > 0 && upfront <= budget, "CAMPAIGN");
        require(duration > 0 && duration <= MAX_CAMPAIGN_DURATION, "DURATION");
        uint64 effectiveStart = start == 0 ? uint64(block.timestamp) : start;
        require(effectiveStart >= block.timestamp && uint256(effectiveStart) + duration <= type(uint64).max, "START");
        require(budget <= unallocatedBalance(), "ALLOCATION_CAP");
        campaignId = ++campaignCount;
        campaigns[campaignId] = Campaign(policyHash, budget, 0, effectiveStart, effectiveStart + duration, upfront, false, false);
        totalAllocated += budget;
        emit CampaignCreated(campaignId, policyHash, budget, effectiveStart, effectiveStart + duration, upfront);
    }

    function campaign(uint256 campaignId) external view returns (Campaign memory) {
        return _campaign(campaignId);
    }

    /// Both custody and gross lifetime authority must remain unpromised. Donations
    /// and returned escrow funds cannot expand the initial 470M purchase ceiling.
    function unallocatedBalance() public view virtual returns (uint256 amount) {
        uint256 inventory = token.balanceOf(address(this));
        if (inventory <= totalAllocated) return 0;
        amount = inventory - totalAllocated;
        uint256 authority = RESERVE - totalGrossCommitted - totalAllocated;
        if (amount > authority) amount = authority;
    }

    function unlockedBudget(uint256 campaignId) public view returns (uint256) {
        Campaign storage c = _campaign(campaignId);
        if (block.timestamp < c.startAt) return 0;
        if (block.timestamp >= c.endAt) return c.budget;
        return c.upfront + (c.budget - c.upfront) * (block.timestamp - c.startAt) / (c.endAt - c.startAt);
    }

    function remainingAllowance(uint256 campaignId) public view returns (uint256 amount) {
        Campaign storage c = _campaign(campaignId);
        if (paused || c.paused || c.closed || block.timestamp < c.startAt || block.timestamp >= c.endAt) return 0;
        uint256 unlocked = unlockedBudget(campaignId);
        amount = unlocked > c.committed ? unlocked - c.committed : 0;
        uint256 inventory = token.balanceOf(address(this));
        if (amount > inventory) amount = inventory;
    }

    function setCampaignPaused(uint256 campaignId, bool value) external onlyGovernor {
        Campaign storage c = _campaign(campaignId);
        require(!c.closed, "CAMPAIGN_CLOSED");
        c.paused = value;
        emit CampaignPaused(campaignId, value);
    }

    function cancelCampaign(uint256 campaignId) external onlyGovernor { _close(campaignId); }

    /// Anyone may release an expired campaign's unspent allocation for a new
    /// governance-approved campaign. This never transfers funds to the caller.
    function expireCampaign(uint256 campaignId) external {
        require(block.timestamp >= _campaign(campaignId).endAt, "NOT_EXPIRED");
        _close(campaignId);
    }

    function _close(uint256 campaignId) private {
        Campaign storage c = _campaign(campaignId);
        require(!c.closed, "CAMPAIGN_CLOSED");
        c.closed = true;
        uint256 released = c.budget - c.committed;
        totalAllocated -= released;
        emit CampaignClosed(campaignId, released);
    }

    function setOperator(address next) external onlyGovernor {
        require(next != address(0), "ZERO");
        operator = next;
        emit OperatorChanged(next);
    }

    function setBuyer(address buyer, bool allowed) external onlyGovernor {
        require(buyer != address(0) && buyer != address(this), "BUYER_ADDRESS");
        authorizedBuyers[buyer] = allowed;
        emit BuyerAuthorizationChanged(buyer, allowed);
    }

    function pause() external onlyGovernor { paused = true; emit Paused(true); }
    function unpause() external onlyGovernor { paused = false; emit Paused(false); }

    function purchase(uint256 campaignId, ThotMarket.OfferInput calldata input, bytes32 reviewHash) external onlyBuyer nonReentrant {
        _commit(campaignId, input, reviewHash);
        require(IThotCampaignApprove(address(token)).approve(address(market), input.gross), "APPROVE");
        market.createOffer(input, input.gross);
        require(IThotCampaignApprove(address(token)).approve(address(market), 0), "APPROVE_RESET");
    }

    function purchaseAuthorized(uint256 campaignId, ThotMarket.OfferInput calldata input,
        ThotMarket.SaleAuthorization calldata authorization, bytes calldata signature, bytes32 reviewHash)
        external onlyBuyer nonReentrant
    {
        _commit(campaignId, input, reviewHash);
        require(IThotCampaignApprove(address(token)).approve(address(market), input.gross), "APPROVE");
        market.createAuthorizedOffer(input, authorization, signature, input.gross);
        require(IThotCampaignApprove(address(token)).approve(address(market), 0), "APPROVE_RESET");
    }

    function _commit(uint256 campaignId, ThotMarket.OfferInput calldata input, bytes32 reviewHash) private {
        require(reviewHash != bytes32(0) && input.evidenceHash != bytes32(0), "ACQUISITION_REVIEW");
        require(input.gross > 0 && input.gross <= remainingAllowance(campaignId), "CAMPAIGN_CAP");
        require(acquisitionCampaign[input.id] == 0, "ACQUISITION_REPLAY");
        Campaign storage c = campaigns[campaignId];
        c.committed += input.gross;
        totalAllocated -= input.gross;
        totalGrossCommitted += input.gross;
        acquisitionBuyer[input.id] = msg.sender;
        acquisitionCampaign[input.id] = campaignId;
        emit AcquisitionCommitted(input.id, campaignId, input.gross, reviewHash);
    }

    function collectReturns() external nonReentrant {
        require(address(market) != address(0), "MARKET_NOT_BOUND");
        market.claim();
    }

    function cancelOffer(bytes32 id) external nonReentrant {
        require(acquisitionCampaign[id] != 0, "ACQUISITION");
        // Revocation blocks new spending, not cancellation of an existing offer.
        require(msg.sender == governor || msg.sender == operator || msg.sender == acquisitionBuyer[id], "ACQUISITION_BUYER");
        market.cancelOffer(id);
    }

    function dispute(bytes32, bytes32) external pure { revert("TREASURY_NO_SUBJECTIVE_DISPUTE"); }

    function _campaign(uint256 campaignId) private view returns (Campaign storage c) {
        require(campaignId > 0 && campaignId <= campaignCount, "CAMPAIGN_ID");
        return campaigns[campaignId];
    }
}
