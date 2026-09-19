# Contract authority

The [ThotGovernor](../contracts/src/ThotGovernor.sol) implementation uses an
immutable threshold of one: any one configured owner can execute an authorized
action. Three configured owners do not provide a two-person approval boundary.
The target contract still enforces its own spending limits and timelocks.
Approvals are wallet-signed onchain transactions through this controller, not
Safe offchain signatures.

To review a deployment, independently obtain its chain ID and contract addresses,
compare runtime code with the reviewed build, and inspect the actual owner set,
threshold and target permissions. This source tree supplies no accepted live
contract inventory. Source defaults do not establish deployed configuration.

Read [the governor tests](../contracts/test/thot-governor.test.mjs),
[market authority](../packages/market/src/thot-governance.ts), and
[the security model](security-model.md) together. Marketplace governance does not
establish control over enclave updates or key release; the deployment's KMS policy
and administrators must be checked separately.
