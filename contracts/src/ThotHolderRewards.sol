// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./TokenInterfaces.sol";
import "./ThotStakingPool.sol";

interface IHolderRewardMarket {
    // Matches the existing market's static offer getter without changing its settlement ABI.
    struct Offer {
        address buyer; address seller; address referrer;
        uint256 gross; uint256 sellerAmount; uint256 referralAmount;
        bytes32 licenseHash; bytes32 evidenceHash; bytes32 reviewHash; bytes32 deliveryHash;
        uint64 issuedAt; uint64 acceptedAt; uint64 deliveredAt; uint64 finalizedAt;
        uint16 sellerBps; uint16 referralBps; bool treasury; bool independent; uint8 status;
    }
    function token() external view returns (address);
    function governor() external view returns (address);
    function offers(bytes32) external view returns (Offer memory);
}

/// Prefunded service-fee cashback for completed independent trace purchases.
/// Existing escrow, sale proceeds, referrals and staking liabilities are untouched.
/// Rates follow the policy in force when an offer was funded. Eligibility is the
/// claimant's wallet + unclaimed staking principal at claim time, not a holding-age proof.
/// No automatic payout, APY, new mint or acquisition-reserve spending is implied.
contract ThotHolderRewards {
    using SafeToken for IERC20;
    IERC20 public immutable token;
    IHolderRewardMarket public immutable market;
    ThotStakingPool public immutable staking;
    address public immutable governor;
    uint64 public immutable eligibleFrom;
    uint256 public constant MAX_POLICIES = 128;
    struct Policy { uint64 startsAt; uint256 firstThreshold; uint256 secondThreshold; uint16 firstBps; uint16 secondBps; }
    Policy[] private _policies;
    mapping(bytes32 => mapping(address => uint256)) public paid;
    uint256 public totalPaid;
    uint256 private entered;
    event Funded(address indexed sponsor, uint256 amount);
    event PolicyActivated(uint256 indexed policyId, uint64 startsAt, uint256 firstThreshold, uint256 secondThreshold, uint16 firstBps, uint16 secondBps);
    event FeeRebated(bytes32 indexed offerId, address indexed recipient, uint256 indexed policyId, uint256 amount, uint256 qualifyingBalance);
    modifier nonReentrant() { require(entered == 0, "REENTRANT"); entered = 1; _; entered = 0; }
    modifier onlyGovernor() { require(msg.sender == governor, "GOVERNOR"); _; }

    constructor(address token_, address market_, address staking_, address governor_, uint64 eligibleFrom_) {
        require(token_.code.length > 0 && market_.code.length > 0 && staking_.code.length > 0 && governor_.code.length > 0, "CONTRACTS");
        token = IERC20(token_); market = IHolderRewardMarket(market_); staking = ThotStakingPool(staking_); governor = governor_;
        require(eligibleFrom_ <= block.timestamp + 1, "START_TIME"); eligibleFrom = eligibleFrom_;
        require(market.token() == token_ && address(staking.token()) == token_, "TOKEN_BINDING");
        require(market.governor() == governor_ && staking.governor() == governor_, "GOVERNOR_BINDING");
    }
    function fund(uint256 amount) external nonReentrant {
        require(amount > 0, "AMOUNT");
        uint256 beforePool = token.balanceOf(address(this)); uint256 beforeSender = token.balanceOf(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforePool + amount && token.balanceOf(msg.sender) == beforeSender - amount, "EXACT_TRANSFER");
        emit Funded(msg.sender, amount);
    }
    function policyCount() external view returns (uint256) { return _policies.length; }
    function policies(uint256 id) external view returns (Policy memory) { require(id > 0 && id <= _policies.length, "POLICY"); return _policies[id - 1]; }
    /// The first policy starts at the explicitly deployed eligibility cutoff. Later policies
    /// start the next second, leaving rates for already-funded offers unchanged. No extra delay.
    /// Two parties can each receive at most 25% of the service fee. Rates may be zero to end new admissions.
    function setPolicy(uint256 firstThreshold, uint256 secondThreshold, uint16 firstBps, uint16 secondBps) external onlyGovernor {
        require(_policies.length < MAX_POLICIES && firstThreshold > 0 && secondThreshold > firstThreshold, "THRESHOLDS");
        require(firstBps <= secondBps && secondBps <= 2500, "RATES");
        uint64 starts = _policies.length == 0 ? eligibleFrom : uint64(block.timestamp + 1);
        require(_policies.length == 0 || starts > _policies[_policies.length - 1].startsAt, "POLICY_TIME");
        require(secondBps == 0 || token.balanceOf(address(this)) > 0, "PREFUND");
        _policies.push(Policy(starts, firstThreshold, secondThreshold, firstBps, secondBps));
        emit PolicyActivated(_policies.length, starts, firstThreshold, secondThreshold, firstBps, secondBps);
    }
    function policyFor(uint64 issuedAt) public view returns (uint256) {
        uint256 lo; uint256 hi = _policies.length;
        while (lo < hi) { uint256 mid = (lo + hi) / 2; if (_policies[mid].startsAt <= issuedAt) lo = mid + 1; else hi = mid; }
        return lo;
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
    function rateFor(uint256 policyId, uint256 balance) public view returns (uint16) {
        require(policyId > 0 && policyId <= _policies.length, "POLICY");
        Policy memory p = _policies[policyId - 1];
        return balance >= p.secondThreshold ? p.secondBps : balance >= p.firstThreshold ? p.firstBps : 0;
    }
    /// A pending amount is only a preview; finality, current holdings and pool funds are checked on claim.
    function quote(bytes32 id, address recipient) public view returns (uint256 amount, uint256 policyId, uint16 rateBps, uint256 balance, bool claimable) {
        IHolderRewardMarket.Offer memory o = market.offers(id);
        if (recipient == address(0) || (recipient != o.buyer && recipient != o.seller) || o.buyer == o.seller || o.treasury || !o.independent || o.status == 0 || o.status == 6) return (0,0,0,0,false);
        policyId = policyFor(o.issuedAt);
        if (policyId == 0) return (0,0,0,0,false);
        balance = qualifyingBalance(recipient); rateBps = rateFor(policyId, balance);
        uint256 fee = o.gross - o.sellerAmount;
        amount = (fee / 10000) * rateBps + ((fee % 10000) * rateBps) / 10000;
        // Both participant rebates combined never exceed the protocol allocation, even if tariffs change.
        uint256 cap = (fee - o.referralAmount) / 2;
        if (amount > cap) amount = cap;
        if (paid[id][recipient] != 0) amount = 0;
        claimable = amount > 0 && o.status == 5 && token.balanceOf(address(this)) >= amount;
    }
    function claim(bytes32 id, uint256 minimumAmount) external nonReentrant {
        (uint256 amount,uint256 policyId,,uint256 balance,bool ready) = quote(id,msg.sender);
        require(ready && amount >= minimumAmount, "NOT_CLAIMABLE");
        paid[id][msg.sender] = amount; totalPaid += amount;
        uint256 beforePool = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(msg.sender);
        token.safeTransfer(msg.sender, amount);
        require(token.balanceOf(address(this)) == beforePool - amount && token.balanceOf(msg.sender) == beforeRecipient + amount, "EXACT_TRANSFER");
        emit FeeRebated(id,msg.sender,policyId,amount,balance);
    }
}
