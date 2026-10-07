// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IKuruOrderBook, IKuruMarginAccount, IKuruErrors} from "../interfaces/IKuru.sol";
import {MarketScale} from "../libraries/Types.sol";

/// @title KuruV1Adapter
/// @notice Venue calls for Kuru v1 (OrderBook + MarginAccount). Internal library so that the *vault* is
///         `_msgSender()` for Kuru: the vault owns the margin balance and every resting order.
/// @dev Implements the venue surface described by IVenueAdapter; a Kuru v2 (AccountCore) adapter will follow.
library KuruV1Adapter {
    using SafeERC20 for IERC20;

    error NativeAssetUnsupported();

    function scale(address market) internal view returns (MarketScale memory s) {
        (uint32 pp, uint96 sp, address base, uint256 bd, address quote, uint256 qd,,,,,) =
            IKuruOrderBook(market).getMarketParams();
        if (base == address(0) || quote == address(0)) revert NativeAssetUnsupported();
        s = MarketScale({
            pricePrecision: pp,
            sizePrecision: sp,
            baseDecimals: bd,
            quoteDecimals: qd,
            baseToken: base,
            quoteToken: quote
        });
    }

    function depositToMargin(address marginAccount, address token, uint256 amount) internal {
        if (amount == 0) return;
        IERC20(token).forceApprove(marginAccount, amount);
        IKuruMarginAccount(marginAccount).deposit(address(this), token, amount);
    }

    function withdrawFromMargin(address marginAccount, address token, uint256 amount) internal {
        if (amount == 0) return;
        IKuruMarginAccount(marginAccount).withdraw(amount, token);
    }

    function marginBalance(address marginAccount, address token) internal view returns (uint256) {
        return IKuruMarginAccount(marginAccount).getBalance(address(this), token);
    }

    /// @notice Atomic cancel-and-replace, post-only. Any crossing reverts with Kuru `PostOnlyError()`.
    /// @param previous the vault's own resting order ids from its last requote (cancelled in the same call)
    /// @return placed the ids this call created, read from Kuru's sequential order counter
    function requote(
        address market,
        uint32[] calldata bidPrices,
        uint96[] calldata bidSizes,
        uint32[] calldata askPrices,
        uint96[] calldata askSizes,
        uint40[] memory previous
    ) internal returns (uint40[] memory placed) {
        IKuruOrderBook ob = IKuruOrderBook(market);
        uint40 before = ob.s_orderIdCounter();
        ob.batchUpdate(bidPrices, bidSizes, askPrices, askSizes, previous, true);
        uint40 after_ = ob.s_orderIdCounter();
        placed = new uint40[](after_ - before);
        for (uint40 i; i < after_ - before; ++i) {
            placed[i] = before + 1 + i;
        }
    }

    /// @dev No-revert variant: any of these quotes may have been filled since they were placed, and Kuru's
    ///      `batchCancelOrders` reverts on a filled id, which would leave the rest of the inventory on the book.
    function cancel(address market, uint40[] memory ids) internal {
        if (ids.length > 0) IKuruOrderBook(market).batchCancelOrdersNoRevert(ids);
    }

    /// @notice Smallest order size the market accepts (Kuru size units).
    function minSize(address market) internal view returns (uint96 size) {
        (,,,,,,, size,,,) = IKuruOrderBook(market).getMarketParams();
    }

    /// @notice True when the venue blocks quoting: market not ACTIVE or MarginAccount protocol paused.
    /// @dev MarginAccount.protocolPaused has no getter. `debitUser` checks `protocolActive` *before*
    ///      `verifiedMarket`, so a static call from a non-market reverts with `ProtocolPaused()` iff paused.
    function venuePaused(address market, address marginAccount, address token) internal view returns (bool) {
        if (IKuruOrderBook(market).marketState() != IKuruOrderBook.MarketState.ACTIVE) return true;
        (bool ok, bytes memory ret) =
            marginAccount.staticcall(abi.encodeCall(IKuruMarginAccount.debitUser, (address(this), token, 0)));
        return !ok && ret.length >= 4 && bytes4(ret) == IKuruErrors.ProtocolPaused.selector;
    }
}
