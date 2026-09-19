// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// Minimal 1-of-3 controller on every chain. This is custom, unaudited
/// code, not a Safe deployment. Target contracts retain their own spending caps
/// and timelocks. The controller accepts no ETH and never uses delegatecall.
contract ThotGovernor {
    uint256 public immutable THRESHOLD;
    address[3] public owners;
    mapping(address => bool) public isOwner;
    uint256 public nextNonce;
    struct Operation { address target; bytes data; uint8 confirmations; bool executed; }
    mapping(bytes32 => Operation) private operations;
    bytes32[] private operationIds;
    mapping(bytes32 => mapping(address => bool)) public approved;
    uint256 private entered;
    event Submitted(bytes32 indexed id, uint256 indexed nonce, address indexed target, bytes data);
    event Confirmed(bytes32 indexed id, address indexed owner);
    event Revoked(bytes32 indexed id, address indexed owner);
    event Executed(bytes32 indexed id, address indexed target);
    modifier onlyOwner() { require(isOwner[msg.sender], "OWNER"); _; }
    constructor(address[3] memory owners_) {
        THRESHOLD = 1;
        for (uint256 i; i < 3; i++) {
            require(owners_[i] != address(0) && !isOwner[owners_[i]], "OWNERS");
            owners[i] = owners_[i]; isOwner[owners_[i]] = true;
        }
    }
    function getOwners() external view returns (address[] memory result) {
        result = new address[](3); for (uint256 i; i < 3; i++) result[i] = owners[i];
    }
    function getThreshold() external view returns (uint256) { return THRESHOLD; }
    function operationCount() external view returns (uint256) { return operationIds.length; }
    function operationIdAt(uint256 index) external view returns (bytes32) { return operationIds[index]; }
    function operationId(uint256 nonce, address target, bytes memory data) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), nonce, target, keccak256(data)));
    }
    function submit(address target, bytes memory data) public onlyOwner returns (bytes32 id) {
        require(target.code.length > 0 && target != address(this) && data.length >= 4, "TARGET");
        uint256 nonce = nextNonce++;
        id = operationId(nonce, target, data);
        operations[id] = Operation(target, data, 1, false);
        operationIds.push(id);
        approved[id][msg.sender] = true;
        emit Submitted(id, nonce, target, data); emit Confirmed(id, msg.sender);
    }
    /// Any one owner can record and execute an operation in one transaction.
    function submitAndExecute(address target, bytes calldata data) external onlyOwner returns (bytes memory result) {
        require(THRESHOLD == 1, "APPROVALS");
        return execute(submit(target, data));
    }
    function confirm(bytes32 id) external onlyOwner {
        Operation storage op = operations[id];
        require(op.target != address(0) && !op.executed && !approved[id][msg.sender], "CONFIRM");
        approved[id][msg.sender] = true; op.confirmations++; emit Confirmed(id, msg.sender);
    }
    function revoke(bytes32 id) external onlyOwner {
        Operation storage op = operations[id];
        require(!op.executed && approved[id][msg.sender], "REVOKE");
        approved[id][msg.sender] = false; op.confirmations--; emit Revoked(id, msg.sender);
    }
    function operation(bytes32 id) external view returns (address target, bytes memory data, uint8 confirmations, bool executed) {
        Operation storage op = operations[id]; return (op.target, op.data, op.confirmations, op.executed);
    }
    /// Anyone may relay an already approved operation. Failed target calls preserve
    /// confirmations so a timelocked execution can be retried when its delay ends.
    function execute(bytes32 id) public returns (bytes memory result) {
        require(entered == 0, "REENTRANT"); entered = 1;
        Operation storage op = operations[id];
        require(op.target != address(0) && !op.executed && op.confirmations >= THRESHOLD, "APPROVALS");
        op.executed = true;
        bool ok; (ok, result) = op.target.call(op.data);
        if (!ok) { assembly ("memory-safe") { revert(add(result, 32), mload(result)) } }
        entered = 0; emit Executed(id, op.target);
    }
}
