// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Subset of Kuru v1 OrderBook used by Quoral.
/// Source: github.com/Kuru-Labs/Kuru-contracts-dex-public contracts/interfaces/IOrderBook.sol
interface IKuruOrderBook {
    enum MarketState {
        ACTIVE,
        SOFT_PAUSED,
        HARD_PAUSED
    }

    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );

    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata orderIdsToCancel,
        bool postOnly
    ) external;

    /// @notice Reverts with `OrderAlreadyFilledOrCancelled` if any id was already filled.
    function batchCancelOrders(uint40[] calldata orderIds) external;

    /// @notice Same, but skips filled ids instead of reverting.
    function batchCancelOrdersNoRevert(uint40[] calldata orderIds) external;

    function bestBidAsk() external view returns (uint256, uint256);

    function getL2Book(uint32 bidPricePoints, uint32 askPricePoints) external view returns (bytes memory);

    /// @return pricePrecision, sizePrecision, baseAsset, baseAssetDecimals, quoteAsset, quoteAssetDecimals,
    ///         tickSize, minSize, maxSize, takerFeeBps, makerFeeBps
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);

    function marketState() external view returns (MarketState);

    /// @notice Last order id issued by the book (public in Kuru v1). Ids are sequential, so the ids a single
    ///         batchUpdate created are exactly (counterBefore, counterAfter].
    function s_orderIdCounter() external view returns (uint40);
}

/// @notice Subset of Kuru v1 MarginAccount used by Quoral.
/// Note: `protocolPaused` is an internal storage variable in MarginAccount (no getter); see KuruV1Adapter.
interface IKuruMarginAccount {
    function deposit(address user, address token, uint256 amount) external payable;
    function withdraw(uint256 amount, address token) external;
    function getBalance(address user, address token) external view returns (uint256);
    function debitUser(address user, address token, uint256 amount) external;
}

/// @dev Kuru custom errors we match on (selectors depend only on name + args).
interface IKuruErrors {
    error PostOnlyError();
    error MarketStateError();
    error ProtocolPaused();
    error OnlyVerifiedMarketsAllowed();
    error InsufficientBalance();
}
