// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Proof, EpochStatus} from "./libraries/Types.sol";
import {IInventoryVault, IPaystream, IBondVault} from "./interfaces/IQuoral.sol";

/// @title Heartbeat
/// @notice Per-agreement epoch bitmap. The vault records a proof in every epoch it quotes in; anyone can
///         settle ended epochs with `checkEpoch`, which claws back the retainer of missed epochs and slashes
///         the MM bond once uptime in a window falls below the SLA.
contract Heartbeat is Initializable {
    struct InitParams {
        address vault;
        address paystream;
        address bondVault;
        address issuer;
        uint64 startBlock;
        uint32 epochBlocks;
        uint32 windowEpochs;
        uint16 uptimeBps;
        uint256 slashAmount;
        bool pauseExcused;
    }

    error NotVault();
    error EpochNotEnded(uint256 epoch);
    error AlreadySettled(uint256 epoch);
    error NotPaused();
    error PauseNotExcused();
    error NotLive();

    event HeartbeatRecorded(uint256 indexed epoch, Proof proof);
    event EpochExcused(uint256 indexed epoch, address indexed by);
    event EpochSettled(uint256 indexed epoch, EpochStatus status);
    event UptimeBreached(uint256 indexed window, uint256 misses, uint256 allowedMisses, uint256 slashed);

    address public vault;
    address public paystream;
    address public bondVault;
    address public issuer;
    uint64 public startBlock;
    uint32 public epochBlocks;
    uint32 public windowEpochs;
    uint32 public allowedMisses;
    uint256 public slashAmount;
    bool public pauseExcused;

    mapping(uint256 word => uint256) internal _quoted;
    mapping(uint256 word => uint256) internal _excused;
    mapping(uint256 word => uint256) internal _missed;
    mapping(uint256 epoch => Proof) public proofs;
    mapping(uint256 window => uint32) public missesInWindow;

    /// @notice Epochs [0, settledEpochs) are settled.
    uint256 public settledEpochs;
    uint256 public quotedCount;
    uint256 public excusedCount;
    uint256 public missedCount;
    uint256 public totalSlashed;

    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external initializer {
        vault = p.vault;
        paystream = p.paystream;
        bondVault = p.bondVault;
        issuer = p.issuer;
        startBlock = p.startBlock;
        epochBlocks = p.epochBlocks;
        windowEpochs = p.windowEpochs;
        allowedMisses = uint32((uint256(p.windowEpochs) * (1e4 - p.uptimeBps)) / 1e4);
        slashAmount = p.slashAmount;
        pauseExcused = p.pauseExcused;
    }

    // ------------------------------------------------------------------ writes

    function record(uint256 epoch, Proof calldata proof) external {
        if (msg.sender != vault) revert NotVault();
        _set(_quoted, epoch);
        proofs[epoch] = proof;
        emit HeartbeatRecorded(epoch, proof);
    }

    /// @notice Permissionless: marks the current epoch excused while the venue is paused.
    function flagPause() external returns (uint256 epoch) {
        if (!pauseExcused) revert PauseNotExcused();
        IInventoryVault v = IInventoryVault(vault);
        if (block.number < v.startBlock() || block.number >= v.endBlock()) revert NotLive();
        if (!v.venuePaused()) revert NotPaused();
        epoch = currentEpoch();
        if (!_get(_excused, epoch)) {
            _set(_excused, epoch);
            emit EpochExcused(epoch, msg.sender);
        }
    }

    /// @notice Permissionless: settles every unsettled epoch up to and including `epoch`.
    function checkEpoch(uint256 epoch) external {
        if (epoch < settledEpochs) revert AlreadySettled(epoch);
        // An epoch is final once its last block has passed (the agreement's end closes the last one).
        uint256 total = IInventoryVault(vault).totalEpochs();
        bool ended = block.number >= IInventoryVault(vault).endBlock();
        if (epoch >= total || (epoch >= currentEpoch() && !ended)) revert EpochNotEnded(epoch);

        uint256 paid;
        uint256 excused;
        uint256 missed;
        uint256 slashedNow;
        for (uint256 e = settledEpochs; e <= epoch; ++e) {
            EpochStatus st;
            if (_get(_quoted, e)) {
                st = EpochStatus.Quoted;
                ++paid;
            } else if (_get(_excused, e)) {
                st = EpochStatus.Excused;
                ++paid; // excused = force majeure: not penalised, retainer still due
                ++excused;
            } else {
                st = EpochStatus.Missed;
                _set(_missed, e);
                ++missed;
                uint256 w = e / windowEpochs;
                uint32 m = ++missesInWindow[w];
                if (m == allowedMisses + 1 && slashAmount > 0) {
                    uint256 s = IBondVault(bondVault).slash(slashAmount, issuer);
                    slashedNow += s;
                    emit UptimeBreached(w, m, allowedMisses, s);
                }
            }
            emit EpochSettled(e, st);
        }
        settledEpochs = epoch + 1;
        quotedCount += paid - excused;
        excusedCount += excused;
        missedCount += missed;
        totalSlashed += slashedNow;
        IPaystream(paystream).settle(paid, missed);
    }

    // ------------------------------------------------------------------ views

    function currentEpoch() public view returns (uint256) {
        if (block.number < startBlock) return 0;
        return (block.number - startBlock) / epochBlocks;
    }

    function status(uint256 epoch) public view returns (EpochStatus) {
        if (_get(_quoted, epoch)) return EpochStatus.Quoted;
        if (_get(_excused, epoch)) return EpochStatus.Excused;
        if (_get(_missed, epoch)) return EpochStatus.Missed;
        return EpochStatus.Pending;
    }

    /// @notice Status strip for UIs: `count` epochs starting at `from`.
    function statusRange(uint256 from, uint256 count) external view returns (EpochStatus[] memory out) {
        out = new EpochStatus[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = status(from + i);
        }
    }

    /// @notice Uptime (bps) over settled epochs of a window; excused epochs count as up.
    function windowUptimeBps(uint256 window) external view returns (uint256) {
        uint256 first = window * windowEpochs;
        if (settledEpochs <= first) return 1e4;
        uint256 settledInWindow = settledEpochs - first;
        if (settledInWindow > windowEpochs) settledInWindow = windowEpochs;
        return ((settledInWindow - missesInWindow[window]) * 1e4) / settledInWindow;
    }

    // ------------------------------------------------------------------ bitmap

    function _set(mapping(uint256 => uint256) storage m, uint256 i) private {
        m[i >> 8] |= (1 << (i & 0xff));
    }

    function _get(mapping(uint256 => uint256) storage m, uint256 i) private view returns (bool) {
        return (m[i >> 8] >> (i & 0xff)) & 1 == 1;
    }
}
