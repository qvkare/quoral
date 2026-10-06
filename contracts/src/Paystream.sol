// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IInventoryVault} from "./interfaces/IQuoral.sol";

/// @title Paystream
/// @notice Retainer escrow. Accrues per block (view), becomes claimable per settled epoch; missed epochs
///         are clawed back to the issuer the moment they are settled. Protocol fee is taken on claim.
contract Paystream is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct InitParams {
        address vault;
        address heartbeat;
        address token;
        address issuer;
        address mm;
        address treasury;
        uint16 feeBps;
        uint256 retainerPerBlock;
        uint32 epochBlocks;
        uint64 startBlock;
    }

    error NotHeartbeat();
    error NotVault();
    error AlreadyFinalized();

    event Settled(uint256 paidEpochs, uint256 missedEpochs, uint256 earnedTotal);
    event Clawback(uint256 missedEpochs, uint256 amount, address indexed to);
    event Claimed(address indexed mm, uint256 net, uint256 fee);
    event Refunded(address indexed issuer, uint256 amount);

    address public vault;
    address public heartbeat;
    address public token;
    address public issuer;
    address public mm;
    address public treasury;
    uint16 public feeBps;
    uint256 public retainerPerBlock;
    uint256 public ratePerEpoch;
    uint64 public startBlock;

    uint256 public earned;
    uint256 public claimed;
    uint256 public clawedBack;
    uint256 public feesPaid;
    uint256 public refunded;
    bool public finalized;

    constructor() {
        _disableInitializers();
    }

    /// @dev Factory funds `retainerPerBlock * durationBlocks` before calling.
    function initialize(InitParams calldata p) external initializer {
        vault = p.vault;
        heartbeat = p.heartbeat;
        token = p.token;
        issuer = p.issuer;
        mm = p.mm;
        treasury = p.treasury;
        feeBps = p.feeBps;
        retainerPerBlock = p.retainerPerBlock;
        ratePerEpoch = p.retainerPerBlock * p.epochBlocks;
        startBlock = p.startBlock;
    }

    function settle(uint256 paidEpochs, uint256 missedEpochs) external nonReentrant {
        if (msg.sender != heartbeat) revert NotHeartbeat();
        earned += paidEpochs * ratePerEpoch;
        if (missedEpochs > 0) {
            uint256 amount = missedEpochs * ratePerEpoch;
            clawedBack += amount;
            IERC20(token).safeTransfer(issuer, amount);
            emit Clawback(missedEpochs, amount, issuer);
        }
        emit Settled(paidEpochs, missedEpochs, earned);
    }

    /// @notice Pays the MM everything earned so far (anyone may trigger).
    function claim() external nonReentrant returns (uint256 net) {
        net = _claim();
    }

    /// @notice Called by the vault at finalization: pays the MM, refunds the unused budget to the issuer.
    function finalize() external nonReentrant {
        if (msg.sender != vault) revert NotVault();
        if (finalized) revert AlreadyFinalized();
        finalized = true;
        _claim();
        uint256 rest = IERC20(token).balanceOf(address(this));
        if (rest > 0) {
            refunded = rest;
            IERC20(token).safeTransfer(issuer, rest);
            emit Refunded(issuer, rest);
        }
    }

    function claimable() public view returns (uint256) {
        return earned - claimed;
    }

    /// @notice Per-block streaming counter for UIs: accrued up to now minus clawbacks (not yet final).
    function liveAccrued() external view returns (uint256) {
        uint256 end = IInventoryVault(vault).endBlock();
        uint256 to = block.number < end ? block.number : end;
        if (to <= startBlock) return 0;
        uint256 accrued = (to - startBlock) * retainerPerBlock;
        return accrued > clawedBack ? accrued - clawedBack : 0;
    }

    function _claim() internal returns (uint256 net) {
        uint256 owed = earned - claimed;
        if (owed == 0) return 0;
        claimed = earned;
        uint256 fee = (owed * feeBps) / 1e4;
        net = owed - fee;
        if (fee > 0) {
            feesPaid += fee;
            IERC20(token).safeTransfer(treasury, fee);
        }
        IERC20(token).safeTransfer(mm, net);
        emit Claimed(mm, net, fee);
    }
}
