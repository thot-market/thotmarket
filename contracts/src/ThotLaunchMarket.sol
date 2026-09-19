// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import "./ThotMarket.sol";

/// Fresh percentage-fee deployment. Legacy fixed-tariff instances are unchanged.
/// The deployer must explicitly select the intended chain; runtime/configuration
/// verification remains mandatory before funding or public activation.
contract ThotLaunchMarket is ThotMarket {
    constructor(address token_, address locks_, address reserve_, address governor_,
        address operator_, address recipient_, uint256 expectedChainId)
        ThotMarket(token_, locks_, reserve_, governor_, operator_, recipient_) {
        require(expectedChainId != 0 && block.chainid == expectedChainId, "CHAIN");
        _setFee(100);
        paused = true;
    }
    function _validateDeploymentChain() internal view override {}
    function feeModelVersion() external pure returns (uint256) { return 2; }
    // ABI-compatible tariff metadata: directCost is zero and allocatedOverhead
    // carries fee basis points in model v2, never a token cost allowance.
    function _setFee(uint16 bps) private {
        require(bps > 0 && bps <= 1000, "FEE_CAP");
        tariff = Tariff(0, bps, keccak256(abi.encode("thot.percentage-fee/1", bps)));
        emit TariffActivated(0, bps, tariff.policyHash);
    }
    function setServiceFeeBps(uint16 bps) external onlyGovernor { _setFee(bps); }
    function queueTariff(uint256, uint256, bytes32) external pure override returns (bytes32) { revert("PERCENTAGE_FEE_ONLY"); }
    function executeTariff(uint256, uint256, bytes32) external pure override { revert("PERCENTAGE_FEE_ONLY"); }
    function costQuote(uint256 gross) public view override returns (uint256 serviceFee,
        uint256 directCost, uint256 netContribution, uint256 sellerAmount, bytes32 policyHash) {
        require(gross > 0 && gross <= 1_000_000_000 ether, "PRICE");
        serviceFee = mulBpsUp(gross, uint16(tariff.allocatedOverhead));
        directCost = 0; netContribution = serviceFee;
        sellerAmount = gross - serviceFee; policyHash = tariff.policyHash;
    }
}
