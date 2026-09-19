// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal public settlement commitments; no trace, identity, or receipt contents.
contract SettlementRegistry {
    address public immutable admin;
    address public recorder;
    mapping(bytes32 => bytes32) public settlementHashes;
    mapping(bytes32 => bytes32) public batchRoots;
    bytes32 public constant SPLIT_POLICY = keccak256("thot.split/1:65-contributor,20-burn,15-operator");

    event RecorderBound(address indexed recorder);
    event SettlementRecorded(bytes32 indexed settlementId, bytes32 indexed mandateId,
        bytes32 commitment, uint256 gross, uint256 directCosts, uint256 contributorAmount,
        uint256 burnAmount, uint256 operatorAmount);
    event BatchAnchored(bytes32 indexed batchId, bytes32 root, uint256 gross, uint256 directCosts,
        uint256 contributorAmount, uint256 burnAmount, uint256 operatorAmount);

    constructor(address admin_) {
        require(admin_ != address(0), "ZERO_ADMIN");
        admin = admin_;
    }

    /// @notice One-time binding avoids a circular constructor dependency with the escrow.
    function bindRecorder(address recorder_) external {
        require(msg.sender == admin && recorder == address(0), "NOT_AUTHORIZED");
        require(recorder_.code.length > 0, "RECORDER_NOT_CONTRACT");
        recorder = recorder_;
        emit RecorderBound(recorder_);
    }

    function split(uint256 eligibleNet) public pure returns (uint256 contributorAmount, uint256 burnAmount, uint256 operatorAmount) {
        // Quotient/remainder form cannot overflow for any uint256 gross.
        contributorAmount = (eligibleNet / 100) * 65 + ((eligibleNet % 100) * 65) / 100;
        burnAmount = (eligibleNet / 100) * 20 + ((eligibleNet % 100) * 20) / 100;
        operatorAmount = eligibleNet - contributorAmount - burnAmount;
    }

    function record(bytes32 settlementId, bytes32 mandateId, bytes32 commitment,
        uint256 gross, uint256 directCosts, uint256 contributorAmount, uint256 burnAmount, uint256 operatorAmount) external {
        require(msg.sender == recorder, "NOT_RECORDER");
        require(settlementId != bytes32(0) && mandateId != bytes32(0) && commitment != bytes32(0), "EMPTY_ID");
        require(gross > 0 && settlementHashes[settlementId] == bytes32(0), "INVALID_OR_REPLAYED_SETTLEMENT");
        require(directCosts <= gross, "INVALID_COSTS");
        (uint256 u, uint256 b, uint256 o) = split(gross - directCosts);
        require(contributorAmount == u && burnAmount == b && operatorAmount == o, "INVALID_SPLIT");
        bytes32 digest = keccak256(abi.encode(settlementId, mandateId, commitment, gross, directCosts, u, b, o, SPLIT_POLICY));
        settlementHashes[settlementId] = digest;
        emit SettlementRecorded(settlementId, mandateId, commitment, gross, directCosts, u, b, o);
    }

    function anchorBatch(bytes32 batchId, bytes32 root, uint256 gross, uint256 directCosts,
        uint256 contributorAmount, uint256 burnAmount, uint256 operatorAmount) external {
        require(msg.sender == recorder, "NOT_RECORDER");
        require(batchId != bytes32(0) && root != bytes32(0), "EMPTY_ID");
        require(batchRoots[batchId] == bytes32(0), "BATCH_REPLAY");
        require(directCosts <= gross && contributorAmount + burnAmount + operatorAmount == gross - directCosts,
            "UNBALANCED_BATCH");
        // Aggregate rounding is the sum of per-sale rounding, not a new split of the batch total.
        batchRoots[batchId] = root;
        emit BatchAnchored(batchId, root, gross, directCosts, contributorAmount, burnAmount, operatorAmount);
    }
}
