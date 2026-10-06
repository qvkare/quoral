// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Terms, MarketScale} from "./libraries/Types.sol";
import {KuruV1Adapter} from "./adapters/KuruV1Adapter.sol";
import {InventoryVault} from "./InventoryVault.sol";
import {Heartbeat} from "./Heartbeat.sol";
import {Paystream} from "./Paystream.sol";
import {IBondVault, IDisclosureRegistry} from "./interfaces/IQuoral.sol";

/// @title AgreementFactory
/// @notice Deploys InventoryVault + Heartbeat + Paystream clones per agreement (CREATE2), funds them from
///         the issuer, wires the bond and publishes the disclosure. Only the RFQAuction may create agreements,
///         which guarantees the MM consented with a bonded bid and the issuer consented by awarding.
contract AgreementFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    error NotRFQ();
    error MarketNotAllowed(address market);
    error InvalidTerms(string reason);
    error AlreadySet();
    error FeeTooHigh();

    event AgreementCreated(
        address indexed agreement,
        address indexed issuer,
        address indexed mm,
        address heartbeat,
        address paystream,
        address operator,
        address market,
        address baseToken,
        address quoteToken,
        bytes32 termsHash,
        uint64 startBlock,
        uint64 endBlock
    );
    event MarketAllowed(address indexed market, bool allowed);
    event TreasuryUpdated(address treasury, uint16 feeBps);

    address public immutable vaultImpl;
    address public immutable heartbeatImpl;
    address public immutable paystreamImpl;
    address public immutable marginAccount;
    address public immutable bondVault;
    address public immutable registry;

    address public rfq;
    address public treasury;
    uint16 public feeBps; // protocol share of the retainer stream (spec: 10%)
    uint256 public nonce;
    address[] public agreements;
    mapping(address market => bool) public allowedMarket;

    constructor(
        address owner_,
        address marginAccount_,
        address bondVault_,
        address registry_,
        address treasury_,
        uint16 feeBps_
    ) Ownable(owner_) {
        if (feeBps_ > 2000) revert FeeTooHigh();
        vaultImpl = address(new InventoryVault());
        heartbeatImpl = address(new Heartbeat());
        paystreamImpl = address(new Paystream());
        marginAccount = marginAccount_;
        bondVault = bondVault_;
        registry = registry_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ------------------------------------------------------------------ admin

    function setRFQ(address rfq_) external onlyOwner {
        if (rfq != address(0)) revert AlreadySet();
        rfq = rfq_;
    }

    function setMarket(address market, bool allowed) external onlyOwner {
        allowedMarket[market] = allowed;
        emit MarketAllowed(market, allowed);
    }

    function setTreasury(address treasury_, uint16 feeBps_) external onlyOwner {
        if (feeBps_ > 2000) revert FeeTooHigh();
        treasury = treasury_;
        feeBps = feeBps_;
        emit TreasuryUpdated(treasury_, feeBps_);
    }

    // ------------------------------------------------------------------ terms

    /// @notice Reverts on invalid terms; returns the market's scale.
    function validateTerms(Terms calldata t) public view returns (MarketScale memory s) {
        if (!allowedMarket[t.market]) revert MarketNotAllowed(t.market);
        if (t.epochBlocks == 0) revert InvalidTerms("epochBlocks");
        if (t.durationBlocks == 0 || t.durationBlocks % t.epochBlocks != 0) revert InvalidTerms("durationBlocks");
        if (t.maxSpreadBps == 0 || t.maxSpreadBps >= 1e4) revert InvalidTerms("maxSpreadBps");
        if (t.uptimeBps > 1e4) revert InvalidTerms("uptimeBps");
        if (t.uptimeWindowEpochs == 0) revert InvalidTerms("uptimeWindowEpochs");
        if (t.retainerPerBlock == 0) revert InvalidTerms("retainerPerBlock");
        if (t.slashAmount > t.bondAmount) revert InvalidTerms("slashAmount");
        if (t.baseInventory == 0 && t.quoteInventory == 0) revert InvalidTerms("inventory");
        s = KuruV1Adapter.scale(t.market);
    }

    function retainerBudget(Terms calldata t) public pure returns (uint256) {
        return t.retainerPerBlock * t.durationBlocks;
    }

    function termsHash(Terms calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(t));
    }

    // ------------------------------------------------------------------ create

    function createAgreement(Terms calldata t, address issuer, address mm, address operator, string calldata uri)
        external
        returns (address agreement)
    {
        if (msg.sender != rfq) revert NotRFQ();
        MarketScale memory s = validateTerms(t);

        bytes32 salt = keccak256(abi.encode(address(this), nonce++));
        agreement = Clones.cloneDeterministic(vaultImpl, salt);
        address hb = Clones.cloneDeterministic(heartbeatImpl, salt);
        address ps = Clones.cloneDeterministic(paystreamImpl, salt);
        uint64 start = uint64(block.number);

        // Fund from the issuer (issuer approved this factory before awarding).
        if (t.baseInventory > 0) IERC20(s.baseToken).safeTransferFrom(issuer, agreement, t.baseInventory);
        if (t.quoteInventory > 0) IERC20(s.quoteToken).safeTransferFrom(issuer, agreement, t.quoteInventory);
        IERC20(s.quoteToken).safeTransferFrom(issuer, ps, retainerBudget(t));

        Heartbeat(hb).initialize(
            Heartbeat.InitParams({
                vault: agreement,
                paystream: ps,
                bondVault: bondVault,
                issuer: issuer,
                startBlock: start,
                epochBlocks: t.epochBlocks,
                windowEpochs: t.uptimeWindowEpochs,
                uptimeBps: t.uptimeBps,
                slashAmount: t.slashAmount,
                pauseExcused: t.pauseExcused
            })
        );
        Paystream(ps).initialize(
            Paystream.InitParams({
                vault: agreement,
                heartbeat: hb,
                token: s.quoteToken,
                issuer: issuer,
                mm: mm,
                treasury: treasury,
                feeBps: feeBps,
                retainerPerBlock: t.retainerPerBlock,
                epochBlocks: t.epochBlocks,
                startBlock: start
            })
        );
        InventoryVault(agreement).initialize(
            InventoryVault.InitParams({
                terms: t,
                issuer: issuer,
                mm: mm,
                operator: operator,
                marginAccount: marginAccount,
                heartbeat: hb,
                paystream: ps,
                bondVault: bondVault,
                startBlock: start
            }),
            s
        );

        IBondVault(bondVault).registerAgreement(agreement, hb);
        bytes32 th = termsHash(t);
        IDisclosureRegistry(registry).register(agreement, issuer, mm, t.market, s.baseToken, th, uri);
        agreements.push(agreement);

        emit AgreementCreated(
            agreement, issuer, mm, hb, ps, operator, t.market, s.baseToken, s.quoteToken, th, start,
            start + t.durationBlocks
        );
    }

    function agreementCount() external view returns (uint256) {
        return agreements.length;
    }

    /// @notice Addresses the next agreement will be deployed at.
    function predictNext() external view returns (address vault, address heartbeat, address paystream) {
        bytes32 salt = keccak256(abi.encode(address(this), nonce));
        vault = Clones.predictDeterministicAddress(vaultImpl, salt);
        heartbeat = Clones.predictDeterministicAddress(heartbeatImpl, salt);
        paystream = Clones.predictDeterministicAddress(paystreamImpl, salt);
    }
}
