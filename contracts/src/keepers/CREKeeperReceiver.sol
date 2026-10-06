// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IHeartbeatKeeper {
    function checkEpoch(uint256 epoch) external;
    function flagPause() external returns (uint256);
}

/// @title CREKeeperReceiver
/// @notice Chainlink CRE consumer: the cron workflow (≥30 s) signs a report with heartbeat jobs and the
///         Keystone forwarder delivers it via `onReport`. Each job is best-effort (try/catch) so one
///         stale/settled agreement never blocks the others. `checkEpoch`/`flagPause` are permissionless,
///         so this contract holds no privilege; the forwarder check only limits who spends its gas.
contract CREKeeperReceiver is Ownable2Step {
    /// kind 0 = checkEpoch(epoch), kind 1 = flagPause()
    struct Job {
        address heartbeat;
        uint8 kind;
        uint256 epoch;
    }

    error NotForwarder(address sender);

    event ForwarderUpdated(address forwarder);
    event JobResult(address indexed heartbeat, uint8 kind, uint256 epoch, bool ok);

    address public forwarder;

    constructor(address owner_, address forwarder_) Ownable(owner_) {
        forwarder = forwarder_;
    }

    function setForwarder(address f) external onlyOwner {
        forwarder = f;
        emit ForwarderUpdated(f);
    }

    /// @notice IReceiver entrypoint. `report` = abi.encode(Job[]).
    function onReport(bytes calldata, /* metadata */ bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        _run(abi.decode(report, (Job[])));
    }

    /// @notice Fallback path for our own keeper (no privilege needed).
    function run(Job[] calldata jobs) external {
        _run(jobs);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == this.onReport.selector || id == 0x01ffc9a7; // IReceiver, ERC165
    }

    function _run(Job[] memory jobs) internal {
        for (uint256 i; i < jobs.length; ++i) {
            Job memory j = jobs[i];
            bool ok;
            if (j.kind == 0) {
                try IHeartbeatKeeper(j.heartbeat).checkEpoch(j.epoch) {
                    ok = true;
                } catch {}
            } else {
                try IHeartbeatKeeper(j.heartbeat).flagPause() {
                    ok = true;
                } catch {}
            }
            emit JobResult(j.heartbeat, j.kind, j.epoch, ok);
        }
    }
}
