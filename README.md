# Quoral: enforceable market-maker agreements on Kuru

> The issuer locks inventory in a vault that can only quote. The market maker posts a bond and proves spread, depth and
> uptime **inside every requote transaction**. The retainer streams per block, missed epochs are clawed back
> automatically, terms are public, and the MM seat is won by RFQ.

Monad Metropolis · Track 01 *Onchain Finance & Trading*. "Quoral" = **quo**te + cho**ral**: quotes renewed in chorus every block.

Token projects pay market makers $3–7k/month per venue plus token loans and call options, under terms almost nobody
discloses (fewer than 1% of 150+ protocols, Novora 2026). Performance isn't measured, and the MM holds the inventory.
Binance now requires MM disclosure and bans profit-sharing, guaranteed returns and open-ended token loans (25 Mar 2026).
Quoral turns the agreement into a contract: the only levers are spread, depth, uptime and a time-based retainer.

## How it works

```
Issuer console ──┐                          ┌── Public Liquidity Terms page + SVG badge
MM console ──────┼── Next.js (Mera passkey) ┤    (RPC reads; Envio HyperIndex for history)
                 │                          └── House quoter (TS, Avellaneda–Stoikov; Privy policy-locked wallet)
                 ▼
Monad (143)
├── RFQAuction          issuer posts terms + retainer cap; bonded quoters bid retainer/block; issuer awards
├── AgreementFactory    CREATE2 clones per agreement: InventoryVault + Heartbeat + Paystream; funds from issuer
├── InventoryVault      Kuru margin owner + order owner; operator may only requote/cancel; inventory → issuer only
│   └── KuruV1Adapter   batchUpdate(postOnly=true), margin deposit/withdraw, pause detection
├── SLALib              spread/depth proof from the vault's own fresh quotes, in the same tx
├── Heartbeat           epoch bitmap; permissionless checkEpoch → clawback + uptime-window slash
├── Paystream           retainer escrow: per-block accrual, per-epoch settlement, protocol fee on claim
├── BondVault           free → locked (bid) → assigned (won) → slashed / released
├── DisclosureRegistry  termsHash → public URI, issuer + MM attestations, per-token index
└── CREKeeperReceiver   Chainlink CRE report → checkEpoch / flagPause jobs (try/catch isolated)
Keeper: CRE cron (30 s) → receiver; fallback: packages/bot/src/keeper.ts
```

**The proof.** `vault.requote(bids, bidSizes, asks, askSizes)`:

1. `onlyOperator`, agreement live, `epoch = (block.number − start) / epochBlocks`.
2. Kuru `batchUpdate(…, postOnly = true)`, cancelling the vault's previous quotes in the same call. The vault records the new order ids from Kuru's sequential `s_orderIdCounter`, so a restarted or careless operator can never leave stale quotes behind that cross the new ones. Any crossing reverts with `PostOnlyError`, so a successful call means the quotes are **resting on the book in this block**.
3. `SLALib` computes `spread = (bestAsk − bestBid) / mid` and the per-side notional within ±`maxSpreadBps` of mid from **these quotes**. It does not use `bestBidAsk()`, which blends the backstop AMM and uses sentinel values. A violation reverts the whole tx.
4. `Heartbeat.record(epoch, proof)` sets the bit and stores the proof.

Anyone can call `checkEpoch(e)`. It settles every unsettled ended epoch: quoted and excused epochs are paid, and a missed epoch's retainer goes straight back to the issuer. When misses in an uptime window exceed `window × (1 − uptimeBps)`, the bond is slashed to the issuer as liquidated damages. The issuer and the MM both have a reason to settle (clawback vs. getting paid), so the system stays live even without our keeper.

**What the SLA means.** Every epoch must contain a fresh two-sided quote with spread ≤ X and depth ≥ Y per side, measured at quote time. Fills inside the epoch consume depth. That is the same snapshot philosophy as Hummingbot/dYdX reward programs, but here it backs a contract and a penalty. At 300 ms blocks a 30 s epoch is close to continuous measurement.

## Verified against Kuru source (Kuru-Labs/Kuru-contracts-dex-public)

| Claim | Status |
|---|---|
| `batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)`, cancel then place, `postOnly` → `PostOnlyError` on any match | ✅ `OrderBook.sol` |
| Orders and margin are keyed by `_msgSender()`, so a contract can own both | ✅ (vault is the owner; tests + anvil demo) |
| `bestBidAsk()` is 1e18-scaled; empty bid = `type(uint256).max`, empty ask = 0 | ✅ (handled in `shared/kuru.ts`) |
| `marketState` public (ACTIVE / SOFT_PAUSED / HARD_PAUSED) | ✅ |
| **`MarginAccount.protocolPaused` readable** | ❌ **internal, no getter.** Quoral detects it with a static call to `debitUser`, which checks `protocolActive` before `verifiedMarket`, so the revert selector is `ProtocolPaused()` exactly when paused (`KuruV1Adapter.venuePaused`) |
| `addBuyOrder` requires `marketActive`, so SOFT_PAUSED blocks quoting | ✅ → treated as an excused epoch |

## Live testnet demo

**https://quoral.qvkare.com** reads Monad testnet (chain 10143). Kuru's own testnet markets run Kuru v2 (AccountCore),
while Quoral v1 targets the Kuru v1 OrderBook that is live on mainnet, so the testnet demo quotes on a test order book
with the Kuru v1 interface (`test/mocks/MockKuru.sol`) and test tokens. The site says so under the header.

| Contract | Address |
|---|---|
| AgreementFactory | `0xd81EB766691c8DA4c80580F544c48B9cb3220BbF` |
| RFQAuction | `0x3A0c8eEA637bfff6556a6bFfe4Decd1fC8dA428E` |
| BondVault | `0xBb262974478C984218da911E3B1632BBfE03984E` |
| DisclosureRegistry | `0x0954A3bD8dD78222B6574127D418820DE3e59eC7` |
| CREKeeperReceiver | `0xF9bfA6D01F9f8B18CEb8C17c61DFeaCD7eC695E7` |
| Demo agreement (InventoryVault) | `0x79Fc5C5F56F2b41CfBd333Ce954Bd4EEb5Ce1724` |
| Heartbeat / Paystream | `0x851FAa81834A147E037BFA1a133fe158BDDccc8A` / `0xa742A923893dbD06f328aF30e02E7e2a580390B8` |
| Test order book (Kuru v1 interface) | `0xA6969f93448056A7f477F69eaC3a77EA5988CAFd` |
| Test XAUt0 / test USDC | `0xAd0427f4502Ddf34b15F8e977E6B5a1dC1A08f8f` / `0x2480d7aDbe32E0Cdf09B2ce34d7CefB387cb47CE` |

The demo agreement uses 600-block epochs (about 3 minutes) for 30 days. The house quoter and keeper run as the
Cloudflare Worker in `packages/tick-worker`: a cron trigger every minute, at most one signed transaction per tick, and
a read-only health check at its workers.dev URL.

Deploying it yourself:

```bash
cd contracts && forge script script/DeployTestnet.s.sol --rpc-url monad_testnet --broadcast --slow
```

```bash
pnpm --filter @quoral/bot testnet:finish
```

The second step exists because of Monad's reserve balance rule: an account holding less than 10 MON can send a
transaction that dips under the reserve only if it sent nothing in the previous 3 blocks. A forge broadcast sends too
fast for small testnet wallets, so `testnet-finish` completes the RFQ, bids and award with 4 blocks between sends
and is safe to rerun.

## Repo layout

| Path | What |
|---|---|
| `contracts/` | Foundry. `src/` core contracts, `test/Quoral.t.sol` (24 tests incl. fuzz), `test/mocks/MockKuru.sol` (Kuru-faithful mock), `script/Deploy.s.sol` (mainnet/testnet), `script/DeployLocal.s.sol` (full demo on anvil) |
| `packages/shared` | Generated typed ABIs, deployments, chains (Monad 143 / 10143), Kuru price/size helpers |
| `packages/bot` | House quoter (A–S + inventory skew + SLA constraints), fallback keeper, Privy policy + setup, attack demo |
| `packages/tick-worker` | Cloudflare Worker that runs the house quoter and keeper on a one-minute cron for the testnet demo, with a read-only health check |
| `cre/quoral-keeper` | Chainlink CRE workflow (cron → EVM read → signed report → `CREKeeperReceiver`), typechecked against `@chainlink/cre-sdk` 1.23 |
| `packages/indexer` | Envio HyperIndex: factory-driven dynamic registration of vault/heartbeat/paystream, RFQs, bonds, Kuru fills |
| `packages/web` | Next.js 15: landing page, agreements explorer, issuer console (validated SLA form and cost summary), MM console, public `/<token>` terms page, `/badge/<agreement>` SVG; Mera passkey sign-in with time-to-first-tx. Design: the live agreement is drawn as a musical score (one bar per epoch, a chord per proven quote, a red-pencil rest per clawed-back epoch); see [`packages/web/DESIGN.md`](packages/web/DESIGN.md) |

## Quickstart (local, ~2 min)

Requirements: Foundry, Node 22, pnpm.

```bash
git submodule update --init --recursive && pnpm install
```

```bash
pnpm local:chain          # terminal 1: anvil, 1 s blocks, no history kept on disk
```

```bash
pnpm local:deploy         # mock Kuru XAUt0-USDC + Quoral + RFQ with 3 bids + award → contracts/deployments/31337.json
```

```bash
cp packages/bot/.env.example packages/bot/.env && pnpm bot      # terminal 2: house quoter
```

```bash
pnpm keeper               # terminal 3: settles epochs, flags pauses, finalizes
```

```bash
cp packages/web/.env.example packages/web/.env.local && pnpm web   # http://localhost:3000
```

Optional: `pnpm indexer` (Envio codegen + HyperIndex; needs Docker) and set `NEXT_PUBLIC_ENVIO_URL`.

Then open `/` and the agreement page. Sign in with a passkey, a browser wallet, or one of the local demo accounts.
`pnpm --filter @quoral/bot demo:attack` shows what a compromised operator key cannot do.

Tests:

```bash
pnpm test:contracts && pnpm --filter @quoral/bot test
```

## Deploy to Monad

```bash
cd contracts && cp .env.example .env && source .env && forge script script/Deploy.s.sol --rpc-url monad --broadcast --verify
```

Then run `pnpm abis` to push the addresses into `packages/shared`, uncomment the `143` block in
`packages/indexer/config.yaml`, set `receiver`/`factory` in `cre/quoral-keeper/config.json`, and point the bot and web at
`CHAIN_ID=143`.

**Venue constraint (verified):** `Router.deployProxy` is owner-gated on mainnet, so v1 targets existing active markets
(XAUt0-USDC, WETH-USDC, cbBTC-USDC, …) or a *new* token + market via `MonadDeployer.deployTokenAndMarket`. Native-MON
markets are rejected in v1 because the vault is ERC-20 only.

**Gas on Monad** is charged on `gas_limit`. The bot simulates, estimates, and sends with +15% headroom. One requote
(3 levels per side, cancel + place + proof + heartbeat) uses about 0.6–0.7M gas on the mock.

## Operator key: Privy policy-locked server wallet

`packages/bot/privy-policy.json` allows only `eth_sendTransaction` to the agreement vault, with value 0, on this chain.
Every other method (personal_sign, typed data, raw sign) is denied by default. Onchain, the vault already limits the
operator to `requote` and `cancel`, so even a fully compromised key cannot move inventory, send MON, give notice or
rotate itself. Rotating the operator takes issuer and MM together (2-of-2).

```bash
AGREEMENT=0x… PRIVY_APP_ID=… PRIVY_APP_SECRET=… pnpm --filter @quoral/bot privy:setup
```

## Design decisions & honest limits

- **Excused epochs are paid**, as force majeure. They only come from venue pauses (`marketState != ACTIVE`, or a MarginAccount protocol pause), flagged permissionlessly during the epoch.
- **Settlement is sequential** (cursor) so the MM can't claim retainer for an epoch that might still be clawed back.
- **Slashing**: one `slashAmount` per uptime window at the moment misses exceed the allowance. It is capped by the remaining bond and paid to the issuer.
- **Off-market quotes**: post-only stops the vault crossing the book, but a colluding operator could quote a tight market at a stale price on an empty book. A reference-price band (oracle or `getL2Book` sanity check) is next.
- **No volume or price targets, no token loans, no call options** exist in the contract by construction. The fee is time-based, not per trade.
- The Envio indexer is codegen- and type-checked; running it needs Docker (`pnpm --filter @quoral/indexer dev`). The web app reads live state straight from RPC and doesn't depend on it.
- The CRE workflow is typechecked against the real SDK but not yet simulated on a DON (`cre workflow simulate`).

## Bounty mapping

- **Track 01**: fully onchain order-book liquidity contracts.
- **Kuru**: built on the Kuru CLOB (MonadDeployer path for a new asset and market + Quoral agreement).
- **Envio**: HyperIndex behind the Terms page history.
- **Chainlink CRE**: epoch keeper workflow plus onchain receiver.
- **Privy**: policy-locked server wallet for the quoter.
- **Mera**: passkey sign-in (`@category-labs/mera`, PRF → app-side key → zeroizable session), with time-to-first-tx shown in the UI.

## Submission checklist

- [x] MIT licence
- [ ] Public repo (the repo is private for now; make it public before submitting)
- [ ] ≤ 3 min video
- [x] Testnet contract addresses (above)
- [ ] Mainnet contract addresses (`contracts/deployments/143.json` after a mainnet deploy)
- [ ] AI tooling disclosure (in the submission form)
- [x] Prior work statement (below)

**Prior work:** the author's earlier open-source projects (Verdict Layer, OpenGrant, CovenantOS, linea-mcp) share no
contracts or code with Quoral. Everything here was written for Metropolis.
