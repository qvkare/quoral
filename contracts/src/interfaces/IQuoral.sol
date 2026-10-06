// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Terms, Proof} from "../libraries/Types.sol";

/// @notice Venue surface an InventoryVault needs. v1 = Kuru OrderBook (KuruV1Adapter, internal library);
///         v2 = Kuru AccountCore trade-only signer. Kept as an interface to document the boundary.
interface IVenueAdapter {
    function requote(
        uint32[] calldata bidPrices,
        uint96[] calldata bidSizes,
        uint32[] calldata askPrices,
        uint96[] calldata askSizes
    ) external;
    function cancel() external;
    function venuePaused() external view returns (bool);
}

interface IInventoryVault {
    function terms() external view returns (Terms memory);
    function issuer() external view returns (address);
    function mm() external view returns (address);
    function startBlock() external view returns (uint64);
    function endBlock() external view returns (uint64);
    function totalEpochs() external view returns (uint256);
    function venuePaused() external view returns (bool);
}

interface IHeartbeat {
    function record(uint256 epoch, Proof calldata proof) external;
    function settledEpochs() external view returns (uint256);
}

interface IPaystream {
    function settle(uint256 paidEpochs, uint256 missedEpochs) external;
    function finalize() external;
}

interface IBondVault {
    function lock(address mm, uint256 amount) external;
    function unlock(address mm, uint256 amount) external;
    function assign(address mm, uint256 amount, address agreement) external;
    function registerAgreement(address agreement, address heartbeat) external;
    function slash(uint256 amount, address to) external returns (uint256 slashed);
    function release() external;
    function token() external view returns (address);
}

interface IDisclosureRegistry {
    function register(
        address agreement,
        address issuer,
        address mm,
        address market,
        address baseToken,
        bytes32 termsHash,
        string calldata uri
    ) external;
}

interface IAgreementFactory {
    function createAgreement(
        Terms calldata terms,
        address issuer,
        address mm,
        address operator,
        string calldata uri
    ) external returns (address agreement);
}
