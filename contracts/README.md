# Quoral contracts

Foundry project for the Quoral agreement contracts. See the [main README](../README.md) for the design.

| Contract | Role |
|---|---|
| `src/RFQAuction.sol` | Issuer opens terms with a retainer cap; bonded market makers bid a retainer per block; `award(id, bidder, expectedRetainer)` deploys the agreement |
| `src/AgreementFactory.sol` | Validates terms, clones `InventoryVault` + `Heartbeat` + `Paystream` (CREATE2), funds them from the issuer, registers the bond and the disclosure |
| `src/InventoryVault.sol` | Owns the Kuru margin and orders. `requote` cancels the previous quotes, places new ones post-only and proves the SLA in the same call; drift cap; one-sided quotes when a side's inventory is used up; no cancel while live |
| `src/adapters/KuruV1Adapter.sol` | Kuru v1 calls: `batchUpdate`, `batchCancelOrdersNoRevert`, margin, pause detection |
| `src/libraries/SLALib.sol` | Spread and depth proof from the vault's own quotes |
| `src/Heartbeat.sol` | Epoch bitmap, permissionless `checkEpoch` (clawback, uptime-window slash) and `flagPause` |
| `src/Paystream.sol` | Retainer escrow, per-epoch settlement, protocol fee on claim |
| `src/BondVault.sol` | Bonds: free, locked by a bid, assigned to an agreement, slashed or released |
| `src/DisclosureRegistry.sol` | Terms hash, public URI, attestations, per-token index |
| `src/keepers/CREKeeperReceiver.sol` | Chainlink CRE consumer that runs `checkEpoch` / `flagPause` jobs |

## Test

```bash
forge test
```

`test/Quoral.t.sol` runs against `test/mocks/MockKuru.sol`, a book that follows Kuru v1's semantics (post-only,
margin-funded orders, FIFO market orders with partial fills, and Kuru's cancel rules for filled orders).

The fork test runs the same flow against the real Kuru contracts on Monad mainnet (XAUt0-USDC):

```bash
MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-contract KuruMainnetFork -vv
```

## Deploy

| Script | Target |
|---|---|
| `script/DeployLocal.s.sol` | anvil: mock Kuru, Quoral, an RFQ with three bids and an award (`pnpm local:deploy` from the repo root) |
| `script/DeployTestnet.s.sol` | Monad testnet demo: test book set up like Kuru's XAUt0-USDC, Quoral, RFQ; then `pnpm --filter @quoral/bot testnet:finish` |
| `script/Deploy.s.sol` | Monad mainnet core against the real Kuru MarginAccount |

Addresses are written to `deployments/<chainId>.json`; `pnpm abis` copies them and the ABIs into `packages/shared`.
