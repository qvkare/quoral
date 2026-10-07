// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20, MockMarginAccount, MockOrderBook} from "../test/mocks/MockKuru.sol";
import {BondVault} from "../src/BondVault.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {AgreementFactory} from "../src/AgreementFactory.sol";
import {RFQAuction} from "../src/RFQAuction.sol";
import {CREKeeperReceiver} from "../src/keepers/CREKeeperReceiver.sol";
import {Terms} from "../src/libraries/Types.sol";

/// @notice Public demo on Monad testnet (10143), step 1 of 2.
/// Kuru's testnet markets run Kuru v2 (AccountCore), while Quoral v1 targets the Kuru v1 OrderBook that is live on
/// mainnet. So this script deploys a test order book with the Kuru v1 interface, set up like Kuru's mainnet
/// XAUt0-USDC market (price precision 1e4, size precision 1e6, tick 100, minimum size 2000), then the Quoral
/// core, and opens the RFQ. Step 2, `testnet:finish` in packages/bot, funds the bidders, places three
/// bonded bids and awards the lowest, spacing sends for Monad's reserve-balance rule.
///
/// env (contracts/.env, never committed):
///   TESTNET_OPS_KEY           deployer, issuer, treasury, keeper-receiver owner
///   TESTNET_OPERATOR_ADDRESS  quoting key used by every bid (the Cloudflare cron worker)
///   BASE_TOKEN / QUOTE_TOKEN  reuse existing test tokens (optional; new ones otherwise)
///   CRE_FORWARDER             default: Chainlink's MockKeystoneForwarder on Monad testnet (for `cre workflow simulate`)
///   EPOCH_BLOCKS (default 1980 ≈ 10 min at 302 ms), DURATION_EPOCHS (default 4320 ≈ 30 days)
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
    uint256 rfqId;

    function run() external {
        uint256 ops = vm.envUint("TESTNET_OPS_KEY");
        address operator = vm.envAddress("TESTNET_OPERATOR_ADDRESS");
        address forwarder = vm.envOr("CRE_FORWARDER", address(0xB9F79d863261869B234c481D1f9A7af84AeAd192));
        uint32 epochBlocks = uint32(vm.envOr("EPOCH_BLOCKS", uint256(1980)));
        uint64 durationEpochs = uint64(vm.envOr("DURATION_EPOCHS", uint256(4320)));
        address issuer = vm.addr(ops);

        vm.startBroadcast(ops);
        address baseToken = vm.envOr("BASE_TOKEN", address(0));
        address quoteToken = vm.envOr("QUOTE_TOKEN", address(0));
        xaut = baseToken == address(0) ? new MockERC20("Test XAUt0", "XAUt0", 6) : MockERC20(baseToken);
        usdc = quoteToken == address(0) ? new MockERC20("Test USDC", "USDC", 6) : MockERC20(quoteToken);
        margin = new MockMarginAccount();
        book = new MockOrderBook(margin, address(xaut), address(usdc), 1e4, 1e6);
        book.setLimits(100, 2000);
        margin.setMarket(address(book));

        bonds = new BondVault(address(usdc), issuer);
        registry = new DisclosureRegistry();
        factory = new AgreementFactory(issuer, address(margin), address(bonds), address(registry), issuer, 1000);
        rfq = new RFQAuction(address(bonds), address(factory));
        registry.setFactory(address(factory));
        bonds.setWiring(address(rfq), address(factory));
        factory.setRFQ(address(rfq));
        factory.setMarket(address(book), true);
        keeperRx = new CREKeeperReceiver(issuer, forwarder);

        if (xaut.balanceOf(issuer) < 100e6) xaut.mint(issuer, 1_000e6);
        if (usdc.balanceOf(issuer) < 1_000_000e6) usdc.mint(issuer, 10_000_000e6);
        xaut.approve(address(factory), type(uint256).max);
        usdc.approve(address(factory), type(uint256).max);

        Terms memory t = Terms({
            market: address(book),
            baseInventory: 10e6, // 10 XAUt0 ≈ $41k
            quoteInventory: 50_000e6,
            maxSpreadBps: 50,
            minDepthQuote: 10_000e6,
            epochBlocks: epochBlocks,
            uptimeWindowEpochs: 12, // two hours of 10-minute bars
            uptimeBps: 8500, // one miss allowed per window
            retainerPerBlock: 20_000, // cap: 0.02 USDC per block
            durationBlocks: uint64(epochBlocks) * durationEpochs,
            noticeBlocks: 2_000,
            bondAmount: 10_000e6,
            slashAmount: 500e6,
            pauseExcused: true,
            maxMidMoveBps: 150, // the mid may move at most 1.5% per epoch
            startDelayBlocks: 600 // ≈ 3 minutes for the quoter to pick the agreement up
        });
        rfqId = rfq.openRFQ(t, 20_000, "ipfs://quoral-testnet/xaut0-usdc-v2.json"); // ≈ 100 minutes of bidding
        vm.stopBroadcast();

        _write();
    }

    function _write() internal {
        string memory o = "testnet";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number);
        vm.serializeUint(o, "rfqId", rfqId);
        vm.serializeAddress(o, "base", address(xaut));
        vm.serializeAddress(o, "quote", address(usdc));
        vm.serializeAddress(o, "marginAccount", address(margin));
        vm.serializeAddress(o, "market", address(book));
        vm.serializeAddress(o, "bondVault", address(bonds));
        vm.serializeAddress(o, "registry", address(registry));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "keeperReceiver", address(keeperRx));
        string memory json = vm.serializeAddress(o, "rfq", address(rfq));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("market    ", address(book));
        console2.log("factory   ", address(factory));
        console2.log("rfq       ", address(rfq));
        console2.log("rfq id    ", rfqId);
    }
}
