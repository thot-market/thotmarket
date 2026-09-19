// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "./TokenInterfaces.sol";
import "./ThotLockVault.sol";
import "./ThotFeeDiscounts.sol";

interface IThotDisputeGovernor {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
}

/// Direct THOT escrow. The operator attests off-chain review/delivery; a fixed
/// governance council adjudicates eligible subjective disputes.
/// This contract does not prove research quality, beneficial ownership, or enclave execution.
contract ThotMarket {
    using SafeToken for IERC20;
    error ErrALREADY_VOTED();
    error ErrATTRIBUTION_CLOSED();
    error ErrAUTHORIZATION_LIMITS();
    error ErrAUTHORIZATION_NONCE();
    error ErrAUTHORIZATION_ErrTERMS();
    error ErrAUTHORIZATION_UNAVAILABLE();
    error ErrAUTHORIZED_ErrBUYER();
    error ErrBPS();
    error ErrBUYER();
    error ErrBUYER_OR_STATUS();
    error ErrBUYER_REVIEW_REQUIRED();
    error ErrCANONICAL_SIGNATURE();
    error ErrCONTRACTS();
    error ErrDECISION();
    error ErrDELIVERY_ACKNOWLEDGMENT();
    error ErrDELIVERY_HASH();
    error ErrDELIVERY_WINDOW();
    error ErrDISPUTE();
    error ErrDISPUTE_ErrNOT_EXPIRED();
    error ErrDISPUTE_WINDOW();
    error ErrEXACT_CONSENT();
    error ErrEXACT_TRANSFER();
    error ErrFEE_FLOOR();
    error ErrGOVERNANCE_VOTE_REQUIRED();
    error ErrGOVERNOR();
    error ErrGOVERNOR_CONFIG();
    error ErrGOVERNOR_REVIEWERS();
    error ErrLOCK_TOKEN();
    error ErrMAX_PAYMENT();
    error ErrNOT_EXPIRED();
    error ErrNOT_FINALIZABLE();
    error ErrNOT_OVERDUE();
    error ErrNO_CLAIM();
    error ErrNO_QUORUM_UPHOLD();
    error ErrOFFER_ID();
    error ErrOPERATOR();
    error ErrOPERATOR_REVIEW_SIGNATURE();
    error ErrPAUSED();
    error ErrPOLICY_BINDING();
    error ErrPRICE_BELOW_SERVICE_COST();
    error ErrQUALIFYING_SPEND();
    error ErrQUOTE_EXPIRED();
    error ErrREASON_HASH();
    error ErrREENTRANT();
    error ErrREFERRAL_CYCLE_OR_DEPTH();
    error ErrREFERRER();
    error ErrRESPONSE_WINDOW();
    error ErrREVIEWER();
    error ErrREVIEWER_CONFLICT();
    error ErrREVIEW_HASH();
    error ErrREVIEW_INPUTS_CHANGED();
    error ErrSELLER_OR_STATUS();
    error ErrSELLER_RETENTION();
    error ErrSELLER_SIGNATURE();
    error ErrSIGNATURE_LENGTH();
    error ErrSTREAM_NONCE();
    error ErrSTREAM_SIGNATURE();
    error ErrSTREAM_ErrTERMS();
    error ErrSTREAM_UNAVAILABLE();
    error ErrSUBJECTIVE_DISPUTE_UNAVAILABLE();
    error ErrTARIFF();
    error ErrTERMS();
    error ErrTESTNET_ONLY();
    error ErrTIER();
    error ErrTIMELOCK();
    error ErrVOTE_WINDOW();
    error ErrZERO();

    IERC20 public immutable token;
    ThotLockVault public immutable locks;
    address public immutable acquisitionVault;
    address public immutable governor;
    address public immutable protocolRecipient;
    address public operator;
    ThotFeeDiscounts public feeDiscounts;
    mapping(bytes32 => uint256) public buyerDiscountAtFunding;
    mapping(bytes32 => uint256) public sellerDiscountAtFunding;
    event FeeDiscountsBound(address policy);
    event DiscountsApplied(bytes32 indexed id, uint256 buyerDiscount, uint256 sellerDiscount);
    function bindFeeDiscounts(address policy) external onlyGovernor {
        require(address(feeDiscounts) == address(0) && policy.code.length > 0, ErrPOLICY_BINDING());
        ThotFeeDiscounts next = ThotFeeDiscounts(policy);
        require(address(next.token()) == address(token) && next.governor() == governor, ErrPOLICY_BINDING());
        feeDiscounts = next; emit FeeDiscountsBound(policy);
    }
    function holderQuote(address buyer, address seller, uint256 gross) public view returns (uint256 buyerDiscount, uint256 sellerDiscount) {
        (uint256 fee,,uint256 contribution,,) = costQuote(gross);
        if (buyer == acquisitionVault || address(feeDiscounts) == address(0)) return (0, 0);
        buyerDiscount = feeDiscounts.discount(buyer, fee, contribution);
        if (seller != address(0)) sellerDiscount = feeDiscounts.discount(seller, fee, contribution);
    }

    uint256 public immutable GOVERNANCE_DELAY;
    uint256 public constant QUOTE_LIFETIME = 1 days;
    uint256 public constant DELIVERY_WINDOW = 2 days;
    // Applies to fresh deployments only; existing markets retain their own immutable window.
    uint256 public constant DISPUTE_WINDOW = 12 hours;
    uint256 public constant SUBJECTIVE_DISPUTE_MIN_QUALIFYING_SPEND = 10_000_000 ether;
    uint256 public constant SELLER_RESPONSE_WINDOW = 1 days;
    uint256 public constant DISPUTE_VOTE_WINDOW = 7 days;
    address public constant DEAD_SINK = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant REFERRAL_TERM = 365 days;
    uint256 public constant REFERRAL_ACTIVATION_WINDOW = 90 days;
    uint16 public constant REFERRAL_BPS = 2000;
    uint16 public constant OPERATING_BUFFER_BPS = 2000;
    bytes32 public constant ECONOMICS_POLICY = keccak256("thot.quoted-cost/1");
    struct Tariff { uint256 directCost; uint256 allocatedOverhead; bytes32 policyHash; }
    Tariff public tariff;
    mapping(bytes32 => Tariff) public tariffAtFunding;
    mapping(address => uint64) public firstExternalOrderAt;
    bytes32 public constant SALE_AUTHORIZATION_TYPEHASH = keccak256("SaleAuthorization(address seller,address buyer,bytes32 evidenceHash,bytes32 licenseHash,uint256 gross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxUses)");
    bytes32 private constant REVIEW_AUTHORIZATION_TYPEHASH = keccak256("ReviewAuthorization(bytes32 inputDigest,bytes32 reviewHash,uint64 validUntil)");
    bytes32 public constant STREAM_AUTHORIZATION_TYPEHASH = keccak256("StreamAuthorization(address seller,address delegate,bytes32 licenseHash,uint256 minGross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxSales)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bool public paused;
    uint256 private entered;
    uint256 public escrowLiability;
    uint256 public claimLiability;
    enum Status { None, Offered, Accepted, Delivered, Disputed, Finalized, Refunded }
    enum DisputeDecision { None, Uphold, BuyerWins }
    struct OfferInput { bytes32 id; bytes32 nonce; address seller; uint256 gross; bytes32 licenseHash; bytes32 evidenceHash; }
    struct ReviewAuthorization { bytes32 inputDigest; bytes32 reviewHash; uint64 validUntil; }
    /// Contribution-time consent. Each successful use sells only the committed material/license
    /// at the exact gross price, with at least the signed seller retention. The app uses maxUses=1.
    struct SaleAuthorization {
        address seller;
        address buyer;
        bytes32 evidenceHash;
        bytes32 licenseHash;
        uint256 gross;
        uint16 minSellerBps;
        uint64 validUntil;
        bytes32 nonce;
        uint32 maxUses;
    }
    /// One connection-level mandate. The named enclave delegate can authorize
    /// particular releases under this licence/floor until expiry or revocation.
    /// It cannot spend the seller's tokens. Source provenance remains an offchain claim.
    struct StreamAuthorization {
        address seller; address delegate; bytes32 licenseHash; uint256 minGross;
        uint16 minSellerBps; uint64 validUntil; bytes32 nonce; uint32 maxSales;
    }
    struct Offer {
        address buyer;
        address seller;
        address referrer;
        uint256 gross;
        uint256 sellerAmount;
        uint256 referralAmount;
        bytes32 licenseHash;
        bytes32 evidenceHash;
        bytes32 reviewHash;
        bytes32 deliveryHash;
        uint64 issuedAt;
        uint64 acceptedAt;
        uint64 deliveredAt;
        uint64 finalizedAt;
        uint16 sellerBps;
        uint16 referralBps;
        bool treasury;
        bool independent;
        Status status;
    }
    struct Attribution { address referrer; uint64 acceptedAt; }
    /// Governance may later set a declining surcharge schedule without choosing
    /// economics in this deployment. An empty/unconfigured schedule charges zero.
    struct DisputeCase {
        bytes32 reasonHash;
        bytes32 responseHash;
        uint64 openedAt;
        uint64 voteStartsAt;
        uint64 voteEndsAt;
        uint8 upholdVotes;
        uint8 buyerVotes;
        DisputeDecision outcome;
    }
    mapping(bytes32 => Offer) public offers;
    mapping(address => Attribution) public attributions;
    mapping(address => bool) public hasAcceptedSale;
    mapping(address => uint256) public claimable;
    mapping(bytes32 => bytes32) public reviewedInputs;
    mapping(address => mapping(bytes32 => uint256)) public authorizationUses;
    mapping(address => mapping(bytes32 => bool)) public authorizationRevoked;
    mapping(address => mapping(bytes32 => bytes32)) public authorizationDigests;
    mapping(address => mapping(bytes32 => uint256)) public streamUses;
    mapping(address => mapping(bytes32 => bytes32)) public streamDigests;
    mapping(bytes32 => uint64) public queued;
    mapping(address => uint256) public finalizedIndependentSpend;
    mapping(bytes32 => DisputeCase) public disputeCases;
    mapping(bytes32 => mapping(address => DisputeDecision)) public disputeVotes;
    mapping(bytes32 => mapping(address => bytes32)) public disputeDecisionHashes;
    bool public constant buyerPricingConfigured = true;
    bytes32 public constant buyerPricingHash = ECONOMICS_POLICY;
    mapping(bytes32 => uint256) public buyerSurcharge;
    mapping(bytes32 => uint16) public buyerSurchargeBpsAtFunding;
    mapping(bytes32 => bytes32) public buyerPricingHashAtFunding;
    event OfferReviewed(bytes32 indexed inputDigest, bytes32 indexed reviewHash, bool approved);
    event OfferFunded(bytes32 indexed id, address indexed buyer, address indexed seller, uint256 gross, uint256 sellerAmount, address referrer, uint256 referralAmount, bool treasury, bytes32 consentDigest);
    event BuyerPriceApplied(bytes32 indexed id, address indexed buyer, uint256 sellerGross, uint256 surcharge, uint256 total, uint16 surchargeBps, bytes32 pricingHash);
    event Accepted(bytes32 indexed id, bytes32 indexed consentDigest);
    event Delivered(bytes32 indexed id, bytes32 indexed deliveryHash);
    event Disputed(bytes32 indexed id, address indexed by, bytes32 indexed reasonHash);
    event Adjudicated(bytes32 indexed id, bool refund, bytes32 indexed decisionHash);
    event DisputeResponded(bytes32 indexed id, address indexed seller, bytes32 indexed responseHash);
    event DisputeResponseWindowWaived(bytes32 indexed id, address indexed seller, uint64 voteStartsAt, uint64 voteEndsAt);
    event DisputeVoteCast(bytes32 indexed id, address indexed reviewer, DisputeDecision decision, bytes32 indexed decisionHash);
    event DisputeBurned(bytes32 indexed id, uint256 buyerRefund, uint256 burned);
    event Finalized(bytes32 indexed id, uint256 sellerAmount, uint256 referralAmount, uint256 protocolAmount);
    event Refunded(bytes32 indexed id, address indexed buyer, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);
    event ReferralAccepted(address indexed seller, address indexed referrer, uint64 acceptedAt);
    event ReferralActivated(address indexed seller, uint64 firstExternalOrderAt);
    event TariffActivated(uint256 directCost, uint256 allocatedOverhead, bytes32 indexed policyHash);
    event SaleAuthorizationUsed(bytes32 indexed id, address indexed seller, bytes32 indexed nonce, bytes32 authorizationDigest, uint256 uses);
    event SaleAuthorizationRevoked(address indexed seller, bytes32 indexed nonce);
    event StreamAuthorizationUsed(address indexed seller, bytes32 indexed nonce, address indexed delegate, uint256 uses);
    event GovernanceQueued(bytes32 indexed operation, uint64 executableAt);
    event BuyerPricingActivated(bytes32 indexed pricingHash, uint256 tierCount);
    event OperatorChanged(address indexed operator);
    event Paused(bool paused);
    modifier nonReentrant() { require(entered == 0, ErrREENTRANT()); entered = 1; _; entered = 0; }
    modifier onlyGovernor() { require(msg.sender == governor, ErrGOVERNOR()); _; }
    modifier onlyOperator() { require(msg.sender == operator, ErrOPERATOR()); _; }
    constructor(address token_, address locks_, address acquisitionVault_, address governor_, address operator_, address protocolRecipient_) {
        require(token_.code.length > 0 && locks_.code.length > 0 && acquisitionVault_.code.length > 0, ErrCONTRACTS());
        require(governor_ != address(0) && operator_ != address(0) && protocolRecipient_ != address(0), ErrZERO());
        token = IERC20(token_); locks = ThotLockVault(locks_);
        require(address(locks.token()) == token_, ErrLOCK_TOKEN());
        if (governor_.code.length > 0) {
            IThotDisputeGovernor controller = IThotDisputeGovernor(governor_);
            address[] memory reviewers = controller.getOwners();
            uint256 threshold = controller.getThreshold();
            require(reviewers.length == 3 && (threshold == 1 || threshold == 2), ErrGOVERNOR_CONFIG());
            for (uint256 i; i < 3; i++) {
                require(reviewers[i] != address(0) && controller.isOwner(reviewers[i]), ErrGOVERNOR_REVIEWERS());
                for (uint256 j; j < i; j++) require(reviewers[i] != reviewers[j], ErrGOVERNOR_REVIEWERS());
            }
        }
        acquisitionVault = acquisitionVault_; governor = governor_; operator = operator_; protocolRecipient = protocolRecipient_;
        GOVERNANCE_DELAY = governor_.code.length > 0 && IThotDisputeGovernor(governor_).getThreshold() == 1 ? 0 : 7 days;
        // Test calibration in token units, not a claim of measured dollar costs.
        // Production must configure an explicit quoted tariff before enabling purchases.
        _validateDeploymentChain();
        tariff = Tariff(0.01 ether, 0.02 ether, keccak256("thot.test-tariff/1:C=0.01;O=0.02;buffer=20%;referral=20%;THOT"));
    }
    function _validateDeploymentChain() internal view virtual {
        require(block.chainid == 31337 || block.chainid == 46630, ErrTESTNET_ONLY());
    }
    function queueOperator(address next) external onlyGovernor returns (bytes32 operation) {
        require(next != address(0), ErrZERO()); operation = keccak256(abi.encode("operator", next)); _queue(operation);
    }
    function executeOperator(address next) external onlyGovernor { _consume(keccak256(abi.encode("operator", next))); operator = next; emit OperatorChanged(next); }
    function pause() external onlyGovernor { paused = true; emit Paused(true); }
    function queueUnpause() external onlyGovernor { _queue(keccak256("unpause")); }
    function unpause() external onlyGovernor { _consume(keccak256("unpause")); paused = false; emit Paused(false); }
    function cancelGovernance(bytes32 operation) external onlyGovernor { delete queued[operation]; }
    function tariffOperation(uint256 directCost, uint256 allocatedOverhead, bytes32 policyHash) public pure returns (bytes32) {
        return keccak256(abi.encode("quoted-cost-tariff", directCost, allocatedOverhead, policyHash));
    }
    function queueTariff(uint256 directCost, uint256 allocatedOverhead, bytes32 policyHash) external virtual onlyGovernor returns (bytes32 operation) {
        _validateTariff(directCost, allocatedOverhead, policyHash);
        operation = tariffOperation(directCost, allocatedOverhead, policyHash); _queue(operation);
    }
    function executeTariff(uint256 directCost, uint256 allocatedOverhead, bytes32 policyHash) external virtual onlyGovernor {
        _validateTariff(directCost, allocatedOverhead, policyHash);
        _consume(tariffOperation(directCost, allocatedOverhead, policyHash));
        tariff = Tariff(directCost, allocatedOverhead, policyHash);
        emit TariffActivated(directCost, allocatedOverhead, policyHash);
    }
    function _validateTariff(uint256 directCost, uint256 allocatedOverhead, bytes32 policyHash) private pure {
        require(directCost <= 1_000_000_000 ether && allocatedOverhead <= 1_000_000_000 ether && policyHash != bytes32(0), ErrTARIFF());
    }
    /// F=C+ceil(O*1.2/(1-.2)). Costs are fixed before funding; no later deductions.
    function costQuote(uint256 gross) public view virtual returns (uint256 serviceFee, uint256 directCost, uint256 netContribution, uint256 sellerAmount, bytes32 policyHash) {
        Tariff memory terms = tariff;
        directCost = terms.directCost;
        netContribution = terms.allocatedOverhead + terms.allocatedOverhead / 2 + terms.allocatedOverhead % 2;
        serviceFee = directCost + netContribution;
        require(gross >= serviceFee && gross <= 1_000_000_000 ether, ErrPRICE_BELOW_SERVICE_COST());
        sellerAmount = gross - serviceFee; policyHash = terms.policyHash;
    }
    function buyerPricingTierCount() external pure returns (uint256) { return 1; }
    function buyerPricingTier(uint256 index) external pure returns (uint256 minRetained, uint16 surchargeBps) {
        require(index == 0, ErrTIER()); return (0, 0);
    }
    function _queue(bytes32 operation) private { queued[operation] = uint64(block.timestamp + GOVERNANCE_DELAY); emit GovernanceQueued(operation, queued[operation]); }
    function _consume(bytes32 operation) private { uint64 at = queued[operation]; require(at > 0 && block.timestamp >= at, ErrTIMELOCK()); delete queued[operation]; }
    function inputDigest(address buyer, OfferInput calldata input) public view returns (bytes32) {
        (uint256 bd, uint256 sd) = holderQuote(buyer, input.seller, input.gross);
        return keccak256(abi.encode(block.chainid, address(this), buyer, input, attributions[input.seller], tariff, address(feeDiscounts), bd, sd));
    }
    function offerId(address buyer, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), buyer, nonce));
    }
    /// Review concerns the exact buyer/seller/material/price. It does not itself spend tokens.
    function reviewOffer(address buyer, OfferInput calldata input, bytes32 reviewHash, bool approved) external onlyOperator {
        bytes32 digest = inputDigest(buyer, input);
        require(!approved || reviewHash != bytes32(0), ErrREVIEW_HASH());
        reviewedInputs[digest] = approved ? reviewHash : bytes32(0);
        emit OfferReviewed(digest, reviewHash, approved);
    }
    /// Deprecated compatibility view: holdings affect price, never permission to buy.
    function buyerEligible(address) public pure returns (bool) { return true; }
    function buyerQuote(address buyer, uint256 sellerGross) public view returns (uint256 surcharge, uint256 total, uint16 surchargeBps, uint256 retainedAfter) {
        (uint256 discount,) = holderQuote(buyer, address(0), sellerGross);
        total = sellerGross - discount;
        return (0, total, 0, locks.qualifiedBalance(buyer) + _walletRetained(buyer, total));
    }
    function _walletRetained(address buyer, uint256 payment) private view returns (uint256) {
        uint256 balance = token.balanceOf(buyer); return balance > payment ? balance - payment : 0;
    }
    function disputeThreshold() public view returns (uint256) { return governor.code.length > 0 ? IThotDisputeGovernor(governor).getThreshold() : 1; }
    function isDisputeReviewer(address reviewer) public view returns (bool) {
        if (governor.code.length == 0) return reviewer == governor;
        try IThotDisputeGovernor(governor).isOwner(reviewer) returns (bool allowed) { return allowed; }
        catch { return false; }
    }
    function registerReferrer(address referrer) external {
        require(!hasAcceptedSale[msg.sender] && attributions[msg.sender].referrer == address(0), ErrATTRIBUTION_CLOSED());
        require(referrer != address(0) && referrer != msg.sender && referrer != acquisitionVault, ErrREFERRER());
        // The bounded ancestry walk excludes cycles without an unbounded gas dependency.
        address ancestor = referrer;
        for (uint256 i; ancestor != address(0); ++i) {
            require(i < 64 && ancestor != msg.sender, ErrREFERRAL_CYCLE_OR_DEPTH());
            ancestor = attributions[ancestor].referrer;
        }
        attributions[msg.sender] = Attribution(referrer, uint64(block.timestamp));
        emit ReferralAccepted(msg.sender, referrer, uint64(block.timestamp));
    }
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("thot market"), keccak256("0.9"), block.chainid, address(this)));
    }
    function saleAuthorizationDigest(SaleAuthorization calldata authorization) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(SALE_AUTHORIZATION_TYPEHASH, authorization.seller, authorization.buyer,
            authorization.evidenceHash, authorization.licenseHash, authorization.gross, authorization.minSellerBps,
            authorization.validUntil, authorization.nonce, authorization.maxUses));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }
    /// Revocation only prevents future funding; it cannot cancel a previously authorized sale.
    function revokeSaleAuthorization(bytes32 nonce) external {
        authorizationRevoked[msg.sender][nonce] = true;
        emit SaleAuthorizationRevoked(msg.sender, nonce);
    }
    function createAuthorizedOffer(OfferInput calldata input, SaleAuthorization calldata authorization, bytes calldata signature, uint256 maxPayment) external nonReentrant {
        bytes32 reviewHash = reviewedInputs[inputDigest(msg.sender, input)];
        require(msg.sender == acquisitionVault || reviewHash != bytes32(0), ErrBUYER_REVIEW_REQUIRED());
        _createAuthorizedOffer(input, authorization, signature, maxPayment, reviewHash);
    }
    /// The buyer funds and pays gas for an operator-reviewed sale in one transaction.
    /// Changes in the seller's referral attribution or any other reviewed input invalidate this signature.
    function createReviewedAuthorizedOffer(OfferInput calldata input, SaleAuthorization calldata authorization,
        bytes calldata signature, uint256 maxPayment, ReviewAuthorization calldata review, bytes calldata reviewSignature) external nonReentrant {
        require(msg.sender != acquisitionVault && review.reviewHash != bytes32(0) &&
            block.timestamp < review.validUntil && review.inputDigest == inputDigest(msg.sender, input), ErrREVIEW_INPUTS_CHANGED());
        bytes32 structHash = keccak256(abi.encode(REVIEW_AUTHORIZATION_TYPEHASH, review.inputDigest,
            review.reviewHash, review.validUntil));
        require(_recover(keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash)), reviewSignature) == operator,
            "OPERATOR_REVIEW_SIGNATURE");
        _createAuthorizedOffer(input, authorization, signature, maxPayment, review.reviewHash);
    }
    function _createAuthorizedOffer(OfferInput calldata input, SaleAuthorization calldata authorization,
        bytes calldata signature, uint256 maxPayment, bytes32 reviewHash) private {
        bytes32 digest = _useSaleAuthorization(input, authorization, signature);
        _createOffer(input, maxPayment, reviewHash);
        Offer storage o = offers[input.id];
        require(o.sellerAmount >= mulBpsUp(o.gross, authorization.minSellerBps), ErrSELLER_RETENTION());
        o.acceptedAt = uint64(block.timestamp); o.status = Status.Accepted; hasAcceptedSale[input.seller] = true;
        emit Accepted(input.id, quoteDigest(input.id));
        emit SaleAuthorizationUsed(input.id, input.seller, authorization.nonce, digest, authorizationUses[input.seller][authorization.nonce]);
    }
    function _useSaleAuthorization(OfferInput calldata input, SaleAuthorization calldata authorization, bytes calldata signature) private returns (bytes32 digest) {
        require(authorization.seller == input.seller && authorization.evidenceHash == input.evidenceHash &&
            authorization.licenseHash == input.licenseHash && authorization.gross == input.gross && input.evidenceHash != bytes32(0), ErrAUTHORIZATION_ErrTERMS());
        require(authorization.buyer == address(0) || authorization.buyer == msg.sender, ErrAUTHORIZED_ErrBUYER());
        require(block.timestamp < authorization.validUntil && authorization.minSellerBps <= 10_000 && authorization.maxUses > 0, ErrAUTHORIZATION_LIMITS());
        require(!authorizationRevoked[input.seller][authorization.nonce] &&
            authorizationUses[input.seller][authorization.nonce] < authorization.maxUses, ErrAUTHORIZATION_UNAVAILABLE());
        digest = saleAuthorizationDigest(authorization);
        bytes32 prior = authorizationDigests[input.seller][authorization.nonce];
        require(prior == bytes32(0) || prior == digest, ErrAUTHORIZATION_NONCE());
        if (signature.length == 65) {
            require(_recover(digest, signature) == input.seller, ErrSELLER_SIGNATURE());
        } else {
            require(signature.length <= 1024, ErrSIGNATURE_LENGTH());
            (StreamAuthorization memory stream, bytes memory sellerSignature, bytes memory delegateSignature) =
                abi.decode(signature, (StreamAuthorization, bytes, bytes));
            require(stream.seller == input.seller && stream.delegate != address(0) &&
                stream.licenseHash == input.licenseHash && input.gross >= stream.minGross && stream.minGross > 0 &&
                authorization.minSellerBps >= stream.minSellerBps && stream.minSellerBps >= 3000 &&
                authorization.validUntil <= stream.validUntil && block.timestamp < stream.validUntil &&
                stream.maxSales > 0 && stream.maxSales <= 10000 && authorization.maxUses == 1, ErrSTREAM_ErrTERMS());
            require(!authorizationRevoked[input.seller][stream.nonce] && streamUses[input.seller][stream.nonce] < stream.maxSales, ErrSTREAM_UNAVAILABLE());
            bytes32 streamDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(
                STREAM_AUTHORIZATION_TYPEHASH, stream.seller, stream.delegate, stream.licenseHash, stream.minGross,
                stream.minSellerBps, stream.validUntil, stream.nonce, stream.maxSales))));
            bytes32 previous = streamDigests[input.seller][stream.nonce];
            require(previous == bytes32(0) || previous == streamDigest, ErrSTREAM_NONCE());
            require(_recover(streamDigest, sellerSignature) == input.seller && _recover(digest, delegateSignature) == stream.delegate, ErrSTREAM_SIGNATURE());
            streamDigests[input.seller][stream.nonce] = streamDigest;
            streamUses[input.seller][stream.nonce] += 1;
            emit StreamAuthorizationUsed(input.seller, stream.nonce, stream.delegate, streamUses[input.seller][stream.nonce]);
        }
        authorizationDigests[input.seller][authorization.nonce] = digest;
        authorizationUses[input.seller][authorization.nonce] += 1;
    }
    function _recover(bytes32 digest, bytes memory signature) private pure returns (address signer) {
        require(signature.length == 65, ErrSIGNATURE_LENGTH());
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        require(uint256(s) <= SECP256K1_HALF_ORDER && (v == 27 || v == 28), ErrCANONICAL_SIGNATURE());
        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), ErrSELLER_SIGNATURE());
    }
    function createOffer(OfferInput calldata input, uint256 maxPayment) external nonReentrant {
        _createOffer(input, maxPayment, reviewedInputs[inputDigest(msg.sender, input)]);
    }
    function _createOffer(OfferInput calldata input, uint256 maxPayment, bytes32 reviewHash) private {
        require(!paused, ErrPAUSED());
        require(input.id == offerId(msg.sender, input.nonce) && offers[input.id].status == Status.None, ErrOFFER_ID());
        require(input.seller != address(0) && input.seller != msg.sender && input.gross > 0 && input.licenseHash != bytes32(0), ErrTERMS());
        bool treasury = msg.sender == acquisitionVault;
        // Direct manual offers may still be unreviewed, but automatic authorized
        // ordinary sales fail closed before reaching this function.
        // Treasury offers are pre-reviewed by the vault's operator and may never earn referrals/demand credit.
        (uint256 buyerDiscount, uint256 sellerDiscount) = holderQuote(msg.sender, input.seller, input.gross);
        uint256 surcharge; uint16 surchargeBps; uint256 total = input.gross - buyerDiscount;
        require(total <= maxPayment, ErrMAX_PAYMENT());
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), total);
        require(token.balanceOf(address(this)) == beforeBalance + total, ErrEXACT_TRANSFER());
        (, uint256 directCost, uint256 netContribution, uint256 sellerAmount,) = costQuote(input.gross);
        sellerAmount += sellerDiscount;
        uint16 sellerRate = uint16(sellerAmount * 10_000 / input.gross);
        tariffAtFunding[input.id] = tariff;
        address referrer;
        uint16 referralRate;
        Attribution memory attribution = attributions[input.seller];
        if (!treasury && reviewHash != bytes32(0) && attribution.referrer != address(0) && attribution.referrer != msg.sender) {
            uint64 first = firstExternalOrderAt[input.seller];
            if (first == 0 && block.timestamp < uint256(attribution.acceptedAt) + REFERRAL_ACTIVATION_WINDOW) {
                first = uint64(block.timestamp); firstExternalOrderAt[input.seller] = first;
                emit ReferralActivated(input.seller, first);
            }
            if (first != 0 && block.timestamp < uint256(first) + REFERRAL_TERM) {
                referrer = attribution.referrer; referralRate = REFERRAL_BPS;
            }
        }
        Offer storage offer = offers[input.id];
        offer.buyer = msg.sender; offer.seller = input.seller; offer.referrer = referrer;
        offer.gross = input.gross; offer.sellerAmount = sellerAmount;
        offer.referralAmount = mulBps(netContribution, referralRate);
        // Direct costs are excluded from the acquisition pool and paid once with the protocol share.
        assert(input.gross - sellerAmount + sellerDiscount == directCost + netContribution);
        require(total >= sellerAmount + offer.referralAmount + directCost, ErrFEE_FLOOR());
        buyerDiscountAtFunding[input.id] = buyerDiscount;
        sellerDiscountAtFunding[input.id] = sellerDiscount;
        emit DiscountsApplied(input.id, buyerDiscount, sellerDiscount);
        offer.licenseHash = input.licenseHash; offer.evidenceHash = input.evidenceHash; offer.reviewHash = reviewHash;
        offer.issuedAt = uint64(block.timestamp); offer.sellerBps = sellerRate; offer.referralBps = referralRate;
        offer.treasury = treasury; offer.independent = !treasury && reviewHash != bytes32(0); offer.status = Status.Offered;
        buyerSurcharge[input.id] = surcharge; buyerSurchargeBpsAtFunding[input.id] = surchargeBps;
        buyerPricingHashAtFunding[input.id] = treasury || !buyerPricingConfigured ? bytes32(0) : buyerPricingHash;
        escrowLiability += total;
        emit OfferFunded(input.id, msg.sender, input.seller, input.gross, sellerAmount, referrer, offer.referralAmount, treasury, quoteDigest(input.id));
        emit BuyerPriceApplied(input.id, msg.sender, input.gross, surcharge, total, surchargeBps, buyerPricingHashAtFunding[input.id]);
    }
    /// Digest includes both parties, exact license/material commitment, full funded allocation and deadline.
    function quoteDigest(bytes32 id) public view returns (bytes32) {
        Offer storage o = offers[id];
        return keccak256(abi.encode(block.chainid, address(this), id, o.buyer, o.seller, o.licenseHash, o.evidenceHash,
            o.gross, buyerSurcharge[id], buyerDiscountAtFunding[id], o.sellerAmount, o.referrer, o.referralAmount, o.treasury, o.reviewHash,
            buyerPricingHashAtFunding[id], tariffAtFunding[id], uint256(o.issuedAt) + QUOTE_LIFETIME));
    }
    function paymentFor(bytes32 id) public view returns (uint256 sellerGross, uint256 surcharge, uint256 total, uint16 surchargeBps, bytes32 pricingHash) {
        Offer storage o = offers[id]; surcharge = buyerSurcharge[id];
        return (o.gross, surcharge, o.gross + surcharge - buyerDiscountAtFunding[id], buyerSurchargeBpsAtFunding[id], buyerPricingHashAtFunding[id]);
    }
    function acceptOffer(bytes32 id, bytes32 consentDigest) external {
        Offer storage o = offers[id];
        require(o.status == Status.Offered && msg.sender == o.seller, ErrSELLER_OR_STATUS());
        require(block.timestamp <= uint256(o.issuedAt) + QUOTE_LIFETIME, ErrQUOTE_EXPIRED());
        require(consentDigest == quoteDigest(id), ErrEXACT_CONSENT());
        o.acceptedAt = uint64(block.timestamp); o.status = Status.Accepted; hasAcceptedSale[msg.sender] = true;
        emit Accepted(id, consentDigest);
    }
    function markDelivered(bytes32 id, bytes32 deliveryHash) external {
        Offer storage o = offers[id];
        require(msg.sender == operator || msg.sender == o.buyer, ErrDELIVERY_ACKNOWLEDGMENT());
        require(o.status == Status.Accepted && block.timestamp <= uint256(o.acceptedAt) + DELIVERY_WINDOW, ErrDELIVERY_WINDOW());
        require(deliveryHash != bytes32(0), ErrDELIVERY_HASH());
        o.deliveryHash = deliveryHash; o.deliveredAt = uint64(block.timestamp); o.status = Status.Delivered;
        emit Delivered(id, deliveryHash);
    }
    function dispute(bytes32 id, bytes32 reasonHash) external {
        Offer storage o = offers[id];
        require(msg.sender == o.buyer, ErrBUYER());
        require(o.status == Status.Delivered && block.timestamp < uint256(o.deliveredAt) + DISPUTE_WINDOW, ErrDISPUTE_WINDOW());
        require(o.independent && !o.treasury, ErrSUBJECTIVE_DISPUTE_UNAVAILABLE());
        require(finalizedIndependentSpend[msg.sender] + o.gross - buyerDiscountAtFunding[id] >= SUBJECTIVE_DISPUTE_MIN_QUALIFYING_SPEND, ErrQUALIFYING_SPEND());
        require(reasonHash != bytes32(0) && disputeCases[id].openedAt == 0, ErrREASON_HASH());
        uint64 openedAt = uint64(block.timestamp);
        disputeCases[id] = DisputeCase(reasonHash, bytes32(0), openedAt,
            uint64(block.timestamp + SELLER_RESPONSE_WINDOW),
            uint64(block.timestamp + SELLER_RESPONSE_WINDOW + DISPUTE_VOTE_WINDOW), 0, 0, DisputeDecision.None);
        o.status = Status.Disputed; emit Disputed(id, msg.sender, reasonHash);
    }
    function respondToDispute(bytes32 id, bytes32 responseHash) external {
        Offer storage o = offers[id]; DisputeCase storage c = disputeCases[id];
        require(o.status == Status.Disputed && msg.sender == o.seller, ErrSELLER_OR_STATUS());
        require(block.timestamp < c.voteStartsAt && responseHash != bytes32(0) && c.responseHash == bytes32(0), ErrRESPONSE_WINDOW());
        c.responseHash = responseHash; emit DisputeResponded(id, msg.sender, responseHash);
    }
    /// The seller may voluntarily finish its response period after submitting a response.
    /// Governance and the operator cannot shorten another party's response time.
    function waiveDisputeResponseWindow(bytes32 id) external {
        Offer storage o = offers[id]; DisputeCase storage c = disputeCases[id];
        require(o.status == Status.Disputed && c.outcome == DisputeDecision.None && msg.sender == o.seller, ErrSELLER_OR_STATUS());
        require(c.responseHash != bytes32(0) && block.timestamp < c.voteStartsAt, ErrRESPONSE_WINDOW());
        c.voteStartsAt = uint64(block.timestamp); c.voteEndsAt = uint64(block.timestamp + DISPUTE_VOTE_WINDOW);
        emit DisputeResponseWindowWaived(id, msg.sender, c.voteStartsAt, c.voteEndsAt);
    }
    function voteDispute(bytes32 id, DisputeDecision decision, bytes32 decisionHash) external {
        Offer storage o = offers[id]; DisputeCase storage c = disputeCases[id];
        require(o.status == Status.Disputed && c.outcome == DisputeDecision.None, ErrDISPUTE());
        require(isDisputeReviewer(msg.sender), ErrREVIEWER());
        require(msg.sender != o.buyer && msg.sender != o.seller && msg.sender != o.referrer, ErrREVIEWER_CONFLICT());
        require(block.timestamp >= c.voteStartsAt && block.timestamp < c.voteEndsAt, ErrVOTE_WINDOW());
        require((decision == DisputeDecision.Uphold || decision == DisputeDecision.BuyerWins) && decisionHash != bytes32(0), ErrDECISION());
        require(disputeVotes[id][msg.sender] == DisputeDecision.None, ErrALREADY_VOTED());
        disputeVotes[id][msg.sender] = decision;
        disputeDecisionHashes[id][msg.sender] = decisionHash;
        if (decision == DisputeDecision.BuyerWins) c.buyerVotes++; else c.upholdVotes++;
        emit DisputeVoteCast(id, msg.sender, decision, decisionHash);
        if (c.buyerVotes >= disputeThreshold()) _adjudicateBuyerWin(id, o, c, decisionHash);
        else if (c.upholdVotes >= disputeThreshold()) _adjudicateUphold(id, o, c, decisionHash);
    }
    function finalizeExpiredDispute(bytes32 id) external {
        Offer storage o = offers[id]; DisputeCase storage c = disputeCases[id];
        require(o.status == Status.Disputed && c.outcome == DisputeDecision.None && block.timestamp >= c.voteEndsAt, ErrDISPUTE_ErrNOT_EXPIRED());
        _adjudicateUphold(id, o, c, keccak256("NO_QUORUM_UPHOLD"));
    }
    /// Retained in the ABI so older clients fail with an explicit migration error.
    function resolveDispute(bytes32, bool, bytes32) external pure { revert ErrGOVERNANCE_VOTE_REQUIRED(); }
    function _adjudicateUphold(bytes32 id, Offer storage o, DisputeCase storage c, bytes32 decisionHash) private {
        c.outcome = DisputeDecision.Uphold; o.status = Status.Delivered;
        emit Adjudicated(id, false, decisionHash);
    }
    function _adjudicateBuyerWin(bytes32 id, Offer storage o, DisputeCase storage c, bytes32 decisionHash) private {
        c.outcome = DisputeDecision.BuyerWins; o.status = Status.Refunded;
        uint256 total = o.gross + buyerSurcharge[id] - buyerDiscountAtFunding[id];
        uint256 buyerRefund = total / 2; uint256 burned = total - buyerRefund;
        escrowLiability -= total; claimLiability += buyerRefund; claimable[o.buyer] += buyerRefund;
        token.safeTransfer(DEAD_SINK, burned);
        emit Adjudicated(id, true, decisionHash); emit Refunded(id, o.buyer, buyerRefund); emit DisputeBurned(id, buyerRefund, burned);
    }
    function finalize(bytes32 id) external {
        Offer storage o = offers[id];
        require(o.status == Status.Delivered && block.timestamp >= uint256(o.deliveredAt) + DISPUTE_WINDOW, ErrNOT_FINALIZABLE());
        o.status = Status.Finalized; o.finalizedAt = uint64(block.timestamp);
        uint256 fee = o.gross - o.sellerAmount - o.referralAmount + buyerSurcharge[id] - buyerDiscountAtFunding[id];
        uint256 total = o.gross + buyerSurcharge[id] - buyerDiscountAtFunding[id];
        escrowLiability -= total; claimLiability += total;
        claimable[o.seller] += o.sellerAmount;
        if (o.referralAmount > 0) claimable[o.referrer] += o.referralAmount;
        // Retained treasury fees return to inactive reserve inventory; they are not independent revenue.
        claimable[o.treasury ? acquisitionVault : protocolRecipient] += fee;
        if (o.independent && !o.treasury) finalizedIndependentSpend[o.buyer] += total;
        emit Finalized(id, o.sellerAmount, o.referralAmount, fee);
    }
    function refundExpired(bytes32 id) external {
        Offer storage o = offers[id]; require(o.status == Status.Offered && block.timestamp > uint256(o.issuedAt) + QUOTE_LIFETIME, ErrNOT_EXPIRED()); _refund(id, o);
    }
    function cancelOffer(bytes32 id) external {
        Offer storage o = offers[id]; require(o.status == Status.Offered && msg.sender == o.buyer, ErrBUYER_OR_STATUS()); _refund(id, o);
    }
    function refundUndelivered(bytes32 id) external {
        Offer storage o = offers[id]; require(o.status == Status.Accepted && block.timestamp > uint256(o.acceptedAt) + DELIVERY_WINDOW, ErrNOT_OVERDUE()); _refund(id, o);
    }
    function _refund(bytes32 id, Offer storage o) private {
        uint256 total = o.gross + buyerSurcharge[id] - buyerDiscountAtFunding[id];
        o.status = Status.Refunded; escrowLiability -= total; claimLiability += total;
        claimable[o.buyer] += total; emit Refunded(id, o.buyer, total);
    }
    function claim() external nonReentrant { _claim(msg.sender); }
    /// Automation may pay a beneficiary's finalized proceeds, never redirect them to the caller.
    function claimFor(address beneficiary) external nonReentrant { _claim(beneficiary); }
    function _claim(address beneficiary) private {
        uint256 amount = claimable[beneficiary]; require(amount > 0, ErrNO_CLAIM());
        claimable[beneficiary] = 0; claimLiability -= amount;
        token.safeTransfer(beneficiary, amount); emit Claimed(beneficiary, amount);
    }
    function receiptForDemand(bytes32 id) external view returns (uint256 gross, uint64 finalizedAt, bool eligible, bytes32 reviewHash) {
        Offer storage o = offers[id];
        return (o.gross - buyerDiscountAtFunding[id], o.finalizedAt, o.status == Status.Finalized && o.independent && !o.treasury, o.reviewHash);
    }
    function mulBps(uint256 value, uint16 bps) public pure returns (uint256) {
        require(bps <= 10_000, ErrBPS()); return (value / 10_000) * bps + (value % 10_000) * bps / 10_000;
    }
    function mulBpsUp(uint256 value, uint16 bps) public pure returns (uint256) {
        require(bps <= 10_000, ErrBPS());
        uint256 amount = mulBps(value, bps); return mulmod(value, bps, 10_000) == 0 ? amount : amount + 1;
    }
}
