// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20, MockMarginAccount, MockOrderBook} from "./mocks/MockKuru.sol";
import {IKuruOrderBook} from "../src/interfaces/IKuru.sol";
import {Terms, Proof, EpochStatus, MarketScale} from "../src/libraries/Types.sol";
import {SLALib} from "../src/libraries/SLALib.sol";
import {AgreementFactory} from "../src/AgreementFactory.sol";
import {InventoryVault} from "../src/InventoryVault.sol";
import {Heartbeat} from "../src/Heartbeat.sol";
import {Paystream} from "../src/Paystream.sol";
import {BondVault} from "../src/BondVault.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";
import {RFQAuction} from "../src/RFQAuction.sol";
import {CREKeeperReceiver} from "../src/keepers/CREKeeperReceiver.sol";

contract QuoralTest is Test {
    MockERC20 xaut;
    MockERC20 usdc;
    MockMarginAccount margin;
    MockOrderBook book;

    BondVault bonds;
    DisclosureRegistry registry;
    AgreementFactory factory;
    RFQAuction rfq;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address issuer = makeAddr("issuer");
    address mm = makeAddr("mm");
    address mm2 = makeAddr("mm2");
    address mm3 = makeAddr("mm3");
    address op = makeAddr("operator");
    address taker = makeAddr("taker");
    address keeper = makeAddr("keeper");

    // price precision 100 (cents), size precision 1e4 (0.0001 oz)
    uint32 constant BID = 389_000; // $3890.00
    uint32 constant ASK = 390_500; // $3905.00 → ~38.5 bps
    uint96 constant SIZE = 25_800; // 2.58 oz ≈ $10k per side

    uint256 constant RATE = 1_000; // 0.001 USDC / block
    uint32 constant EPOCH = 100;

    InventoryVault vault;
    Heartbeat hb;
    Paystream ps;

    function setUp() public {
        vm.roll(1_000);
        xaut = new MockERC20("Tether Gold", "XAUt0", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        margin = new MockMarginAccount();
        book = new MockOrderBook(margin, address(xaut), address(usdc), 100, 1e4);
        margin.setMarket(address(book));

        bonds = new BondVault(address(usdc), owner);
        registry = new DisclosureRegistry();
        factory = new AgreementFactory(owner, address(margin), address(bonds), address(registry), treasury, 1000);
        rfq = new RFQAuction(address(bonds), address(factory));
        registry.setFactory(address(factory));
        vm.startPrank(owner);
        bonds.setWiring(address(rfq), address(factory));
        factory.setRFQ(address(rfq));
        factory.setMarket(address(book), true);
        vm.stopPrank();

        xaut.mint(issuer, 100e6);
        usdc.mint(issuer, 1_000_000e6);
        for (uint256 i; i < 3; ++i) {
            address m = i == 0 ? mm : i == 1 ? mm2 : mm3;
            usdc.mint(m, 10_000e6);
            vm.startPrank(m);
            usdc.approve(address(bonds), type(uint256).max);
            bonds.deposit(5_000e6);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ helpers

    function _terms() internal view returns (Terms memory t) {
        t = Terms({
            market: address(book),
            baseInventory: 10e6,
            quoteInventory: 50_000e6,
            maxSpreadBps: 50,
            minDepthQuote: 10_000e6,
            epochBlocks: EPOCH,
            uptimeWindowEpochs: 10,
            uptimeBps: 8000, // 2 misses allowed per 10-epoch window
            retainerPerBlock: 5_000, // cap
            durationBlocks: 100 * EPOCH,
            noticeBlocks: 500,
            bondAmount: 1_000e6,
            slashAmount: 200e6,
            pauseExcused: true
        });
    }

    function _deal() internal returns (uint256 id) {
        vm.startPrank(issuer);
        id = rfq.openRFQ(_terms(), 50, "ipfs://terms");
        xaut.approve(address(factory), type(uint256).max);
        usdc.approve(address(factory), type(uint256).max);
        vm.stopPrank();
        vm.prank(mm);
        rfq.bid(id, RATE, op);
        vm.prank(issuer);
        address a = rfq.award(id, mm);
        vault = InventoryVault(a);
        hb = Heartbeat(vault.heartbeat());
        ps = Paystream(vault.paystream());
    }

    function _arr32(uint32 a) internal pure returns (uint32[] memory r) {
        r = new uint32[](1);
        r[0] = a;
    }

    function _arr96(uint96 a) internal pure returns (uint96[] memory r) {
        r = new uint96[](1);
        r[0] = a;
    }

    function _quote() internal returns (uint256) {
        return _quote(BID, ASK, SIZE, SIZE);
    }

    function _quote(uint32 bid, uint32 ask, uint96 bs, uint96 asz) internal returns (uint256 epoch) {
        vm.prank(op);
        epoch = vault.requote(_arr32(bid), _arr96(bs), _arr32(ask), _arr96(asz));
    }

    function _nextEpoch() internal {
        vm.roll(block.number + EPOCH);
    }

    // ------------------------------------------------------------------ creation / disclosure

    function test_award_deploys_and_funds_agreement() public {
        _deal();
        (uint256 b, uint256 q) = vault.marginBalances();
        assertEq(b, 10e6);
        assertEq(q, 50_000e6);
        assertEq(usdc.balanceOf(address(ps)), RATE * 100 * EPOCH);
        assertEq(vault.totalEpochs(), 100);
        DisclosureRegistry.Disclosure memory d = registry.disclosure(address(vault));
        assertEq(d.issuer, issuer);
        assertEq(d.mm, mm);
        assertEq(d.termsHash, keccak256(abi.encode(vault.terms())));
        assertTrue(d.issuerAttested && d.mmAttested);
        assertEq(registry.agreementsOf(address(xaut))[0], address(vault));
        (address m,, uint256 amt,,) = bonds.bonds(address(vault));
        assertEq(m, mm);
        assertEq(amt, 1_000e6);
    }

    // ------------------------------------------------------------------ proof

    function test_requote_records_heartbeat_proof() public {
        _deal();
        uint256 e = _quote();
        assertEq(e, 0);
        assertEq(uint8(hb.status(0)), uint8(EpochStatus.Quoted));
        (uint32 bb, uint32 ba, uint16 spread,, uint128 bd, uint128 ad) = hb.proofs(0);
        assertEq(bb, BID);
        assertEq(ba, ASK);
        assertEq(spread, 38);
        assertGe(bd, 10_000e6);
        assertGe(ad, 10_000e6);
    }

    function test_postOnly_crossing_reverts() public {
        _deal();
        // someone else rests an ask at 3895.00
        margin.setMarket(address(this));
        xaut.mint(taker, 1e6);
        vm.startPrank(taker);
        xaut.approve(address(margin), 1e6);
        margin.deposit(taker, address(xaut), 1e6);
        book.addSellOrder(389_500, 100, false);
        vm.stopPrank();
        // our bid at 3896.00 would cross → Kuru PostOnlyError
        vm.prank(op);
        vm.expectRevert(MockOrderBook.PostOnlyError.selector);
        vault.requote(_arr32(389_600), _arr96(SIZE), _arr32(390_000), _arr96(SIZE));
    }

    function test_spread_too_wide_reverts() public {
        _deal();
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(SLALib.SpreadTooWide.selector, 77, 50));
        vault.requote(_arr32(388_000), _arr96(SIZE), _arr32(391_000), _arr96(SIZE));
    }

    function test_depth_too_thin_reverts() public {
        _deal();
        vm.prank(op);
        vm.expectRevert();
        vault.requote(_arr32(BID), _arr96(1_000), _arr32(ASK), _arr96(SIZE));
    }

    function test_depth_outside_band_not_counted() public {
        _deal();
        uint32[] memory bids = new uint32[](2);
        uint96[] memory bsz = new uint96[](2);
        bids[0] = BID;
        bsz[0] = 1_000; // tiny inside band
        bids[1] = 300_000;
        bsz[1] = SIZE; // big but far outside ±50 bps
        vm.prank(op);
        vm.expectRevert();
        vault.requote(bids, bsz, _arr32(ASK), _arr96(SIZE));
    }

    // ------------------------------------------------------------------ inventory safety

    function test_operator_cannot_touch_inventory() public {
        _deal();
        vm.startPrank(op);
        vm.expectRevert(InventoryVault.NotIssuer.selector);
        vault.withdrawInventory();
        vm.expectRevert(InventoryVault.NotParty.selector);
        vault.giveNotice();
        vm.expectRevert(InventoryVault.NotParty.selector);
        vault.proposeOperator(op);
        vm.stopPrank();
        vm.prank(mm);
        vm.expectRevert(InventoryVault.NotIssuer.selector);
        vault.withdrawInventory();
    }

    function test_issuer_cannot_withdraw_before_end() public {
        _deal();
        vm.prank(issuer);
        vm.expectRevert(InventoryVault.NotEnded.selector);
        vault.withdrawInventory();
    }

    function test_fills_stay_in_vault() public {
        _deal();
        _quote();
        uint40 bidId = book.counter() - 1; // bid placed first
        book.fill(bidId, taker);
        (uint256 b,) = vault.marginBalances();
        // 10 XAUt - 2.58 locked in ask + 2.58 bought = 10
        assertEq(b, 10e6);
        assertEq(xaut.balanceOf(mm), 0);
        assertEq(xaut.balanceOf(op), 0);
    }

    function test_requote_replaces_previous_quotes_automatically() public {
        _deal();
        _quote(); // 389,000 / 390,500
        uint40[] memory first = vault.openOrders();
        assertEq(first.length, 2);
        _nextEpoch();
        // A restarted operator that knows nothing about the old orders quotes above the old ask.
        // Without the vault cancelling its own set first this would cross itself (PostOnlyError).
        _quote(390_600, 392_100, SIZE, SIZE);
        uint40[] memory second = vault.openOrders();
        assertEq(second.length, 2);
        assertEq(second[0], first[1] + 1);
        (,,,, bool active0) = book.orders(first[0]);
        (,,,, bool active1) = book.orders(first[1]);
        assertFalse(active0 || active1);
        // operator can pull everything at once
        vm.prank(op);
        vault.cancel();
        assertEq(vault.openOrders().length, 0);
        (uint256 b, uint256 q) = vault.marginBalances();
        assertEq(b, 10e6);
        assertEq(q, 50_000e6);
    }

    function test_operator_rotation_two_of_two() public {
        _deal();
        address op2 = makeAddr("op2");
        vm.prank(mm);
        vault.proposeOperator(op2);
        vm.prank(mm);
        vm.expectRevert(InventoryVault.SameProposer.selector);
        vault.acceptOperator();
        vm.prank(issuer);
        vault.acceptOperator();
        assertEq(vault.operator(), op2);
        vm.prank(op);
        vm.expectRevert(InventoryVault.NotOperator.selector);
        vault.requote(_arr32(BID), _arr96(SIZE), _arr32(ASK), _arr96(SIZE));
    }

    // ------------------------------------------------------------------ settlement

    function test_clawback_on_missed_epochs() public {
        _deal();
        _quote(); // epoch 0
        _nextEpoch();
        _quote(); // epoch 1, replaces the epoch-0 orders
        _nextEpoch();
        _nextEpoch();
        _nextEpoch(); // epochs 2,3 missed; now in epoch 4
        vm.expectRevert(abi.encodeWithSelector(Heartbeat.EpochNotEnded.selector, 4));
        hb.checkEpoch(4);

        uint256 before = usdc.balanceOf(issuer);
        vm.prank(keeper);
        hb.checkEpoch(3);
        assertEq(usdc.balanceOf(issuer) - before, 2 * RATE * EPOCH);
        assertEq(ps.earned(), 2 * RATE * EPOCH);
        assertEq(ps.clawedBack(), 2 * RATE * EPOCH);
        assertEq(uint8(hb.status(2)), uint8(EpochStatus.Missed));
        assertEq(hb.settledEpochs(), 4);
        assertEq(hb.missedCount(), 2);
        assertEq(hb.windowUptimeBps(0), 5000);
    }

    function test_slash_on_uptime_breach() public {
        _deal();
        _quote();
        vm.roll(block.number + 4 * EPOCH); // now epoch 4; epochs 1,2,3 missed (allowed 2)
        uint256 before = usdc.balanceOf(issuer);
        hb.checkEpoch(3);
        uint256 clawed = 3 * RATE * EPOCH;
        assertEq(usdc.balanceOf(issuer) - before, clawed + 200e6);
        (,, uint256 left, uint256 slashed,) = bonds.bonds(address(vault));
        assertEq(slashed, 200e6);
        assertEq(left, 800e6);
        assertEq(hb.totalSlashed(), 200e6);
    }

    function test_excused_epoch_on_market_pause() public {
        _deal();
        book.setState(IKuruOrderBook.MarketState.SOFT_PAUSED);
        assertTrue(vault.venuePaused());
        vm.prank(keeper);
        hb.flagPause();
        book.setState(IKuruOrderBook.MarketState.ACTIVE);
        _nextEpoch();
        hb.checkEpoch(0);
        assertEq(uint8(hb.status(0)), uint8(EpochStatus.Excused));
        assertEq(ps.clawedBack(), 0);
        assertEq(ps.earned(), RATE * EPOCH);
    }

    function test_excused_epoch_on_protocol_pause_probe() public {
        _deal();
        assertFalse(vault.venuePaused());
        margin.setPaused(true);
        assertTrue(vault.venuePaused());
        hb.flagPause();
        margin.setPaused(false);
        vm.expectRevert(Heartbeat.NotPaused.selector);
        hb.flagPause();
    }

    function test_claim_takes_protocol_fee() public {
        _deal();
        _quote();
        _nextEpoch();
        hb.checkEpoch(0);
        ps.claim();
        uint256 gross = RATE * EPOCH;
        assertEq(usdc.balanceOf(treasury), gross / 10);
        assertEq(usdc.balanceOf(mm), 5_000e6 + gross - gross / 10);
        assertEq(ps.claimable(), 0);
    }

    function test_liveAccrued_streams_per_block() public {
        _deal();
        vm.roll(block.number + 37);
        assertEq(ps.liveAccrued(), 37 * RATE);
    }

    // ------------------------------------------------------------------ termination

    function test_notice_finalize_and_withdraw() public {
        _deal();
        _quote(); // epoch 0
        vm.roll(block.number + 150); // epoch 1, no quote
        vm.prank(issuer);
        vault.giveNotice(); // elapsed 150 + 500 notice → rounds up to 700 → 7 epochs
        assertEq(vault.totalEpochs(), 7);
        vm.prank(mm);
        vm.expectRevert(InventoryVault.NoticeAlreadyGiven.selector);
        vault.giveNotice();

        vm.roll(vault.endBlock());
        assertFalse(vault.isLive());
        vm.expectRevert(InventoryVault.NotFullySettled.selector);
        vault.finalize();
        hb.checkEpoch(6); // 1 quoted, 6 missed → one window breach → slash

        uint256 issuerBefore = usdc.balanceOf(issuer);
        vault.finalize();
        uint256 budget = RATE * 100 * EPOCH;
        uint256 earned = RATE * EPOCH;
        // refund = budget - earned - clawed(6 epochs)
        assertEq(usdc.balanceOf(issuer) - issuerBefore, budget - earned - 6 * RATE * EPOCH);
        assertEq(usdc.balanceOf(mm), 5_000e6 + earned - earned / 10);
        assertEq(bonds.free(mm), 4_000e6 + 800e6);

        // issuer pulls the vault's resting quotes, then the inventory
        vm.startPrank(issuer);
        vault.cancel();
        vault.withdrawInventory();
        vm.stopPrank();
        assertEq(xaut.balanceOf(issuer), 100e6);
        vm.expectRevert(InventoryVault.AlreadyFinalized.selector);
        vault.finalize();
    }

    function test_requote_after_end_reverts() public {
        _deal();
        vm.roll(vault.endBlock());
        vm.prank(op);
        vm.expectRevert(InventoryVault.NotLive.selector);
        vault.requote(_arr32(BID), _arr96(SIZE), _arr32(ASK), _arr96(SIZE));
    }

    // ------------------------------------------------------------------ RFQ

    function test_rfq_lowest_bid_wins_losers_unlock() public {
        vm.startPrank(issuer);
        uint256 id = rfq.openRFQ(_terms(), 50, "ipfs://terms");
        xaut.approve(address(factory), type(uint256).max);
        usdc.approve(address(factory), type(uint256).max);
        vm.stopPrank();

        vm.prank(mm);
        rfq.bid(id, 3_000, op);
        vm.prank(mm2);
        rfq.bid(id, 2_000, op);
        vm.prank(mm3);
        vm.expectRevert(RFQAuction.AboveCap.selector);
        rfq.bid(id, 6_000, op);
        vm.prank(mm3);
        rfq.bid(id, 2_500, op);
        vm.prank(mm);
        rfq.bid(id, 1_500, op); // rebid, no double lock
        assertEq(bonds.locked(mm), 1_000e6);

        (address best, uint256 r) = rfq.bestBid(id);
        assertEq(best, mm);
        assertEq(r, 1_500);

        vm.prank(issuer);
        address a = rfq.award(id, best);
        assertEq(Paystream(InventoryVault(a).paystream()).retainerPerBlock(), 1_500);
        assertEq(bonds.locked(mm), 0);

        vm.prank(mm);
        vm.expectRevert(RFQAuction.NoBid.selector);
        rfq.withdrawBid(id);
        vm.prank(mm2);
        rfq.withdrawBid(id);
        assertEq(bonds.free(mm2), 5_000e6);

        vm.prank(issuer);
        vm.expectRevert(RFQAuction.NotOpen.selector);
        rfq.award(id, mm3);
    }

    function test_rfq_bid_requires_bond_and_window() public {
        vm.prank(issuer);
        uint256 id = rfq.openRFQ(_terms(), 10, "");
        address poor = makeAddr("poor");
        vm.prank(poor);
        vm.expectRevert(BondVault.Insufficient.selector);
        rfq.bid(id, 1_000, op);
        vm.roll(block.number + 11);
        vm.prank(mm);
        vm.expectRevert(RFQAuction.BiddingClosed.selector);
        rfq.bid(id, 1_000, op);
    }

    function test_only_rfq_creates_agreements() public {
        vm.expectRevert(AgreementFactory.NotRFQ.selector);
        factory.createAgreement(_terms(), issuer, mm, op, "");
    }

    function test_invalid_terms_rejected() public {
        Terms memory t = _terms();
        t.durationBlocks = 150;
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AgreementFactory.InvalidTerms.selector, "durationBlocks"));
        rfq.openRFQ(t, 10, "");
        t = _terms();
        t.market = address(0xdead);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AgreementFactory.MarketNotAllowed.selector, address(0xdead)));
        rfq.openRFQ(t, 10, "");
    }

    // ------------------------------------------------------------------ CRE keeper

    function test_cre_receiver_settles_and_isolates_failures() public {
        _deal();
        _quote();
        vm.roll(block.number + 3 * EPOCH);
        address fwd = makeAddr("forwarder");
        CREKeeperReceiver r = new CREKeeperReceiver(owner, fwd);
        CREKeeperReceiver.Job[] memory jobs = new CREKeeperReceiver.Job[](3);
        jobs[0] = CREKeeperReceiver.Job(address(hb), 0, 99); // not ended → caught
        jobs[1] = CREKeeperReceiver.Job(address(hb), 0, 2);
        jobs[2] = CREKeeperReceiver.Job(address(hb), 1, 0); // not paused → caught
        vm.expectRevert(abi.encodeWithSelector(CREKeeperReceiver.NotForwarder.selector, address(this)));
        r.onReport("", abi.encode(jobs));
        vm.prank(fwd);
        r.onReport("", abi.encode(jobs));
        assertEq(hb.settledEpochs(), 3);
        assertEq(hb.missedCount(), 2);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_spread_matches_definition(uint32 bid, uint16 widthBps) public {
        bid = uint32(bound(bid, 10_000, 1_000_000_000));
        widthBps = uint16(bound(widthBps, 1, 2_000));
        uint32 ask = uint32(uint256(bid) + (uint256(bid) * widthBps) / 1e4 + 1);
        Proof memory p = this.evalExt(bid, ask);
        uint256 expected = ((uint256(ask) - bid) * 2e4) / (uint256(ask) + bid);
        assertEq(p.spreadBps, expected);
        assertLe(p.spreadBps, widthBps + 1);
    }

    function evalExt(uint32 bid, uint32 ask) external view returns (Proof memory) {
        uint32[] memory b = _arr32(bid);
        uint32[] memory a = _arr32(ask);
        uint96[] memory s = _arr96(1e4);
        return this.evalCalldata(b, s, a, s);
    }

    function evalCalldata(uint32[] calldata b, uint96[] calldata bs, uint32[] calldata a, uint96[] calldata as_)
        external
        view
        returns (Proof memory)
    {
        MarketScale memory sc = MarketScale(100, 1e4, 6, 6, address(xaut), address(usdc));
        return SLALib.evaluate(sc, b, bs, a, as_, 50);
    }
}
