// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Proof, MarketScale} from "./Types.sol";

/// @title SLALib
/// @notice In-transaction spread/depth proof computed from the vault's *own* fresh quotes.
/// @dev We intentionally do not use Kuru `bestBidAsk()` (it blends the backstop AMM and uses sentinel values:
///      empty bid = type(uint256).max, empty ask = 0). Because quotes are placed post-only in the same tx,
///      a successful `batchUpdate` proves the quotes are resting on the book at this block.
library SLALib {
    error NoTwoSidedQuote();
    error LengthMismatch();
    error CrossedQuote();
    error SpreadTooWide(uint256 spreadBps, uint256 maxSpreadBps);
    error DepthTooThin(uint256 bidDepth, uint256 askDepth, uint256 minDepth);

    /// @notice Quote notional (raw quote units) of `size` at `price`, mirroring Kuru's funding math.
    function notional(MarketScale memory s, uint256 price, uint256 size) internal pure returns (uint256) {
        return (price * size * (10 ** s.quoteDecimals)) / (s.pricePrecision * s.sizePrecision);
    }

    /// @notice Evaluates a two-sided ladder and returns the proof (does not enforce thresholds).
    /// Depth counts levels priced within ±maxSpreadBps of the mid.
    function evaluate(
        MarketScale memory s,
        uint32[] calldata bidPrices,
        uint96[] calldata bidSizes,
        uint32[] calldata askPrices,
        uint96[] calldata askSizes,
        uint16 maxSpreadBps
    ) internal view returns (Proof memory p) {
        if (bidPrices.length != bidSizes.length || askPrices.length != askSizes.length) revert LengthMismatch();
        if (bidPrices.length == 0 || askPrices.length == 0) revert NoTwoSidedQuote();

        uint32 bestBid;
        for (uint256 i; i < bidPrices.length; ++i) {
            if (bidPrices[i] > bestBid) bestBid = bidPrices[i];
        }
        uint32 bestAsk = type(uint32).max;
        for (uint256 i; i < askPrices.length; ++i) {
            if (askPrices[i] < bestAsk) bestAsk = askPrices[i];
        }
        if (bestAsk <= bestBid) revert CrossedQuote();

        uint256 mid2 = uint256(bestBid) + uint256(bestAsk); // 2 * mid, avoids rounding
        uint256 spreadBps = ((uint256(bestAsk) - bestBid) * 2e4) / mid2;
        // band edges: mid * (1 ± maxSpread)
        uint256 bidFloor = (mid2 * (1e4 - uint256(maxSpreadBps))) / 2e4;
        uint256 askCeil = (mid2 * (1e4 + uint256(maxSpreadBps))) / 2e4;

        uint256 bidDepth;
        for (uint256 i; i < bidPrices.length; ++i) {
            if (bidPrices[i] >= bidFloor) bidDepth += notional(s, bidPrices[i], bidSizes[i]);
        }
        uint256 askDepth;
        for (uint256 i; i < askPrices.length; ++i) {
            if (askPrices[i] <= askCeil) askDepth += notional(s, askPrices[i], askSizes[i]);
        }

        p = Proof({
            bestBid: bestBid,
            bestAsk: bestAsk,
            spreadBps: uint16(spreadBps > type(uint16).max ? type(uint16).max : spreadBps),
            blockNumber: uint64(block.number),
            bidDepthQuote: uint128(bidDepth),
            askDepthQuote: uint128(askDepth)
        });
    }

    /// @notice Reverts unless the proof satisfies the SLA.
    function enforce(Proof memory p, uint16 maxSpreadBps, uint256 minDepthQuote) internal pure {
        if (p.spreadBps > maxSpreadBps) revert SpreadTooWide(p.spreadBps, maxSpreadBps);
        if (p.bidDepthQuote < minDepthQuote || p.askDepthQuote < minDepthQuote) {
            revert DepthTooThin(p.bidDepthQuote, p.askDepthQuote, minDepthQuote);
        }
    }
}
