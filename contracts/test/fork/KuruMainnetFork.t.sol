// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IKuruOrderBook} from "../../src/interfaces/IKuru.sol";
import {Terms, EpochStatus} from "../../src/libraries/Types.sol";
import {AgreementFactory} from "../../src/AgreementFactory.sol";
import {InventoryVault} from "../../src/InventoryVault.sol";
import {Heartbeat} from "../../src/Heartbeat.sol";
import {BondVault} from "../../src/BondVault.sol";
import {DisclosureRegistry} from "../../src/DisclosureRegistry.sol";
import {RFQAuction} from "../../src/RFQAuction.sol";

interface IKuruTaker {
    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256);
}

/// @notice Quoral against the real Kuru v1 contracts on a fork of Monad mainnet (chain 143), XAUt0-USDC market.
///   MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-contract KuruMainnetFork -vv
/// Skipped when MONAD_RPC_URL is unset, so CI without network access stays green.
contract KuruMainnetForkTest is Test {
    address constant MARGIN = 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5;
    address constant MARKET = 0x851145eaeFdc37956B08dA829fa31722199F3f07; // XAUt0-USDC
    address constant XAUT0 = 0x01bFF41798a0BcF287b996046Ca68b395DbC1071;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    address issuer = makeAddr("issuer");
    address mm = makeAddr("mm");
    address op = makeAddr("operator");
    address taker = makeAddr("taker");
    address keeper = makeAddr("keeper");

    uint32 constant EPOCH = 100;
    uint256 constant RATE = 1_000;

    InventoryVault vault;
    Heartbeat hb;
    uint32 tick;
    uint96 minSize;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 143);

        BondVault bonds = new BondVault(USDC, address(this));
        DisclosureRegistry registry = new DisclosureRegistry();
        AgreementFactory factory =
            new AgreementFactory(address(this), MARGIN, address(bonds), address(registry), address(this), 1000);
        RFQAuction rfq = new RFQAuction(address(bonds), address(factory));
        registry.setFactory(address(factory));
        bonds.setWiring(address(rfq), address(factory));
        factory.setRFQ(address(rfq));
        factory.setMarket(MARKET, true);

        deal(XAUT0, issuer, 20e6);
        deal(USDC, issuer, 200_000e6);
        deal(USDC, mm, 10_000e6);
        deal(USDC, taker, 50_000e6);
        (,,,,,, tick, minSize,,,) = IKuruOrderBook(MARKET).getMarketParams();

        Terms memory t = Terms({
            market: MARKET,
            baseInventory: 10e6, // 10 XAUt0
            quoteInventory: 50_000e6,
            maxSpreadBps: 50,
            minDepthQuote: 10_000e6,
            epochBlocks: EPOCH,
            uptimeWindowEpochs: 10,
            uptimeBps: 8000,
            retainerPerBlock: 5_000,
            durationBlocks: 20 * EPOCH,
            noticeBlocks: 500,
            bondAmount: 1_000e6,
            slashAmount: 200e6,
            pauseExcused: true,
            maxMidMoveBps: 150,
            startDelayBlocks: 0
        });
        vm.startPrank(issuer);
        uint256 id = rfq.openRFQ(t, 50, "ipfs://fork");
        IERC20(XAUT0).approve(address(factory), type(uint256).max);
        IERC20(USDC).approve(address(factory), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(mm);
        IERC20(USDC).approve(address(bonds), type(uint256).max);
        bonds.deposit(1_000e6);
        rfq.bid(id, RATE, op);
        vm.stopPrank();
        vm.prank(issuer);
        vault = InventoryVault(rfq.award(id, mm, RATE));
        hb = Heartbeat(vault.heartbeat());
    }

    /// @dev Our quotes one tick inside the live book (post-only safe), sized for the depth term plus 2%.
    function _quoteInsideTheBook() internal returns (uint32 bid, uint32 ask, uint96 askSize) {
        (uint256 b18, uint256 a18) = IKuruOrderBook(MARKET).bestBidAsk();
        require(b18 != type(uint256).max && a18 != 0, "empty book");
        uint256 bestBid = (b18 * 1e4) / 1e18; // pricePrecision 1e4
        uint256 bestAsk = (a18 * 1e4 + 1e18 - 1) / 1e18;
        bid = uint32(((bestBid / tick) + 1) * tick);
        ask = uint32(((bestAsk / tick) - 1) * tick);
        if (ask <= bid) (bid, ask) = (uint32((bestBid / tick) * tick), uint32(((bestAsk + tick - 1) / tick) * tick));
        uint96 bidSize = uint96((10_200e6 * 1e4 * 1e6) / (uint256(bid) * 1e6)); // size units for $10.2k
        askSize = uint96((10_200e6 * 1e4 * 1e6) / (uint256(ask) * 1e6));
        uint32[] memory bp = new uint32[](1);
        uint32[] memory ap = new uint32[](1);
        uint96[] memory bs = new uint96[](1);
        uint96[] memory as_ = new uint96[](1);
        (bp[0], ap[0], bs[0], as_[0]) = (bid, ask, bidSize, askSize);
        vm.prank(op);
        vault.requote(bp, bs, ap, as_);
    }

    function test_fork_requote_proves_sla_on_real_kuru() public {
        (uint32 bid, uint32 ask,) = _quoteInsideTheBook();
        assertEq(uint8(hb.status(0)), uint8(EpochStatus.Quoted));
        (uint32 bb, uint32 ba, uint16 spread,, uint128 bd, uint128 ad) = hb.proofs(0);
        assertEq(bb, bid);
        assertEq(ba, ask);
        assertLe(spread, 50);
        assertGe(bd, 10_000e6);
        assertGe(ad, 10_000e6);
        assertEq(vault.openOrders().length, 2);
        assertFalse(vault.venuePaused()); // the protocol-pause probe on the real MarginAccount
        // crossing the live book is rejected by Kuru itself
        (, uint256 a18) = IKuruOrderBook(MARKET).bestBidAsk();
        uint32[] memory bp = new uint32[](1);
        uint32[] memory ap = new uint32[](1);
        uint96[] memory sz = new uint96[](1);
        bp[0] = uint32((((a18 * 1e4) / 1e18) / tick + 2) * tick);
        ap[0] = bp[0] + 10 * tick;
        sz[0] = 3_000_000;
        vm.roll(block.number + EPOCH);
        vm.prank(op);
        vm.expectRevert();
        vault.requote(bp, sz, ap, sz);
    }

    function test_fork_filled_quote_then_cancel_and_withdraw() public {
        (, uint32 ask, uint96 askSize) = _quoteInsideTheBook();
        uint40[] memory ids = vault.openOrders(); // [bid, ask]
        (uint256 freeBase0, uint256 freeQuote0) = vault.marginBalances();

        // a real Kuru market buy takes our ask completely (it is the best ask), plus a little of the next level
        uint256 spend = (uint256(ask) * askSize) / 1e6 + 10_000; // price-precision units
        vm.startPrank(taker);
        IERC20(USDC).approve(MARKET, type(uint256).max);
        uint256 got = IKuruTaker(MARKET).placeAndExecuteMarketBuy(uint96(spend), 0, false, false);
        vm.stopPrank();
        assertGe(got, (uint256(askSize) * 1e6) / 1e6);
        (uint256 freeBase1, uint256 freeQuote1) = vault.marginBalances();
        assertEq(freeBase1, freeBase0); // base was locked in the ask and is gone
        // Kuru credits the maker floor(price * size / sizePrecision) price units, converted to USDC decimals
        uint256 proceeds = ((uint256(ask) * askSize) / 1e6) * 1e6 / 1e4;
        assertEq(freeQuote1 - freeQuote0, proceeds);

        vm.roll(vault.endBlock());
        // Kuru's reverting batch cancel fails on the filled ask...
        vm.prank(address(vault));
        vm.expectRevert();
        IKuruOrderBook(MARKET).batchCancelOrders(ids);
        // ...the vault's no-revert cancel returns the bid's quote, and the issuer withdraws everything
        vm.prank(keeper);
        vault.cancel();
        uint256 x0 = IERC20(XAUT0).balanceOf(issuer);
        uint256 u0 = IERC20(USDC).balanceOf(issuer);
        vm.prank(issuer);
        vault.withdrawInventory();
        assertEq(IERC20(XAUT0).balanceOf(issuer) - x0, 10e6 - askSize); // 6-decimal token, size precision 1e6
        // Kuru rounds a bid's funding up when placing and its refund down when cancelling: one price unit
        assertApproxEqAbs(IERC20(USDC).balanceOf(issuer) - u0, 50_000e6 + proceeds, 100);
    }
}
