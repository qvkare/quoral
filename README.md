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
├── InventoryVault      Kuru margin owner + order owner; operator may only requote; inventory → issuer only
│   └── KuruV1Adapter   batchUpdate(postOnly=true), no-revert cancel, margin deposit/withdraw, pause detection
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
4. The quoted mid may move at most `maxMidMoveBps` per epoch from the mid proven before the epoch began (scaled by the epochs since then). Every requote in an epoch is measured against the same anchor, so a key cannot walk the price away from the market in small steps.
5. `Heartbeat.record(epoch, proof)` sets the bit and stores the proof.

There is no `cancel` while the agreement is live: quotes leave the book only when they are filled or replaced by SLA-compliant ones, so a quote cannot be posted for the proof and pulled right after. Once the agreement ends, anyone can pull the vault's quotes (through Kuru's `batchCancelOrdersNoRevert`, because a filled order makes `batchCancelOrders` revert) and only the issuer can withdraw.

Anyone can call `checkEpoch(e)`. It settles every unsettled ended epoch: quoted and excused epochs are paid, and a missed epoch's retainer goes straight back to the issuer. When misses in an uptime window exceed `window × (1 − uptimeBps)`, the bond is slashed to the issuer as liquidated damages. The issuer and the MM both have a reason to settle (clawback vs. getting paid), so the system stays live even without our keeper.

**What the SLA means.** Every epoch must contain a fresh two-sided quote with spread ≤ X and depth ≥ Y per side, measured at quote time. Fills inside the epoch consume depth. That is the same snapshot philosophy as Hummingbot/dYdX reward programs, but here it backs a contract and a penalty. At 300 ms blocks a 30 s epoch is close to continuous measurement.

**When a side runs out.** Inventory belongs to the issuer, so a trending market can sell out one side through no fault of the market maker. A side meets the depth term if the vault posts *everything* it has of that token inside the band (checked onchain from the vault's margin right after placement), and a side with nothing left may be omitted, measured against the last proven mid. The epoch counts as quoted and the vault emits `InventoryLimited`; the issuer tops up with `addInventory`.

## Verified against Kuru source (Kuru-Labs/Kuru-contracts-dex-public)

| Claim | Status |
|---|---|
| `batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)`, cancel then place, `postOnly` → `PostOnlyError` on any match | ✅ `OrderBook.sol` |
| Orders and margin are keyed by `_msgSender()`, so a contract can own both | ✅ (vault is the owner; tests + anvil demo) |
| `bestBidAsk()` is 1e18-scaled; empty bid = `type(uint256).max`, empty ask = 0 | ✅ (handled in `shared/kuru.ts`) |
| `marketState` public (ACTIVE / SOFT_PAUSED / HARD_PAUSED) | ✅ |
| **`MarginAccount.protocolPaused` readable** | ❌ **internal, no getter.** Quoral detects it with a static call to `debitUser`, which checks `protocolActive` before `verifiedMarket`, so the revert selector is `ProtocolPaused()` exactly when paused (`KuruV1Adapter.venuePaused`) |
| `addBuyOrder` requires `marketActive`, so SOFT_PAUSED blocks quoting | ✅ → treated as an excused epoch |
| `batchCancelOrders` reverts with `OrderAlreadyFilledOrCancelled` on a filled id; `batchUpdate` and `batchCancelOrdersNoRevert` skip it | ✅ `OrderBook._cancelOrder`; the deployed mainnet implementation has `batchCancelOrdersNoRevert` (selector `0x43c1eed6`) |
| All of the above against the **live** contracts | ✅ `test/fork/KuruMainnetFork.t.sol` forks Monad mainnet and runs Quoral on Kuru's XAUt0-USDC book: a proof one tick inside the real spread, Kuru rejecting a crossing quote, a real market buy filling the vault's ask, `batchCancelOrders` reverting on it, and the vault's cancel and the issuer's withdrawal still working |

## Live testnet demo

**https://quoral.qvkare.com** reads Monad testnet (chain 10143) and every number on it comes from real transactions.
Kuru's own testnet markets run Kuru v2 (AccountCore), while Quoral v1 targets the Kuru v1 OrderBook that is live on
mainnet, so the testnet demo quotes on a test order book with the Kuru v1 interface (`test/mocks/MockKuru.sol`), set
up like Kuru's mainnet XAUt0-USDC market (price precision 1e4, size precision 1e6, tick 100, minimum size 2000). The
site says so under the header. The mainnet fork test covers the real Kuru contracts.

What runs, all onchain:

- **The agreement** `0xe66927bC8fd1F51F66E324c9D60eD4418bd0CCd7`, won by RFQ at 9,500 test-USDC units per block
  against bids of 11,000 and 12,000: 10 XAUt0 and 50,000 USDC of test inventory, spread ≤ 50 bps, depth ≥ 10,000 USDC
  per side, 1,980-block epochs (about 10 minutes), 85% uptime per 12-epoch window, 500 USDC slash per breach, mid
  drift ≤ 1.5% per epoch, 30 days.
- **The house quoter and keeper**: the Cloudflare Worker in `packages/tick-worker`, a cron trigger every minute with at
  most one signed transaction per tick. It quotes around the **live mid of Kuru's XAUt0-USDC book on Monad mainnet**
  (read from `rpc.monad.xyz`), with an Avellaneda-Stoikov inventory skew inside the drift cap, settles every hour, and
  serves a health check at https://quoral-tick.qvkare.workers.dev (HTTP 503 once quoting falls behind).
- **An independent taker** (a separate key in the same worker) sends market buys and sells against the book now and
  then, so the vault sees real fills, its inventory moves, and the skew reacts.
- **History**: the Envio indexer (`packages/indexer`) records every proof, fill, clawback and slash with its
  transaction hash; the agreement page shows it when `NEXT_PUBLIC_ENVIO_URL` is set, and falls back to contract state.

Contract addresses and the transactions behind each step are listed in [Testnet record](#testnet-record) at the end.

Deploying it yourself (contracts and RFQ first, then bids and award):

```bash
cd contracts && forge script script/DeployTestnet.s.sol --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 115
```

```bash
pnpm --filter @quoral/bot testnet:finish
```

The second step exists because of Monad's reserve balance rule: an account holding less than 10 MON can send a
transaction that dips under the reserve only if it sent nothing in the previous 3 blocks. A forge broadcast sends too
fast for small testnet wallets, so `testnet-finish` funds the bidders and the taker, places the bonded bids and awards
the lowest with 4 blocks between sends, and is safe to rerun. Monad bills the gas limit, so every sender estimates and
adds 15% rather than forge's default 30%.

## Repo layout

| Path | What |
|---|---|
| `contracts/` | Foundry. `src/` core contracts, `test/Quoral.t.sol` (39 tests incl. fuzz), `test/fork/KuruMainnetFork.t.sol` (2 tests against the live Kuru contracts on a Monad mainnet fork), `test/mocks/MockKuru.sol` (Kuru-faithful book with market orders), `script/Deploy.s.sol` (mainnet), `script/DeployTestnet.s.sol` (public demo), `script/DeployLocal.s.sol` (full demo on anvil) |
| `packages/shared` | Generated typed ABIs, deployments, chains (Monad 143 / 10143), Kuru price/size helpers |
| `packages/bot` | House quoter (A–S + inventory skew + SLA constraints), fallback keeper, Privy policy + setup, attack demo, `testnet-finish` |
| `packages/tick-worker` | Cloudflare Worker for the testnet demo: house quoter tracking Kuru mainnet, keeper, an independent taker, health check |
| `cre/quoral-keeper` | Chainlink CRE workflow (cron → EVM read → signed report → `CREKeeperReceiver`), with a `local-simulation` target for Monad testnet |
| `packages/indexer` | Envio HyperIndex on the testnet demo (`config.local.yaml` for anvil): factory-driven registration of vault/heartbeat/paystream, RFQs, bonds, Kuru fills, every proof with its hash |
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

Optional: `pnpm --filter @quoral/indexer dev:local` (Envio HyperIndex on anvil; needs Docker) and set
`NEXT_PUBLIC_ENVIO_URL=http://localhost:8080/v1/graphql`.

Then open `/` and the agreement page. Sign in with a passkey, a browser wallet, or one of the local demo accounts.
`pnpm --filter @quoral/bot demo:attack` shows what a compromised operator key cannot do.

Tests:

```bash
pnpm test:contracts && pnpm --filter @quoral/bot test
```

Against the live Kuru contracts on a Monad mainnet fork (skipped when `MONAD_RPC_URL` is unset):

```bash
cd contracts && MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-contract KuruMainnetFork -vv
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

**Gas on Monad** is charged on `gas_limit`. The bot and the worker estimate and send with +15% headroom. One requote
(cancel + place + proof + heartbeat) costs a 0.45M to 0.6M gas limit with one level per side, about 0.05 MON at the
100 gwei floor; on the testnet demo the operator spends roughly 0.3 MON an hour at 10-minute epochs.

## Operator key: Privy policy-locked server wallet

`packages/bot/privy-policy.json` allows only `eth_sendTransaction` to the agreement vault, with value 0, on this chain.
Every other method (personal_sign, typed data, raw sign) is denied by default. Onchain, the vault already limits the
operator to `requote`, so even a fully compromised key cannot move inventory, send MON, give notice, rotate itself or
pull its quotes after a proof, and it can move the quoted mid only within the drift cap. Rotating the operator takes
issuer and MM together (2-of-2). The testnet worker signs with a plain key held as a Cloudflare secret; the Privy path
is wired but not running there.

```bash
AGREEMENT=0x… PRIVY_APP_ID=… PRIVY_APP_SECRET=… pnpm --filter @quoral/bot privy:setup
```

## Design decisions & honest limits

- **Excused epochs are paid**, as force majeure. They only come from venue pauses (`marketState != ACTIVE`, or a MarginAccount protocol pause), flagged permissionlessly during the epoch.
- **Settlement is sequential** (cursor) so the MM can't claim retainer for an epoch that might still be clawed back.
- **Slashing**: one `slashAmount` per uptime window at the moment misses exceed the allowance. It is capped by the remaining bond and paid to the issuer.
- **Off-market quotes**: post-only stops the vault crossing the book, and the drift cap stops a key from moving the quoted mid more than `maxMidMoveBps` per epoch from the last proof. On a book with no other makers, a colluding operator could still lean on the price within that cap and trade against it from another account; the cap turns a one-transaction drain into a slow, public walk on the score. An oracle band is the next step. The first proof of an agreement sets the reference freely.
- **No cancel while live**: the MM cannot pull quotes in an emergency; it can only replace them with compliant ones. The issuer's levers are notice and, with the MM, operator rotation.
- **Inventory shortfall is the issuer's**: a side that runs out is excused by posting everything left (`InventoryLimited`); a two-sided SLA needs inventory on both sides at the start.
- **No volume or price targets, no token loans, no call options** exist in the contract by construction. The fee is time-based, not per trade.
- The Envio indexer runs on the testnet demo through the public RPC (HyperSync now needs an API token); hosting it on Envio Cloud takes a GitHub connection in the Envio dashboard. The web app reads live state straight from RPC and uses the indexer only for history.
- The CRE workflow is typechecked against the real SDK and has a `local-simulation` target that writes through Chainlink's MockKeystoneForwarder on Monad testnet; running it needs `cre login`. Deploying to a DON needs Chainlink's approval.
- The testnet agreement was deployed before the first-epoch drift fix (commit `ccb2e5c`), so its epoch 0 was uncapped; every later epoch is capped.

## Bounty mapping

- **Track 01**: fully onchain order-book liquidity contracts.
- **Kuru**: built on the Kuru v1 CLOB and tested against the live XAUt0-USDC book on a mainnet fork; the testnet quoter tracks that book's mid.
- **Envio**: HyperIndex behind the Terms page history.
- **Chainlink CRE**: epoch keeper workflow plus onchain receiver.
- **Privy**: policy-locked server wallet for the quoter.
- **Mera**: passkey sign-in (`@category-labs/mera`, PRF → app-side key → zeroizable session), with time-to-first-tx shown in the UI.

## Submission checklist

- [x] MIT licence
- [ ] Public repo (the repo is private for now; make it public before submitting)
- [ ] ≤ 3 min video
- [x] Testnet contract addresses and transactions ([Testnet record](#testnet-record))
- [ ] Mainnet contract addresses (`contracts/deployments/143.json` after a mainnet deploy)
- [ ] AI tooling disclosure (in the submission form)
- [x] Prior work statement (below)

**Prior work:** the author's earlier open-source projects (Verdict Layer, OpenGrant, CovenantOS, linea-mcp) share no
contracts or code with Quoral. Everything here was written for Metropolis.

## Testnet record

Everything below is on Monad testnet (chain 10143) and can be checked on [MonadVision](https://testnet.monadvision.com). The demo uses test
tokens only.

### Contracts

| Contract | Address |
|---|---|
| AgreementFactory | [`0x6aca764607C1E69f82C4D81042392D7E194eF399`](https://testnet.monadvision.com/address/0x6aca764607C1E69f82C4D81042392D7E194eF399) |
| RFQAuction | [`0xDcc21CEA6741ae2fE3cB23664Fe5a4e519ed5102`](https://testnet.monadvision.com/address/0xDcc21CEA6741ae2fE3cB23664Fe5a4e519ed5102) |
| BondVault | [`0x8cc867C50470B0aB6689646f715bc6611A028F4e`](https://testnet.monadvision.com/address/0x8cc867C50470B0aB6689646f715bc6611A028F4e) |
| DisclosureRegistry | [`0xF285e1f2B7FB006486Ec8D6CC6c586c67aA404e4`](https://testnet.monadvision.com/address/0xF285e1f2B7FB006486Ec8D6CC6c586c67aA404e4) |
| CREKeeperReceiver (forwarder: Chainlink MockKeystoneForwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192`) | [`0xb289a5d9Cdd96A489a94AaA1b785C0EA83aa4dDd`](https://testnet.monadvision.com/address/0xb289a5d9Cdd96A489a94AaA1b785C0EA83aa4dDd) |
| Agreement (InventoryVault) | [`0xe66927bC8fd1F51F66E324c9D60eD4418bd0CCd7`](https://testnet.monadvision.com/address/0xe66927bC8fd1F51F66E324c9D60eD4418bd0CCd7) |
| Heartbeat | [`0xf1512942afe8D92418D96a03bff511E9C0E0b2a8`](https://testnet.monadvision.com/address/0xf1512942afe8D92418D96a03bff511E9C0E0b2a8) |
| Paystream | [`0xCeCcf3df2e144eEAcE4582EE121bC7Ad49Cdb37C`](https://testnet.monadvision.com/address/0xCeCcf3df2e144eEAcE4582EE121bC7Ad49Cdb37C) |
| Test order book (Kuru v1 interface) | [`0xE44258d4B78cfB25f7cBB7a0630f6d785616aa16`](https://testnet.monadvision.com/address/0xE44258d4B78cfB25f7cBB7a0630f6d785616aa16) |
| Test margin account | [`0x8F59388c9479C09E398c840614Efdb3A0039a244`](https://testnet.monadvision.com/address/0x8F59388c9479C09E398c840614Efdb3A0039a244) |
| Test XAUt0 | [`0xAd0427f4502Ddf34b15F8e977E6B5a1dC1A08f8f`](https://testnet.monadvision.com/address/0xAd0427f4502Ddf34b15F8e977E6B5a1dC1A08f8f) |
| Test USDC | [`0x2480d7aDbe32E0Cdf09B2ce34d7CefB387cb47CE`](https://testnet.monadvision.com/address/0x2480d7aDbe32E0Cdf09B2ce34d7CefB387cb47CE) |

### Accounts

| Role | Address |
|---|---|
| Issuer and deployer | [`0xbeb6D11Af2F4C0e8336526F11c1D4D4aeb37a13E`](https://testnet.monadvision.com/address/0xbeb6D11Af2F4C0e8336526F11c1D4D4aeb37a13E) |
| Operator (house quoter, worker) | [`0x89E6d2591383c391DaE99D397F7c89e792bE5Ead`](https://testnet.monadvision.com/address/0x89E6d2591383c391DaE99D397F7c89e792bE5Ead) |
| Market maker A (bid 12,000) | [`0xEa4a26963eE97eC5Fe8968bFFF5C02292ecc103B`](https://testnet.monadvision.com/address/0xEa4a26963eE97eC5Fe8968bFFF5C02292ecc103B) |
| Market maker B (bid 9,500, won) | [`0x679B76716CEc9a62073743d9962A31679187435B`](https://testnet.monadvision.com/address/0x679B76716CEc9a62073743d9962A31679187435B) |
| Market maker C (bid 11,000) | [`0xb4a96E1555FC3169CA493d8Efa0068dfBe8788cA`](https://testnet.monadvision.com/address/0xb4a96E1555FC3169CA493d8Efa0068dfBe8788cA) |
| Independent taker (worker) | [`0x6CeAd55dBe50B38deB109980A65502b978F9fde8`](https://testnet.monadvision.com/address/0x6CeAd55dBe50B38deB109980A65502b978F9fde8) |

### Deployment (`DeployTestnet.s.sol`, 16 transactions, all successful)

| Step | Transaction |
|---|---|
| Deploy test margin account | [`0xfc282999…`](https://testnet.monadvision.com/tx/0xfc2829991190db547707f2f3fa7f9ab356f2ae150c6aa93f73a30731a2a758ab) |
| Deploy test order book | [`0xe849c3dd…`](https://testnet.monadvision.com/tx/0xe849c3dd279b2d56c30fff622a3706bd3fc6b291d1542a37d7652b157ea6b7a4) |
| Book: tick 100, minimum size 2000 (Kuru XAUt0-USDC) | [`0x35777a6e…`](https://testnet.monadvision.com/tx/0x35777a6e17a1ef34870af546c95846b301a870b521358b2861b87baa74b80423) |
| Margin account: verify the book | [`0xcba6a032…`](https://testnet.monadvision.com/tx/0xcba6a03263aadc07a64e009059aafe2501c3bca11aad6dd5254a2ab98e2dcc5a) |
| Deploy BondVault | [`0xc488779f…`](https://testnet.monadvision.com/tx/0xc488779fbde976d37573685bbffd40ddb09ef93cfb480db0f823aa8731a041bd) |
| Deploy DisclosureRegistry | [`0x5f640e45…`](https://testnet.monadvision.com/tx/0x5f640e45d26912f540e01653f3b36450e56a9a95c572cf0e5955077aaa9bdbad) |
| Deploy AgreementFactory (vault, heartbeat, paystream implementations) | [`0x2fec8065…`](https://testnet.monadvision.com/tx/0x2fec806529f65ff2cebcc373d4e7f93ca6125472c5d68d5d233514045115ae09) |
| Deploy RFQAuction | [`0x8afeaa5a…`](https://testnet.monadvision.com/tx/0x8afeaa5a3dbce7714d1a9c29dc2bd75bc7227c04f7d346c434545760122a4e98) |
| Registry: set factory | [`0x73ec3e59…`](https://testnet.monadvision.com/tx/0x73ec3e592acf11e9b61b9a8283705f40e215b028c78b238dea99a90e788b2bca) |
| BondVault: set RFQ and factory | [`0xbe839fa3…`](https://testnet.monadvision.com/tx/0xbe839fa31d2e7bc479df4b7c65ee1aa0da2f10acbb02d760636183882099d770) |
| Factory: set RFQ | [`0xa0ebc69d…`](https://testnet.monadvision.com/tx/0xa0ebc69d69b10c3f533c377d33cc7b17729ac670963e18d100a78cf20783cb60) |
| Factory: allow the market | [`0xdc9bfebe…`](https://testnet.monadvision.com/tx/0xdc9bfebe592ca4a3795f31edef28f283335eec52c347ccfcf81df1eaf46d4c3b) |
| Deploy CREKeeperReceiver | [`0x0cac79a9…`](https://testnet.monadvision.com/tx/0x0cac79a9733f568ceb3896b2a6056bc8698ce7d462f57f6256ab5ec9445b0bbc) |
| Issuer approves XAUt0 to the factory | [`0x1f8c3709…`](https://testnet.monadvision.com/tx/0x1f8c37090cce9a9bfb644ecd3c9a9a6a0673fb0c596c94205acfc886db6b1761) |
| Issuer approves USDC to the factory | [`0x902b82d4…`](https://testnet.monadvision.com/tx/0x902b82d495709c48eff64621ed38d27e065350626b295eead86cc29cb9aadc42) |
| Issuer opens RFQ 1 (the terms above) | [`0xbd047b99…`](https://testnet.monadvision.com/tx/0xbd047b99a954e5c0d47565ca1588dfb9ed3f474e25561e7772040db40adb9473) |

### RFQ and award (`testnet-finish`)

| Step | Transaction |
|---|---|
| Gas money to market maker A | [`0x737d6fc1…`](https://testnet.monadvision.com/tx/0x737d6fc18286df5cfbf5f42a849103b16da5ef2969a7e38787a10a99dfdd3b78) |
| Gas money to market maker B | [`0x08e4a3d7…`](https://testnet.monadvision.com/tx/0x08e4a3d7b0899d6527c78f982121772b38e453e1fca26af20c49022cef379e99) |
| Gas money to market maker C | [`0xbdd9a1f1…`](https://testnet.monadvision.com/tx/0xbdd9a1f124dc2fac623ce1b9c731fec488f870e0d832e33503a722623a4440fb) |
| Gas money to the taker | [`0xabe9a86d…`](https://testnet.monadvision.com/tx/0xabe9a86ddf6c8cdbe281e0b411c91f658fdf92a91098e2f43c12a94fc98af6b0) |
| MM A approves its bond token | [`0x7d526c0b…`](https://testnet.monadvision.com/tx/0x7d526c0b6e7a82732ef5667c93c6f13cdbee2f3a88d9c69dcd5ec16302e5b089) |
| MM A deposits a 20,000 USDC bond | [`0xddc1367c…`](https://testnet.monadvision.com/tx/0xddc1367ccf6878cb1bebcfdbe473abb47347f9cd4f81e8b80c19e7fd56238cc4) |
| MM A bids 12,000 per block (10,000 bond locked) | [`0x311c06e7…`](https://testnet.monadvision.com/tx/0x311c06e7648d451e53286240a95a74dbb7176c3bd68778e3f6b26bd811009dd3) |
| MM B approves its bond token | [`0x9160ec4c…`](https://testnet.monadvision.com/tx/0x9160ec4c81146eacbdb0b7681f02dd8412eebe334a0947039ca3c777e7efd8b1) |
| MM B deposits a 20,000 USDC bond | [`0xbf4ea665…`](https://testnet.monadvision.com/tx/0xbf4ea665d304c709f5be7ba258f50ff6c2a9185e7db4c4717beb2fb5e5fecf35) |
| MM B bids 9,500 per block | [`0xf1724fd7…`](https://testnet.monadvision.com/tx/0xf1724fd772f9550d029dfebf0dc8d2f7a14034419a57d41012da5bffb1dcbd1b) |
| MM C approves its bond token | [`0x2abb1c47…`](https://testnet.monadvision.com/tx/0x2abb1c47fdfca0c255ede95fb140c21548036c2c4dec4794ad9d43a7d9c6a10e) |
| MM C deposits a 20,000 USDC bond | [`0x4eb79005…`](https://testnet.monadvision.com/tx/0x4eb790055d5386e28f3943be5efa40d775d9bd19ffabaa79f8fe413b0cb6bdd1) |
| MM C bids 11,000 per block | [`0x8f680975…`](https://testnet.monadvision.com/tx/0x8f680975d8c1274e4ca39419acd6360950076d767e4f6f0efc242d85b925302c) |
| Issuer awards MM B at 9,500 (expected retainer checked): vault, heartbeat and paystream cloned, 10 XAUt0 + 50,000 USDC into the book's margin account, retainer budget escrowed, bond assigned, terms disclosed | [`0x71db3bad…`](https://testnet.monadvision.com/tx/0x71db3bad750717999db88c0f4321561afc481a66b18dc93617fee7de5347761a) |

### Quoting, fills and the taker

The worker keeps adding a proof every epoch; the agreement page and its Envio log show the latest ones.

| Step | Transaction |
|---|---|
| Epoch 0 proof: bid 4,096.27 / ask 4,106.65, 25 bps, 12,500 USDC per side, mid from Kuru mainnet XAUt0-USDC | [`0x51a7f97d…`](https://testnet.monadvision.com/tx/0x51a7f97d556b651f98ba7bee9d5dbbe51e8b890965adfb77c7f12fa4f3cb7ebb) |
| Epoch 1 proof: bid 4,100.67 / ask 4,111.07, 25 bps (the previous quotes cancelled in the same call) | [`0x29774084…`](https://testnet.monadvision.com/tx/0x297740849b1cf6bddc6abb02ba837eec7c4a3760bc1963309ef147799f4a192a) |
| Taker mints test XAUt0 | [`0x5e17c61c…`](https://testnet.monadvision.com/tx/0x5e17c61c3749ca364357e399299d5c13398fa4fbb4f5cc2afd5f4488740528f6) |
| Taker mints test USDC | [`0x1c4cb1dc…`](https://testnet.monadvision.com/tx/0x1c4cb1dc008a0fd156213eda50518949d42a3400d2238c59e95c0f012d28352d) |
| Taker approves XAUt0 to the book | [`0x50e2fb32…`](https://testnet.monadvision.com/tx/0x50e2fb321d384bf2fbc81f39dc2dcb907b25a5937f378bc4a44d45a551a7de75) |
| Taker approves USDC to the book | [`0x2d343c02…`](https://testnet.monadvision.com/tx/0x2d343c02014d35d6476389431147a9579ea8902ca611b6b437bdec604e87fefc) |
| Taker market-buys about 0.6 XAUt0 from the vault's ask at 4,111.07 (proceeds credited to the vault's margin) | [`0x9c7fe9bd…`](https://testnet.monadvision.com/tx/0x9c7fe9bd5c04d78af281ea7e9c2314e7a7904f7bf596992361dfcc811fd36dcb) |
| Taker market-sells 0.4 XAUt0 into the vault's bid at 4,100.67 | [`0xccdbd07a…`](https://testnet.monadvision.com/tx/0xccdbd07aed362c9ca0e74e7635945fa347dafa5c26ae06cdc1c66ad7a036963e) |

### What a stolen operator key cannot do (simulated against the live agreement)

`pnpm --filter @quoral/bot demo:attack` with `CHAIN_ID=10143` and `AGREEMENT=0xe66927bC8fd1F51F66E324c9D60eD4418bd0CCd7`.
Each attempt is an `eth_call` from the operator address, so nothing is sent:

| Attempt | Result |
|---|---|
| Withdraw the inventory | reverts `NotIssuer` |
| Give notice | reverts `NotParty` |
| Propose itself as the new operator | reverts `NotParty` |
| Quote 100 bps wide (SLA 50) | reverts `SpreadTooWide(100, 50)` |
| Pull the quotes right after the proof | reverts `NotEnded` |
| Walk the mid 3% below the last proof (cap 1.5% per epoch) | reverts `MidMovedTooFar` |
| Bid through another maker's ask | nothing to cross on the test book; the mainnet fork test shows Kuru's `PostOnlyError` |

### Enforcement on the first deployment

The first testnet deployment (factory `0xd81EB766691c8DA4c80580F544c48B9cb3220BbF`, agreement
`0x79Fc5C5F56F2b41CfBd333Ce954Bd4EEb5Ce1724`, 3-minute epochs) went quiet for about two hours on 7 October: the public
testnet RPC allows 15 requests per second and the worker's batch had grown to about 22 calls, so every tick failed
before sending. Nobody had to file a claim. The contracts settled the gap on their own terms as soon as anyone called
`checkEpoch`:

| Step | Transaction |
|---|---|
| Requote after the worker fix (epoch 62) | [`0x463de668…`](https://testnet.monadvision.com/tx/0x463de668bb5b23ba31dd8b61afa4253abefe933d48347b93f7971960cf96451f) |
| Requote (epoch 63) | [`0x8b51af7d…`](https://testnet.monadvision.com/tx/0x8b51af7d486e456035e5c111b97b4ec1d257ae4fd131f0f691ed0ecd7a671bcf) |
| `checkEpoch(62)`: 63 epochs settled, 11 quoted and paid, 52 missed; 296.40 USDC clawed back to the issuer; three uptime windows breached, 1,500 USDC of bond slashed to the issuer | [`0x41e9f9a3…`](https://testnet.monadvision.com/tx/0x41e9f9a3ba54a40dbd09023516a94d3734d21bd0d30327ba3008aa2276345289) |

The worker now batches its reads through Multicall3 (about 6 requests per tick) and its health check returns 503 when
quoting falls behind. That deployment was then replaced by the current one.

### Chainlink CRE

`CREKeeperReceiver` on testnet accepts reports from Chainlink's MockKeystoneForwarder. Running
`cre workflow simulate quoral-keeper --target local-simulation --non-interactive --trigger-index 0 --broadcast` from
`cre/` sends the workflow's settlement report through it; this needs `cre login`, and the resulting transaction will be
listed here.
