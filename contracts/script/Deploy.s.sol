// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BondVault} from "../src/BondVault.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {AgreementFactory} from "../src/AgreementFactory.sol";
import {RFQAuction} from "../src/RFQAuction.sol";
import {CREKeeperReceiver} from "../src/keepers/CREKeeperReceiver.sol";

/// @notice Deploys the Quoral core against an existing Kuru v1 deployment (Monad mainnet 143 / testnet 10143).
/// env: PRIVATE_KEY, KURU_MARGIN_ACCOUNT, BOND_TOKEN (USDC), TREASURY, FEE_BPS (default 1000),
///      MARKETS (comma-separated Kuru OrderBook addresses to allow)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address margin = vm.envAddress("KURU_MARGIN_ACCOUNT");
        address bondToken = vm.envAddress("BOND_TOKEN");
        address treasury = vm.envOr("TREASURY", deployer);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(1000)));
        address[] memory markets = vm.envOr("MARKETS", ",", new address[](0));

        vm.startBroadcast(pk);
        BondVault bonds = new BondVault(bondToken, deployer);
        DisclosureRegistry registry = new DisclosureRegistry();
        AgreementFactory factory =
            new AgreementFactory(deployer, margin, address(bonds), address(registry), treasury, feeBps);
        RFQAuction rfq = new RFQAuction(address(bonds), address(factory));
        registry.setFactory(address(factory));
        bonds.setWiring(address(rfq), address(factory));
        factory.setRFQ(address(rfq));
        CREKeeperReceiver keeperRx = new CREKeeperReceiver(deployer, vm.envOr("CRE_FORWARDER", deployer));
        for (uint256 i; i < markets.length; ++i) {
            factory.setMarket(markets[i], true);
        }
        vm.stopBroadcast();

        string memory o = "deploy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number);
        vm.serializeAddress(o, "marginAccount", margin);
        vm.serializeAddress(o, "bondVault", address(bonds));
        vm.serializeAddress(o, "registry", address(registry));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "keeperReceiver", address(keeperRx));
        string memory json = vm.serializeAddress(o, "rfq", address(rfq));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        console2.log("BondVault          ", address(bonds));
        console2.log("DisclosureRegistry ", address(registry));
        console2.log("AgreementFactory   ", address(factory));
        console2.log("RFQAuction         ", address(rfq));
    }
}
