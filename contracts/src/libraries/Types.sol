// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Public, onchain terms of a Quoral market-making agreement.
/// All quote-denominated amounts are raw units of the market's quote token (e.g. USDC, 6 decimals).
struct Terms {
    address market; // Kuru OrderBook
    uint256 baseInventory; // base tokens the issuer locks into the vault
    uint256 quoteInventory; // quote tokens the issuer locks into the vault
    uint16 maxSpreadBps; // max quoted spread, (ask - bid) / mid
    uint256 minDepthQuote; // min notional per side within ±maxSpreadBps of mid
    uint32 epochBlocks; // e.g. 100 blocks ≈ 30 s at 300 ms blocks
    uint32 uptimeWindowEpochs; // uptime measurement window (e.g. 2880 epochs = 1 day)
    uint16 uptimeBps; // required uptime per window, e.g. 9500
    uint256 retainerPerBlock; // retainer streamed to the MM (cap in an RFQ; winning bid in an agreement)
    uint64 durationBlocks; // multiple of epochBlocks
    uint64 noticeBlocks; // termination notice period
    uint256 bondAmount; // MM bond, in BondVault token
    uint256 slashAmount; // liquidated damages per uptime-window breach
    bool pauseExcused; // venue pauses excuse missed epochs
    uint16 maxMidMoveBps; // max move of the quoted mid per epoch vs the last proven mid (0 = no cap)
    uint32 startDelayBlocks; // setup time between the award and epoch 0
}

/// @notice SLA proof produced inside the requote transaction from the vault's own fresh quotes.
struct Proof {
    uint32 bestBid; // Kuru price units
    uint32 bestAsk;
    uint16 spreadBps;
    uint64 blockNumber;
    uint128 bidDepthQuote; // raw quote units within band
    uint128 askDepthQuote;
}

/// @notice The vault's price memory in one storage slot: the drift cap and one-sided quotes measure against it.
struct PriceRef {
    uint64 lastMid2; // 2 x mid of the latest accepted requote, Kuru price units (0 = never quoted)
    uint48 lastEpoch; // epoch of that requote
    uint64 anchorMid2; // lastMid2 as it stood at the first requote of the anchor epoch
    uint48 anchorEpoch1; // anchor epoch + 1 (0 = none yet)
    uint32 anchorGap; // epochs between the anchor's requote and the anchor epoch
}

/// @notice Kuru price/size scale for a market.
struct MarketScale {
    uint256 pricePrecision;
    uint256 sizePrecision;
    uint256 baseDecimals;
    uint256 quoteDecimals;
    address baseToken;
    address quoteToken;
}

enum EpochStatus {
    Pending,
    Quoted,
    Excused,
    Missed
}
