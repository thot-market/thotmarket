// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, IBurnableToken, SafeToken} from "./TokenInterfaces.sol";

interface ITraceRouter {
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external returns (uint256[] memory);
}

/// Local Anvil integration candidate. Unaudited; not approved for public funds.
/// Buyer funds stay refundable until the entire sale succeeds atomically. The
/// operator selects matches; the contributor signs exact bytes, terms and payout.
/// No credit entitlement is created by this token-only settlement path.
contract AtomicTraceMarket {
    using SafeToken for IERC20;
    IERC20 public immutable payment;
    IBurnableToken public immutable thot;
    ITraceRouter public immutable router;
    address public immutable operator;
    address public immutable treasury;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant APPROVAL_TYPEHASH = keccak256("Approval(bytes32 licenseId,bytes32 mandateId,bytes32 releaseHash,bytes32 termsHash,address recipient,uint256 gross,uint256 minThot,uint256 deadline)");
    struct Mandate { address buyer; bytes32 commitment; uint256 maxUnit; uint256 available; }
    struct Approval { bytes32 licenseId; bytes32 mandateId; bytes32 releaseHash; bytes32 termsHash; address recipient; uint256 gross; uint256 minThot; uint256 deadline; }
    struct Receipt { bytes32 approvalHash; uint256 paidThot; uint256 burnedThot; }
    mapping(bytes32 => Mandate) public mandates;
    mapping(bytes32 => Receipt) public receipts;
    mapping(address => mapping(bytes32 => bool)) public revoked;
    bool public paused;
    bool private entered;
    event Funded(bytes32 indexed mandateId, address indexed buyer, bytes32 commitment, uint256 amount, uint256 maxUnit);
    event Refunded(bytes32 indexed mandateId, address indexed buyer, uint256 amount);
    event Settled(bytes32 indexed licenseId, bytes32 indexed mandateId, address indexed recipient, bytes32 approvalHash, uint256 gross, uint256 paidThot, uint256 burnedThot, uint256 operatorPayment);
    modifier locked() { require(!entered, "REENTRY"); entered = true; _; entered = false; }
    modifier onlyOperator() { require(msg.sender == operator, "OPERATOR_ONLY"); _; }
    constructor(IERC20 p, IBurnableToken w, ITraceRouter r, address o, address t) {
        require(address(p)!=address(0) && address(w)!=address(0) && address(r)!=address(0) && o!=address(0) && t!=address(0), "ZERO_ADDRESS");
        require(address(p)!=address(w), "SAME_TOKEN");
        payment=p; thot=w; router=r; operator=o; treasury=t;
        DOMAIN_SEPARATOR=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("THOT Trace Market"), keccak256("1"), block.chainid, address(this)));
    }
    function setPaused(bool value) external onlyOperator { paused=value; }
    function deposit(bytes32 id, bytes32 commitment, uint256 maxUnit, uint256 amount) external locked {
        require(!paused && id!=bytes32(0) && commitment!=bytes32(0), "INVALID_MANDATE");
        require(mandates[id].buyer==address(0) && amount>=maxUnit && maxUnit>0, "ALREADY_FUNDED_OR_AMOUNT");
        uint256 beforeBalance=payment.balanceOf(address(this));
        payment.safeTransferFrom(msg.sender,address(this),amount);
        require(payment.balanceOf(address(this))-beforeBalance==amount, "EXACT_PAYMENT_REQUIRED");
        mandates[id]=Mandate(msg.sender,commitment,maxUnit,amount);
        emit Funded(id,msg.sender,commitment,amount,maxUnit);
    }
    function refund(bytes32 id, uint256 amount) external locked {
        Mandate storage m=mandates[id];
        require(msg.sender==m.buyer && amount>0 && amount<=m.available, "REFUND_DENIED");
        m.available-=amount; payment.safeTransfer(msg.sender,amount); emit Refunded(id,msg.sender,amount);
    }
    function revoke(bytes32 licenseId) external { revoked[msg.sender][licenseId]=true; }
    function approvalHash(Approval calldata a) public view returns(bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(APPROVAL_TYPEHASH,a))));
    }
    function settle(Approval calldata a, bytes calldata signature) external onlyOperator locked {
        require(!paused && block.timestamp<=a.deadline && a.minThot>0, "PAUSED_OR_EXPIRED");
        require(receipts[a.licenseId].approvalHash==bytes32(0) && !revoked[a.recipient][a.licenseId], "ALREADY_SETTLED_OR_REVOKED");
        require(a.releaseHash!=bytes32(0) && a.termsHash!=bytes32(0) && a.licenseId!=bytes32(0), "EMPTY_COMMITMENT");
        bytes32 digest=approvalHash(a);
        require(signature.length==65, "BAD_SIGNATURE");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r:=calldataload(signature.offset) s:=calldataload(add(signature.offset,32)) v:=byte(0,calldataload(add(signature.offset,64))) }
        require(uint256(s)<=0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 && (v==27 || v==28), "BAD_SIGNATURE");
        require(a.recipient!=address(0) && ecrecover(digest,v,r,s)==a.recipient, "WRONG_SIGNER");
        Mandate storage m=mandates[a.mandateId];
        require(a.gross>0 && a.gross<=m.maxUnit && a.gross<=m.available, "INSUFFICIENT_ESCROW");
        // USDC-denominated ledger minor units are six-decimal payment atoms.
        // Direct costs are zero. Integer remainders go to the operator.
        uint256 contributor=a.gross*65/100;
        uint256 burnAllocation=a.gross*20/100;
        uint256 spend=contributor+burnAllocation;
        require(spend>0, "DUST_SALE");
        m.available-=a.gross;
        address[] memory path=new address[](2); path[0]=address(payment); path[1]=address(thot);
        uint256 beforeThot=IERC20(address(thot)).balanceOf(address(this));
        require(paymentApprove(address(router),spend), "APPROVE_FAILED");
        router.swapExactTokensForTokens(spend,a.minThot,path,address(this),a.deadline);
        require(paymentApprove(address(router),0), "APPROVE_FAILED");
        uint256 acquired=IERC20(address(thot)).balanceOf(address(this))-beforeThot;
        require(acquired>=a.minThot, "SLIPPAGE");
        uint256 paid=acquired*contributor/spend;
        uint256 burned=acquired-paid;
        receipts[a.licenseId]=Receipt(digest,paid,burned);
        IERC20(address(thot)).safeTransfer(a.recipient,paid);
        thot.burn(burned);
        payment.safeTransfer(treasury,a.gross-spend);
        emit Settled(a.licenseId,a.mandateId,a.recipient,digest,a.gross,paid,burned,a.gross-spend);
    }
    function paymentApprove(address spender,uint256 amount) private returns(bool) {
        (bool ok,bytes memory data)=address(payment).call(abi.encodeWithSignature("approve(address,uint256)",spender,amount));
        return ok && (data.length==0 || abi.decode(data,(bool)));
    }
}
