import { Interface } from 'ethers';

// Pinned Safe 1.4.1 deployment artifacts; no environment owner identities.
export const DEPLOYMENT = Object.freeze({
  chainId: 8453, version: '1.4.1',
  singleton: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  singletonHash: '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4',
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  factoryHash: '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317',
  proxyCreationHash: '0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f',
  proxyRuntimeHash: '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c',
  manifestSource: 'https://github.com/safe-global/safe-deployments/tree/7b1fb6d615ab2d2999550ec9166554b180e813e5/src/assets/v1.4.1',
  proxySource: 'https://unpkg.com/@safe-global/safe-contracts@1.4.1/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json',
  appInterfaceSource: 'https://docs.phala.com/phala-cloud/key-management/multisig-governance',
});

export const SAFE = new Interface([
  'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
  'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)', 'function VERSION() view returns (string)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function changeThreshold(uint256 threshold)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns(bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)',
]);
export const FACTORY = new Interface([
  'function proxyCreationCode() view returns (bytes)',
  'function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns(address proxy)',
]);
