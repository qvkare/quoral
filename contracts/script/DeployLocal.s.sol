// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20, MockMarginAccount, MockOrderBook} from "../test/mocks/MockKuru.sol";
import {BondVault} from "../src/BondVault.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {AgreementFactory} from "../src/AgreementFactory.sol";
import {RFQAuction} from "../src/RFQAuction.sol";
import {CREKeeperReceiver} from "../src/keepers/CREKeeperReceiver.sol";
import {InventoryVault} from "../src/InventoryVault.sol";
import {Terms} from "../src/libraries/Types.sol";

/// @notice Full local stack on anvil: mock Kuru XAUt0-USDC market + Quoral core + one awarded agreement
///         (3 bidders) so the bot, keeper, indexer and UI can run end-to-end without mainnet funds.
/// Uses anvil default keys: #0 deployer/issuer, #1..#3 MMs, #4 operator.
contract DeployLocal is Script {
    uint256 constant K0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant K1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant K2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant K3 = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant K4 = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    MockERC20 xaut;
    MockERC20 usdc;
    MockMarginAccount margin;
    MockOrderBook book;
    BondVault bonds;
    DisclosureRegistry registry;
    AgreementFactory factory;
    RFQAuction rfq;
    CREKeeperReceiver keeperRx;
    address agreement;
    address best;

    function run() external {
        address issuer = vm.addr(K0);
        address operator = vm.addr(K4);

        vm.startBroadcast(K0);
        xaut = new MockERC20("Tether Gold", "XAUt0", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        margin = new MockMarginAccount();
        book = new MockOrderBook(margin, address(xaut), address(usdc), 100, 1e4);
        margin.setMarket(address(book));

        bonds = new BondVault(address(usdc), issuer);
        registry = new DisclosureRegistry();
        factory = new AgreementFactory(issuer, address(margin), address(bonds), address(registry), issuer, 1000);
        rfq = new RFQAuction(address(bonds), address(factory));
        registry.setFactory(address(factory));
        bonds.setWiring(address(rfq), address(factory));
        factory.setRFQ(address(rfq));
        keeperRx = new CREKeeperReceiver(issuer, issuer);
        factory.setMarket(address(book), true);

        xaut.mint(issuer, 1_000e6);
        usdc.mint(issuer, 10_000_000e6);
        usdc.mint(operator, 1_000_000e6); // background liquidity for the "other side" sim
        xaut.mint(operator, 100e6);
        usdc.mint(vm.addr(K1), 100_000e6);
        usdc.mint(vm.addr(K2), 100_000e6);
        usdc.mint(vm.addr(K3), 100_000e6);
        xaut.approve(address(factory), type(uint256).max);
        usdc.approve(address(factory), type(uint256).max);

        Terms memory t = Terms({
            market: address(book),
            baseInventory: 10e6, // 10 XAUt0
            quoteInventory: 50_000e6,
            maxSpreadBps: 50,
            minDepthQuote: 10_000e6,
            epochBlocks: 10, // local: 10 s at 1 s anvil blocks (mainnet: 100 ≈ 30 s)
            uptimeWindowEpochs: 20,
            uptimeBps: 9500,
            retainerPerBlock: 20_000, // cap: 0.02 USDC/block
            durationBlocks: 8_640_000, // 30 days
            noticeBlocks: 2_000,
            bondAmount: 5_000e6,
            slashAmount: 1_000e6,
            pauseExcused: true,
            maxMidMoveBps: 100, // 1% per 10 s epoch
            startDelayBlocks: 5
        });
        uint256 id = rfq.openRFQ(t, 10_000, "ipfs://quoral-demo/xaut0-usdc.json");
        vm.stopBroadcast();

        uint256[3] memory keys = [K1, K2, K3];
        uint256[3] memory prices = [uint256(12_000), 9_500, 11_000];
        for (uint256 i; i < 3; ++i) {
            vm.startBroadcast(keys[i]);
            usdc.approve(address(bonds), type(uint256).max);
            bonds.deposit(10_000e6);
            rfq.bid(id, prices[i], operator);
            vm.stopBroadcast();
        }

        (address bestBidder, uint256 bestRate) = rfq.bestBid(id);
        best = bestBidder;
        vm.startBroadcast(K0);
        agreement = rfq.award(id, best, bestRate);
        vm.stopBroadcast();
        _write();
    }

    function _write() internal {
        string memory o = "local";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", 0);
        vm.serializeAddress(o, "base", address(xaut));
        vm.serializeAddress(o, "quote", address(usdc));
        vm.serializeAddress(o, "marginAccount", address(margin));
        vm.serializeAddress(o, "market", address(book));
        vm.serializeAddress(o, "bondVault", address(bonds));
        vm.serializeAddress(o, "registry", address(registry));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "keeperReceiver", address(keeperRx));
        vm.serializeAddress(o, "rfq", address(rfq));
        vm.serializeAddress(o, "agreement", agreement);
        vm.serializeAddress(o, "heartbeat", InventoryVault(agreement).heartbeat());
        string memory json = vm.serializeAddress(o, "paystream", InventoryVault(agreement).paystream());
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("market    ", address(book));
        console2.log("factory   ", address(factory));
        console2.log("rfq       ", address(rfq));
        console2.log("agreement ", agreement);
        console2.log("winner    ", best);
    }
}
