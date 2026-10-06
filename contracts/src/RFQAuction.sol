// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Terms} from "./libraries/Types.sol";
import {IBondVault, IAgreementFactory} from "./interfaces/IQuoral.sol";
import {AgreementFactory} from "./AgreementFactory.sol";

/// @title RFQAuction
/// @notice Issuer publishes terms with a retainer cap; bonded quoters bid a retainer-per-block (bond locked);
///         the issuer awards any active bid, which deploys the agreement. Non-winning bonds unlock on withdraw.
contract RFQAuction is ReentrancyGuard {
    enum Status {
        None,
        Open,
        Awarded,
        Cancelled
    }

    struct RFQ {
        address issuer;
        uint64 deadline; // last block bids are accepted
        Status status;
        address winner;
        address agreement;
        string uri;
        Terms terms; // terms.retainerPerBlock = cap
    }

    struct Bid {
        uint256 retainerPerBlock;
        address operator;
        bool active;
    }

    error NotIssuer();
    error NotOpen();
    error BiddingClosed();
    error AboveCap();
    error ZeroRetainer();
    error NoBid();
    error IsWinner();

    event RFQOpened(uint256 indexed id, address indexed issuer, address indexed market, uint64 deadline, string uri);
    event BidPlaced(uint256 indexed id, address indexed bidder, uint256 retainerPerBlock, address operator);
    event BidWithdrawn(uint256 indexed id, address indexed bidder);
    event Awarded(uint256 indexed id, address indexed winner, address indexed agreement, uint256 retainerPerBlock);
    event RFQCancelled(uint256 indexed id);

    IBondVault public immutable bondVault;
    AgreementFactory public immutable factory;

    uint256 public rfqCount;
    mapping(uint256 => RFQ) internal _rfqs;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => address[]) internal _bidders;

    constructor(address bondVault_, address factory_) {
        bondVault = IBondVault(bondVault_);
        factory = AgreementFactory(factory_);
    }

    function openRFQ(Terms calldata terms, uint64 biddingBlocks, string calldata uri) external returns (uint256 id) {
        factory.validateTerms(terms);
        id = ++rfqCount;
        RFQ storage r = _rfqs[id];
        r.issuer = msg.sender;
        r.deadline = uint64(block.number) + biddingBlocks;
        r.status = Status.Open;
        r.uri = uri;
        r.terms = terms;
        emit RFQOpened(id, msg.sender, terms.market, r.deadline, uri);
    }

    /// @notice Place or update a bid. The first bid locks `terms.bondAmount` from the bidder's free bond.
    function bid(uint256 id, uint256 retainerPerBlock, address operator) external nonReentrant {
        RFQ storage r = _rfqs[id];
        if (r.status != Status.Open) revert NotOpen();
        if (block.number > r.deadline) revert BiddingClosed();
        if (retainerPerBlock == 0) revert ZeroRetainer();
        if (retainerPerBlock > r.terms.retainerPerBlock) revert AboveCap();
        Bid storage b = bids[id][msg.sender];
        if (!b.active) {
            bondVault.lock(msg.sender, r.terms.bondAmount);
            if (b.retainerPerBlock == 0 && b.operator == address(0)) _bidders[id].push(msg.sender);
            b.active = true;
        }
        b.retainerPerBlock = retainerPerBlock;
        b.operator = operator;
        emit BidPlaced(id, msg.sender, retainerPerBlock, operator);
    }

    function withdrawBid(uint256 id) external nonReentrant {
        RFQ storage r = _rfqs[id];
        Bid storage b = bids[id][msg.sender];
        if (!b.active) revert NoBid();
        if (r.winner == msg.sender) revert IsWinner();
        b.active = false;
        bondVault.unlock(msg.sender, r.terms.bondAmount);
        emit BidWithdrawn(id, msg.sender);
    }

    function award(uint256 id, address bidder) external nonReentrant returns (address agreement) {
        RFQ storage r = _rfqs[id];
        if (msg.sender != r.issuer) revert NotIssuer();
        if (r.status != Status.Open) revert NotOpen();
        Bid storage b = bids[id][bidder];
        if (!b.active) revert NoBid();

        Terms memory t = r.terms;
        t.retainerPerBlock = b.retainerPerBlock;
        r.status = Status.Awarded;
        r.winner = bidder;
        b.active = false;

        agreement = IAgreementFactory(address(factory)).createAgreement(t, r.issuer, bidder, b.operator, r.uri);
        r.agreement = agreement;
        bondVault.assign(bidder, t.bondAmount, agreement);
        emit Awarded(id, bidder, agreement, t.retainerPerBlock);
    }

    function cancelRFQ(uint256 id) external {
        RFQ storage r = _rfqs[id];
        if (msg.sender != r.issuer) revert NotIssuer();
        if (r.status != Status.Open) revert NotOpen();
        r.status = Status.Cancelled;
        emit RFQCancelled(id);
    }

    // ------------------------------------------------------------------ views

    function rfq(uint256 id) external view returns (RFQ memory) {
        return _rfqs[id];
    }

    function bidders(uint256 id) external view returns (address[] memory) {
        return _bidders[id];
    }

    /// @notice Lowest active bid (the default award choice in the UI).
    function bestBid(uint256 id) external view returns (address bidder, uint256 retainerPerBlock) {
        address[] storage list = _bidders[id];
        for (uint256 i; i < list.length; ++i) {
            Bid storage b = bids[id][list[i]];
            if (b.active && (bidder == address(0) || b.retainerPerBlock < retainerPerBlock)) {
                bidder = list[i];
                retainerPerBlock = b.retainerPerBlock;
            }
        }
    }
}
