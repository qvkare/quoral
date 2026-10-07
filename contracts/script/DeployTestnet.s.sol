// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20, MockMarginAccount, MockOrderBook} from "../test/mocks/MockKuru.sol";
import {BondVault} from "../src/BondVault.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {AgreementFactory} from "../src/AgreementFactory.sol";
import {RFQAuction} from "../src/RFQAuction.sol";
import {InventoryVault} from "../src/InventoryVault.sol";
import {CREKeeperReceiver} from "../src/keepers/CREKeeperReceiver.sol";
import {Terms} from "../src/libraries/Types.sol";

/// @notice Public demo on Monad testnet (10143).
/// Kuru's testnet markets run Kuru v2 (AccountCore), while Quoral v1 targets the Kuru v1 OrderBook that is live on
/// mainnet. So this script deploys a test order book with the Kuru v1 interface and test tokens, then the Quoral
/// core, then opens an RFQ that three market makers bid on and awards the lowest bid.
///
/// env (contracts/.env, never committed):
///   TESTNET_OPS_KEY        deployer, issuer, treasury, keeper-receiver owner
///   TESTNET_MM_A/B/C_KEY   bidders
///   TESTNET_OPERATOR_ADDRESS  quoting key used by every bid (the Cloudflare cron worker)
///   EPOCH_BLOCKS (default 600 ≈ 3 min), DURATION_EPOCHS (default 14400 ≈ 30 days)
///   FUND_MM (default 0.05 ether) gas money sent from OPS to each bidder
contract DeployTestnet is Script {
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
    address winner;
    uint256 rfqId;

    function run() external {
        uint256 ops = vm.envUint("TESTNET_OPS_KEY");
        uint256[3] memory mms = [vm.envUint("TESTNET_MM_A_KEY"), vm.envUint("TESTNET_MM_B_KEY"), vm.envUint("TESTNET_MM_C_KEY")];
        address operator = vm.envAddress("TESTNET_OPERATOR_ADDRESS");
        uint32 epochBlocks = uint32(vm.envOr("EPOCH_BLOCKS", uint256(600)));
        uint64 durationEpochs = uint64(vm.envOr("DURATION_EPOCHS", uint256(14_400)));
        uint256 fundMm = vm.envOr("FUND_MM", uint256(0.05 ether));
        address issuer = vm.addr(ops);

        vm.startBroadcast(ops);
        xaut = new MockERC20("Test XAUt0", "XAUt0", 6);
        usdc = new MockERC20("Test USDC", "USDC", 6);
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
        factory.setMarket(address(book), true);
        keeperRx = new CREKeeperReceiver(issuer, issuer);

        xaut.mint(issuer, 1_000e6);
        usdc.mint(issuer, 10_000_000e6);
        xaut.approve(address(factory), type(uint256).max);
        usdc.approve(address(factory), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            address m = vm.addr(mms[i]);
            usdc.mint(m, 100_000e6);
            if (m.balance < fundMm) payable(m).transfer(fundMm - m.balance);
        }

        Terms memory t = Terms({
            market: address(book),
            baseInventory: 10e6, // 10 XAUt0
            quoteInventory: 50_000e6,
            maxSpreadBps: 50,
            minDepthQuote: 10_000e6,
            epochBlocks: epochBlocks,
            uptimeWindowEpochs: 20, // one hour of 3-minute bars
            uptimeBps: 9000, // two misses allowed per window: a public demo has to survive the odd late cron tick
            retainerPerBlock: 20_000, // cap
            durationBlocks: uint64(epochBlocks) * durationEpochs,
            noticeBlocks: 2_000,
            bondAmount: 10_000e6,
            slashAmount: 500e6,
            pauseExcused: true
        });
        rfqId = rfq.openRFQ(t, 2_000, "ipfs://quoral-testnet/xaut0-usdc.json");
        vm.stopBroadcast();

        uint256[3] memory prices = [uint256(12_000), 9_500, 11_000];
        for (uint256 i; i < 3; ++i) {
            vm.startBroadcast(mms[i]);
            usdc.approve(address(bonds), type(uint256).max);
            bonds.deposit(20_000e6);
            rfq.bid(rfqId, prices[i], operator);
            vm.stopBroadcast();
        }

        (winner,) = rfq.bestBid(rfqId);
        vm.startBroadcast(ops);
        agreement = rfq.award(rfqId, winner);
        vm.stopBroadcast();

        _write();
    }

    function _write() internal {
        string memory o = "testnet";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number);
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
        console2.log("winner    ", winner);
    }
}
