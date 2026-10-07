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

    /// @notice What the SLA check needs beyond the stored proof.
    struct Detail {
        uint256 mid2; // 2 x the mid the proof was measured against, Kuru price units
        bool bidAllInBand; // every bid level counts toward depth (vacuously true with no bids)
        bool askAllInBand;
    }

    /// @notice Quote notional (raw quote units) of `size` at `price`, mirroring Kuru's funding math.
    function notional(MarketScale memory s, uint256 price, uint256 size) internal pure returns (uint256) {
        return (price * size * (10 ** s.quoteDecimals)) / (s.pricePrecision * s.sizePrecision);
    }

    /// @notice Base amount (raw base units) of `size`.
    function baseAmount(MarketScale memory s, uint256 size) internal pure returns (uint256) {
        return (size * (10 ** s.baseDecimals)) / s.sizePrecision;
    }

    /// @notice Evaluates a ladder and returns the proof (does not enforce thresholds).
    /// Two-sided: the mid is the midpoint of our own best bid and ask. One-sided (the other side's inventory is
    /// used up): the mid is `refMid2 / 2`, the vault's last proven mid, and the spread is twice the distance from
    /// that mid to our best price. Depth counts levels priced within ±maxSpreadBps of the mid.
    function evaluate(
        MarketScale memory s,
        uint32[] calldata bidPrices,
        uint96[] calldata bidSizes,
        uint32[] calldata askPrices,
        uint96[] calldata askSizes,
        uint16 maxSpreadBps,
        uint256 refMid2
    ) internal view returns (Proof memory p, Detail memory d) {
        if (bidPrices.length != bidSizes.length || askPrices.length != askSizes.length) {
            revert LengthMismatch();
        }
        if (bidPrices.length == 0 && askPrices.length == 0) revert NoTwoSidedQuote();
        (uint32 bestBid, uint32 bestAsk) = _bests(bidPrices, askPrices);
        uint256 spreadBps;
        (d.mid2, spreadBps) = _midAndSpread(bestBid, bestAsk, bidPrices.length > 0, askPrices.length > 0, refMid2);
        // band edges: mid * (1 ± maxSpread)
        uint256 bidDepth;
        uint256 askDepth;
        (bidDepth, d.bidAllInBand) =
            _depth(s, bidPrices, bidSizes, (d.mid2 * (1e4 - uint256(maxSpreadBps))) / 2e4, true);
        (askDepth, d.askAllInBand) =
            _depth(s, askPrices, askSizes, (d.mid2 * (1e4 + uint256(maxSpreadBps))) / 2e4, false);
        p = Proof({
            bestBid: bestBid,
            bestAsk: bestAsk,
            spreadBps: uint16(spreadBps > type(uint16).max ? type(uint16).max : spreadBps),
            blockNumber: uint64(block.number),
            bidDepthQuote: uint128(bidDepth),
            askDepthQuote: uint128(askDepth)
        });
    }

    /// @dev Highest bid and lowest ask; 0 for an empty side.
    function _bests(uint32[] calldata bidPrices, uint32[] calldata askPrices)
        private
        pure
        returns (uint32 bestBid, uint32 bestAsk)
    {
        for (uint256 i; i < bidPrices.length; ++i) {
            if (bidPrices[i] > bestBid) bestBid = bidPrices[i];
        }
        if (askPrices.length == 0) return (bestBid, 0);
        bestAsk = type(uint32).max;
        for (uint256 i; i < askPrices.length; ++i) {
            if (askPrices[i] < bestAsk) bestAsk = askPrices[i];
        }
    }

    function _midAndSpread(uint32 bestBid, uint32 bestAsk, bool hasBid, bool hasAsk, uint256 refMid2)
        private
        pure
        returns (uint256 mid2, uint256 spreadBps)
    {
        if (hasBid && hasAsk) {
            if (bestAsk <= bestBid) revert CrossedQuote();
            mid2 = uint256(bestBid) + uint256(bestAsk); // 2 * mid, avoids rounding
            spreadBps = ((uint256(bestAsk) - bestBid) * 2e4) / mid2;
        } else {
            if (refMid2 == 0) revert NoTwoSidedQuote();
            mid2 = refMid2;
            uint256 best2 = 2 * uint256(hasBid ? bestBid : bestAsk);
            // a lone bid must sit below the mid, a lone ask above it
            if (hasBid ? best2 >= refMid2 : best2 <= refMid2) revert CrossedQuote();
            spreadBps = ((hasBid ? refMid2 - best2 : best2 - refMid2) * 2e4) / refMid2;
        }
    }

    /// @dev Notional of the levels inside the band (bids at or above `edge`, asks at or below it).
    function _depth(MarketScale memory s, uint32[] calldata prices, uint96[] calldata sizes, uint256 edge, bool isBid)
        private
        pure
        returns (uint256 depth, bool allInBand)
    {
        allInBand = true;
        for (uint256 i; i < prices.length; ++i) {
            if (isBid ? prices[i] >= edge : prices[i] <= edge) depth += notional(s, prices[i], sizes[i]);
            else allInBand = false;
        }
    }

    /// @notice Reverts unless the proof satisfies the SLA.
    /// @param bidShort the vault cannot fund one more minimum-size bid after this placement (quote used up)
    /// @param askShort the same for asks (base used up)
    /// @dev A short side meets the depth term by posting everything it has inside the band: the shortfall is
    ///      the issuer's inventory, not the market maker's effort.
    function enforce(
        Proof memory p,
        Detail memory d,
        uint16 maxSpreadBps,
        uint256 minDepthQuote,
        bool bidShort,
        bool askShort
    ) internal pure {
        if (p.spreadBps > maxSpreadBps) revert SpreadTooWide(p.spreadBps, maxSpreadBps);
        bool bidOk = p.bidDepthQuote >= minDepthQuote || (bidShort && d.bidAllInBand);
        bool askOk = p.askDepthQuote >= minDepthQuote || (askShort && d.askAllInBand);
        if (!bidOk || !askOk) revert DepthTooThin(p.bidDepthQuote, p.askDepthQuote, minDepthQuote);
    }
}
