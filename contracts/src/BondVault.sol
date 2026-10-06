// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BondVault
/// @notice Market-maker bonds. Free → locked (RFQ bid) → assigned (won agreement) → slashed / released.
///         Slashes are liquidated damages paid to the issuer, triggered only by the agreement's Heartbeat.
contract BondVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Bond {
        address mm;
        address heartbeat;
        uint256 amount; // remaining
        uint256 slashed;
        bool released;
    }

    error NotRFQ();
    error NotFactory();
    error NotSlasher();
    error Insufficient();
    error AlreadySet();
    error AlreadyReleased();

    event Deposited(address indexed mm, uint256 amount);
    event Withdrawn(address indexed mm, uint256 amount);
    event Locked(address indexed mm, uint256 amount);
    event Unlocked(address indexed mm, uint256 amount);
    event Assigned(address indexed agreement, address indexed mm, uint256 amount);
    event Slashed(address indexed agreement, address indexed mm, uint256 amount, address to);
    event Released(address indexed agreement, address indexed mm, uint256 amount);

    IERC20 public immutable bondToken;
    address public rfq;
    address public factory;

    mapping(address mm => uint256) public free;
    mapping(address mm => uint256) public locked;
    mapping(address agreement => Bond) public bonds;
    mapping(address heartbeat => address agreement) public agreementOfHeartbeat;

    constructor(address token_, address owner_) Ownable(owner_) {
        bondToken = IERC20(token_);
    }

    function token() external view returns (address) {
        return address(bondToken);
    }

    function setWiring(address rfq_, address factory_) external onlyOwner {
        if (rfq != address(0) || factory != address(0)) revert AlreadySet();
        rfq = rfq_;
        factory = factory_;
    }

    // ------------------------------------------------------------------ MM

    function deposit(uint256 amount) external nonReentrant {
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        free[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (free[msg.sender] < amount) revert Insufficient();
        free[msg.sender] -= amount;
        bondToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ RFQ

    function lock(address mm, uint256 amount) external {
        if (msg.sender != rfq) revert NotRFQ();
        if (free[mm] < amount) revert Insufficient();
        free[mm] -= amount;
        locked[mm] += amount;
        emit Locked(mm, amount);
    }

    function unlock(address mm, uint256 amount) external {
        if (msg.sender != rfq) revert NotRFQ();
        locked[mm] -= amount;
        free[mm] += amount;
        emit Unlocked(mm, amount);
    }

    function assign(address mm, uint256 amount, address agreement) external {
        if (msg.sender != rfq) revert NotRFQ();
        locked[mm] -= amount;
        Bond storage b = bonds[agreement];
        b.mm = mm;
        b.amount += amount;
        emit Assigned(agreement, mm, amount);
    }

    // ------------------------------------------------------------------ agreement

    function registerAgreement(address agreement, address heartbeat) external {
        if (msg.sender != factory) revert NotFactory();
        bonds[agreement].heartbeat = heartbeat;
        agreementOfHeartbeat[heartbeat] = agreement;
    }

    function slash(uint256 amount, address to) external nonReentrant returns (uint256 slashed) {
        address agreement = agreementOfHeartbeat[msg.sender];
        if (agreement == address(0)) revert NotSlasher();
        Bond storage b = bonds[agreement];
        if (b.released) revert AlreadyReleased();
        slashed = amount > b.amount ? b.amount : amount;
        if (slashed == 0) return 0;
        b.amount -= slashed;
        b.slashed += slashed;
        bondToken.safeTransfer(to, slashed);
        emit Slashed(agreement, b.mm, slashed, to);
    }

    /// @notice Called by the agreement (vault) at finalization.
    function release() external {
        Bond storage b = bonds[msg.sender];
        if (b.heartbeat == address(0)) revert NotSlasher();
        if (b.released) revert AlreadyReleased();
        b.released = true;
        uint256 amt = b.amount;
        b.amount = 0;
        free[b.mm] += amt;
        emit Released(msg.sender, b.mm, amt);
    }
}
