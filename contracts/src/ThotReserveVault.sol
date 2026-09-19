// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./TokenInterfaces.sol";
import "./ThotMarket.sol";
import "./ThotBudgetSchedule.sol";

interface IThotApprove { function approve(address spender, uint256 amount) external returns (bool); }
interface IThotBuyerGovernor {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
}

/// Fixed first-campaign reserve. No admin withdrawals or generic calls. After sunset,
/// separately published successor campaign custody can receive remaining inventory
/// through governance authorization. Buyer escrows and seller locks never reside here.
contract ThotReserveVault {
    using SafeToken for IERC20;
    IERC20 public immutable token;
    address public immutable governor;
    address public operator;
    ThotMarket public market;
    uint256 public constant RESERVE = 500_000_000 ether;
    uint256 public constant AUTHORITY = 50_000_000 ether;
    uint256 public constant STARTER = 1_000_000 ether;
    uint256 public immutable GOVERNANCE_DELAY;
    uint256 public constant CAMPAIGN_DURATION = 360 days;
    uint64 public startAt;
    bool public paused;
    uint256 public grossCommitted;
    uint256 public independentDemand;
    mapping(uint256 => uint256) public dayCommitted;
    mapping(bytes32 => bool) public demandCredited;
    mapping(bytes32 => uint64) public queued;
    mapping(bytes32 => bytes32) public demandReviews;
    mapping(bytes32 => bool) public successorExecuted;
    mapping(address => bool) public authorizedBuyers;
    mapping(bytes32 => address) public acquisitionBuyer;
    uint256 private entered;
    event GovernanceQueued(bytes32 indexed operation, uint64 executableAt);
    event CampaignStarted(address indexed market, uint64 startAt, uint256 authority);
    event AcquisitionCommitted(bytes32 indexed id, uint256 indexed day, uint256 gross, bytes32 indexed reviewHash);
    event DemandReviewed(bytes32 indexed id, bytes32 indexed reviewHash);
    event DemandCredited(bytes32 indexed id, uint256 gross, bytes32 indexed reviewHash);
    event OperatorChanged(address indexed operator);
    event BuyerAuthorizationChanged(address indexed buyer, bool allowed);
    event SuccessorAuthorized(address indexed nextVault, uint256 amount, bytes32 indexed policyHash, bytes32 indexed operation);
    event Paused(bool paused);
    modifier onlyGovernor() { require(msg.sender == governor, "GOVERNOR"); _; }
    modifier onlyOperator() { require(msg.sender == operator, "OPERATOR"); _; }
    modifier onlyBuyer() { require(authorizedBuyers[msg.sender], "BUYER"); _; }
    modifier onlyReviewer() { require(msg.sender == operator || msg.sender == governor, "REVIEWER"); _; }
    modifier nonReentrant() { require(entered == 0, "REENTRANT"); entered = 1; _; entered = 0; }
    constructor(address token_, address governor_, address operator_) {
        require(token_.code.length > 0 && governor_ != address(0), "CONFIG");
        token = IERC20(token_); governor = governor_; operator = operator_;
        uint256 delay = 1 days;
        if (governor_.code.length > 0) {
            // The three disclosed governance owners can each buy within shared caps.
            // A maintenance operator receives no implicit spending authority in this mode.
            IThotBuyerGovernor controller = IThotBuyerGovernor(governor_);
            address[] memory buyers = controller.getOwners();
            uint256 threshold = controller.getThreshold();
            require(buyers.length == 3 && (threshold == 1 || threshold == 2), "GOVERNOR_CONFIG");
            // The selected one-owner controller is immediate on every chain.
            // Explicit legacy two-owner controllers retain their existing delay.
            if (threshold == 1) delay = 0;
            for (uint256 i; i < 3; i++) {
                address buyer = buyers[i];
                require(buyer != address(0) && !authorizedBuyers[buyer] && controller.isOwner(buyer), "GOVERNOR_OWNERS");
                authorizedBuyers[buyer] = true; emit BuyerAuthorizationChanged(buyer, true);
            }
        } else if (operator_ != address(0)) {
            // Preserves the legacy EOA-governor fixture constructor. A zero operator
            // starts with no buyers; later operator changes never grant buyer access.
            authorizedBuyers[operator_] = true; emit BuyerAuthorizationChanged(operator_, true);
        }
        GOVERNANCE_DELAY = delay;
    }
    function queueCampaign(address market_, uint64 start_) external onlyGovernor returns (bytes32 operation) {
        require(startAt == 0 && ((GOVERNANCE_DELAY == 0 && start_ == 0) || start_ >= block.timestamp + GOVERNANCE_DELAY), "START");
        operation = keccak256(abi.encode("campaign", market_, start_)); _queue(operation);
    }
    function executeCampaign(address market_, uint64 start_) external onlyGovernor {
        uint64 effectiveStart = GOVERNANCE_DELAY == 0 && start_ == 0 ? uint64(block.timestamp) : start_;
        require(startAt == 0 && block.timestamp < uint256(effectiveStart) + CAMPAIGN_DURATION && market_.code.length > 0, "START");
        _consume(keccak256(abi.encode("campaign", market_, start_)));
        ThotMarket candidate = ThotMarket(market_);
        require(address(candidate.token()) == address(token) && candidate.acquisitionVault() == address(this), "MARKET_BINDING");
        require(token.balanceOf(address(this)) >= RESERVE, "RESERVE_NOT_FUNDED");
        market = candidate; startAt = effectiveStart; emit CampaignStarted(market_, effectiveStart, AUTHORITY);
    }
    function queueOperator(address next) external onlyGovernor returns (bytes32 operation) {
        require(next != address(0), "ZERO"); operation = keccak256(abi.encode("operator", next)); _queue(operation);
    }
    function executeOperator(address next) external onlyGovernor { _consume(keccak256(abi.encode("operator", next))); operator = next; emit OperatorChanged(next); }
    function queueBuyer(address buyer, bool allowed) external onlyGovernor returns (bytes32 operation) {
        require(buyer != address(0) && buyer != address(this), "BUYER_ADDRESS");
        operation = keccak256(abi.encode("buyer", buyer, allowed)); _queue(operation);
    }
    function executeBuyer(address buyer, bool allowed) external onlyGovernor {
        _consume(keccak256(abi.encode("buyer", buyer, allowed)));
        authorizedBuyers[buyer] = allowed; emit BuyerAuthorizationChanged(buyer, allowed);
    }
    function pause() external onlyGovernor { paused = true; emit Paused(true); }
    function queueUnpause() external onlyGovernor { _queue(keccak256("unpause")); }
    function unpause() external onlyGovernor { _consume(keccak256("unpause")); paused = false; emit Paused(false); }
    function cancelGovernance(bytes32 operation) external onlyGovernor { delete queued[operation]; }
    /// New policy must identify a deployed, same-token campaign vault and be publicly
    /// committed before execution. This is disclosed administrator authority, not DAO voting.
    function queueSuccessor(address nextVault, uint256 amount, bytes32 policyHash) external onlyGovernor returns (bytes32 operation) {
        require(startAt > 0 && nextVault != address(this) && nextVault.code.length > 0 && amount > 0 && policyHash != bytes32(0), "SUCCESSOR");
        require(address(ThotReserveVault(nextVault).token()) == address(token), "SUCCESSOR_TOKEN");
        operation = keccak256(abi.encode("successor", nextVault, amount, policyHash));
        require(!successorExecuted[operation], "SUCCESSOR_REPLAY"); _queue(operation);
    }
    function executeSuccessor(address nextVault, uint256 amount, bytes32 policyHash) external onlyGovernor nonReentrant {
        require(startAt > 0 && block.timestamp >= uint256(startAt) + CAMPAIGN_DURATION, "BEFORE_SUNSET");
        bytes32 operation = keccak256(abi.encode("successor", nextVault, amount, policyHash));
        require(!successorExecuted[operation], "SUCCESSOR_REPLAY"); _consume(operation);
        require(nextVault.code.length > 0 && address(ThotReserveVault(nextVault).token()) == address(token), "SUCCESSOR_TOKEN");
        successorExecuted[operation] = true;
        token.safeTransfer(nextVault, amount);
        emit SuccessorAuthorized(nextVault, amount, policyHash, operation);
    }
    function _queue(bytes32 operation) private { queued[operation] = uint64(block.timestamp + GOVERNANCE_DELAY); emit GovernanceQueued(operation, queued[operation]); }
    function _consume(bytes32 operation) private { uint64 at = queued[operation]; require(at > 0 && block.timestamp >= at, "TIMELOCK"); delete queued[operation]; }
    function cumulativeCap(uint256 day) external pure returns (uint256) { return ThotBudgetSchedule.cumulative(day); }
    function dayCap(uint256 day) public pure returns (uint256) { return ThotBudgetSchedule.dayCap(day); }
    function currentDay() public view returns (uint256) {
        require(startAt > 0 && block.timestamp >= startAt, "NOT_STARTED"); return (block.timestamp - startAt) / 1 days;
    }
    function remainingAllowance() public view returns (uint256 amount) {
        if (startAt == 0 || block.timestamp < startAt || block.timestamp >= uint256(startAt) + CAMPAIGN_DURATION || paused) return 0;
        uint256 day = currentDay(); amount = dayCap(day) - dayCommitted[day];
        uint256 total = AUTHORITY - grossCommitted;
        uint256 demand = STARTER + independentDemand > grossCommitted ? STARTER + independentDemand - grossCommitted : 0;
        // Returned escrow/fees cannot replenish the campaign's nominal inventory authority.
        uint256 inventory = token.balanceOf(address(this));
        if (amount > total) amount = total;
        if (amount > demand) amount = demand;
        if (amount > inventory) amount = inventory;
    }
    /// All acquisition inputs are operator-approved before this transaction consumes authority.
    /// Nonzero evidence commitment binds the separately published research need and assay.
    function purchase(ThotMarket.OfferInput calldata input, bytes32 reviewHash) external onlyBuyer nonReentrant {
        require(reviewHash != bytes32(0) && input.evidenceHash != bytes32(0), "ACQUISITION_REVIEW");
        require(input.gross > 0 && input.gross <= remainingAllowance(), "CAMPAIGN_CAP");
        uint256 day = currentDay(); grossCommitted += input.gross; dayCommitted[day] += input.gross;
        acquisitionBuyer[input.id] = msg.sender;
        require(IThotApprove(address(token)).approve(address(market), input.gross), "APPROVE");
        market.createOffer(input, input.gross);
        require(IThotApprove(address(token)).approve(address(market), 0), "APPROVE_RESET");
        emit AcquisitionCommitted(input.id, day, input.gross, reviewHash);
    }
    /// A paid sample can be purchased under the contributor's existing exact licence authorization.
    /// The operator chooses the sample; the contract checks consent and the same finite spending caps.
    function purchaseAuthorized(ThotMarket.OfferInput calldata input, ThotMarket.SaleAuthorization calldata authorization,
        bytes calldata signature, bytes32 reviewHash) external onlyBuyer nonReentrant {
        require(reviewHash != bytes32(0) && input.evidenceHash != bytes32(0), "ACQUISITION_REVIEW");
        require(input.gross > 0 && input.gross <= remainingAllowance(), "CAMPAIGN_CAP");
        uint256 day = currentDay(); grossCommitted += input.gross; dayCommitted[day] += input.gross;
        acquisitionBuyer[input.id] = msg.sender;
        require(IThotApprove(address(token)).approve(address(market), input.gross), "APPROVE");
        market.createAuthorizedOffer(input, authorization, signature, input.gross);
        require(IThotApprove(address(token)).approve(address(market), 0), "APPROVE_RESET");
        emit AcquisitionCommitted(input.id, day, input.gross, reviewHash);
    }
    function reviewDemand(bytes32 id, bytes32 reviewHash) external onlyReviewer {
        require(!demandCredited[id] && reviewHash != bytes32(0), "DEMAND_REVIEW");
        demandReviews[id] = reviewHash; emit DemandReviewed(id, reviewHash);
    }
    function creditDemand(bytes32 id) external onlyReviewer {
        require(startAt > 0 && block.timestamp >= startAt && block.timestamp < uint256(startAt) + CAMPAIGN_DURATION, "CAMPAIGN_WINDOW");
        require(!demandCredited[id] && demandReviews[id] != bytes32(0), "DEMAND_REVIEW");
        (uint256 gross, uint64 finalizedAt, bool eligible, bytes32 reviewHash) = market.receiptForDemand(id);
        require(eligible && reviewHash != bytes32(0) && finalizedAt >= startAt && finalizedAt < uint256(startAt) + CAMPAIGN_DURATION, "INDEPENDENT_FINAL_RECEIPT");
        demandCredited[id] = true; independentDemand += gross; emit DemandCredited(id, gross, demandReviews[id]);
    }
    // Anyone may return claimable refunds/retained fees to this vault; no campaign counters decrease.
    function collectReturns() external nonReentrant { market.claim(); }
    function cancelOffer(bytes32 id) external { _requireAcquisitionController(id); market.cancelOffer(id); }
    function dispute(bytes32, bytes32) external pure { revert("TREASURY_NO_SUBJECTIVE_DISPUTE"); }
    function _requireAcquisitionController(bytes32 id) private view {
        // Revocation blocks new spending, not review/refund of an already funded acquisition.
        require(msg.sender == governor || msg.sender == operator || msg.sender == acquisitionBuyer[id], "ACQUISITION_BUYER");
    }
}
