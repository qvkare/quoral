// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Terms, Proof, MarketScale, PriceRef} from "./libraries/Types.sol";
import {SLALib} from "./libraries/SLALib.sol";
import {KuruV1Adapter} from "./adapters/KuruV1Adapter.sol";
import {IHeartbeat, IPaystream, IBondVault} from "./interfaces/IQuoral.sol";

/// @title InventoryVault
/// @notice Root contract of one Quoral agreement (its address *is* the agreement id).
///         Owns the Kuru margin balance and every resting order. The MM's operator key can only `requote`;
///         inventory leaves only to the issuer, only after notice or expiry.
contract InventoryVault is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct InitParams {
        Terms terms;
        address issuer;
        address mm;
        address operator;
        address marginAccount;
        address heartbeat;
        address paystream;
        address bondVault;
        uint64 startBlock;
    }

    error NotOperator();
    error NotIssuer();
    error NotParty();
    error NotLive();
    error NotEnded();
    error AlreadyFinalized();
    error NotFullySettled();
    error NoticeAlreadyGiven();
    error NoPendingOperator();
    error SameProposer();
    error MidMovedTooFar(uint256 mid2, uint256 anchorMid2, uint256 allowedBps);

    event Requoted(uint256 indexed epoch, Proof proof, uint256 bidLevels, uint256 askLevels);
    event InventoryLimited(uint256 indexed epoch, bool bidShort, bool askShort);
    event InventoryAdded(address indexed by, uint256 baseAmount, uint256 quoteAmount);
    event Canceled(address indexed by, uint40[] orderIds);
    event NoticeGiven(address indexed by, uint64 newEndBlock);
    event OperatorProposed(address indexed by, address indexed operator);
    event OperatorChanged(address indexed oldOperator, address indexed newOperator);
    event InventoryWithdrawn(address indexed to, uint256 baseAmount, uint256 quoteAmount);
    event Finalized(uint256 settledEpochs);

    Terms internal _terms;
    MarketScale internal _scale;

    address public factory;
    address public issuer;
    address public mm;
    address public operator;
    address public marginAccount;
    address public heartbeat;
    address public paystream;
    address public bondVault;

    uint64 public startBlock;
    uint64 public endBlock;
    bool public noticeGiven;
    bool public finalized;

    address public pendingOperator;
    address public operatorProposer;

    /// @notice Smallest order the market accepts; a side that cannot fund one more of these is "short".
    uint96 public minOrderSize;
    PriceRef internal _ref;

    /// @dev Kuru order ids placed by the latest requote. The next requote (or cancel) removes exactly these,
    ///      so a restarted or careless operator can never leave stale quotes that cross the new ones.
    uint40[] internal _openOrders;

    constructor() {
        _disableInitializers();
    }

    /// @dev Factory must transfer inventory to this contract before calling.
    function initialize(InitParams calldata p, MarketScale calldata s) external initializer {
        _terms = p.terms;
        _scale = s;
        factory = msg.sender;
        issuer = p.issuer;
        mm = p.mm;
        operator = p.operator;
        marginAccount = p.marginAccount;
        heartbeat = p.heartbeat;
        paystream = p.paystream;
        bondVault = p.bondVault;
        startBlock = p.startBlock;
        endBlock = p.startBlock + p.terms.durationBlocks;

        minOrderSize = KuruV1Adapter.minSize(p.terms.market);

        KuruV1Adapter.depositToMargin(p.marginAccount, s.baseToken, p.terms.baseInventory);
        KuruV1Adapter.depositToMargin(p.marginAccount, s.quoteToken, p.terms.quoteInventory);
    }

    // ------------------------------------------------------------------ modifiers

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    modifier onlyParty() {
        if (msg.sender != issuer && msg.sender != mm) revert NotParty();
        _;
    }

    // ------------------------------------------------------------------ quoting

    /// @notice Replace the vault's quotes in one tx (its previous orders are cancelled automatically, post-only
    ///         placement), then prove the SLA from these exact quotes.
    /// Reverts (no heartbeat) on crossing (Kuru PostOnlyError), wide spread, thin depth or a mid that moved
    /// further than `maxMidMoveBps` per epoch. A side whose inventory is used up may be thin or empty, as long as
    /// everything the vault holds of that token is posted inside the band (`InventoryLimited`).
    function requote(
        uint32[] calldata bidPrices,
        uint96[] calldata bidSizes,
        uint32[] calldata askPrices,
        uint96[] calldata askSizes
    ) external onlyOperator nonReentrant returns (uint256 epoch) {
        if (!isLive()) revert NotLive();
        epoch = currentEpoch();

        _openOrders = KuruV1Adapter.requote(_terms.market, bidPrices, bidSizes, askPrices, askSizes, _openOrders);

        MarketScale memory s = _scale;
        uint16 maxSpread = _terms.maxSpreadBps;
        uint256 minDepth = _terms.minDepthQuote;
        (Proof memory proof, SLALib.Detail memory d) =
            SLALib.evaluate(s, bidPrices, bidSizes, askPrices, askSizes, maxSpread, _ref.lastMid2);

        // only read margin when a side is under the depth term: what is left after this placement
        bool bidShort;
        bool askShort;
        if (proof.bidDepthQuote < minDepth) {
            bidShort =
                KuruV1Adapter.marginBalance(marginAccount, s.quoteToken) < SLALib.notional(s, d.mid2 / 2, minOrderSize);
        }
        if (proof.askDepthQuote < minDepth) {
            askShort = KuruV1Adapter.marginBalance(marginAccount, s.baseToken) < SLALib.baseAmount(s, minOrderSize);
        }
        SLALib.enforce(proof, d, maxSpread, minDepth, bidShort, askShort);
        _checkDrift(epoch, d.mid2);

        IHeartbeat(heartbeat).record(epoch, proof);
        if (bidShort || askShort) emit InventoryLimited(epoch, bidShort, askShort);
        emit Requoted(epoch, proof, bidPrices.length, askPrices.length);
    }

    /// @dev Caps how far the quoted mid may move: at most `maxMidMoveBps` per epoch from the mid proven before
    ///      this epoch began (scaled by the epochs since then), so every requote within an epoch is measured
    ///      against the same anchor and a key cannot walk the price away from the market in small steps.
    function _checkDrift(uint256 epoch, uint256 mid2) internal {
        PriceRef memory r = _ref;
        if (r.anchorEpoch1 != epoch + 1) {
            r.anchorMid2 = r.lastMid2;
            r.anchorGap = r.lastMid2 == 0 ? 0 : uint32(epoch - r.lastEpoch);
            r.anchorEpoch1 = uint48(epoch + 1);
        } else if (r.anchorMid2 == 0 && r.lastMid2 != 0) {
            // the epoch of the very first proof: later requotes in it are measured from that proof
            r.anchorMid2 = r.lastMid2;
            r.anchorGap = 1;
        }
        uint256 cap = _terms.maxMidMoveBps;
        if (cap > 0 && r.anchorMid2 > 0) {
            uint256 a = r.anchorMid2;
            uint256 diff = mid2 > a ? mid2 - a : a - mid2;
            if (diff * 1e4 > a * cap * r.anchorGap) revert MidMovedTooFar(mid2, a, cap * r.anchorGap);
        }
        r.lastMid2 = uint64(mid2);
        r.lastEpoch = uint48(epoch);
        _ref = r;
    }

    /// @notice Pulls the vault's resting quotes once the agreement has ended. Anyone may call it: the funds go
    ///         back to the vault's margin, which only the issuer can withdraw. While live there is no cancel at
    ///         all; quotes leave the book only when filled or replaced by SLA-compliant ones, so a quote cannot be
    ///         posted for the proof and pulled right after.
    function cancel() external nonReentrant {
        if (block.number < endBlock) revert NotEnded();
        uint40[] memory ids = _openOrders;
        delete _openOrders;
        KuruV1Adapter.cancel(_terms.market, ids);
        emit Canceled(msg.sender, ids);
    }

    // ------------------------------------------------------------------ lifecycle

    /// @notice Either party gives notice; the agreement ends at the first epoch boundary after `noticeBlocks`.
    function giveNotice() external onlyParty {
        if (noticeGiven) revert NoticeAlreadyGiven();
        if (finalized) revert AlreadyFinalized();
        noticeGiven = true;
        uint256 eb = _terms.epochBlocks;
        uint256 elapsed = block.number > startBlock ? block.number - startBlock : 0;
        uint256 target = elapsed + _terms.noticeBlocks;
        uint256 rounded = ((target + eb - 1) / eb) * eb;
        uint64 newEnd = uint64(startBlock + rounded);
        if (newEnd < endBlock) endBlock = newEnd;
        emit NoticeGiven(msg.sender, endBlock);
    }

    /// @notice 2-of-2 operator rotation: one party proposes, the other accepts.
    function proposeOperator(address newOperator) external onlyParty {
        pendingOperator = newOperator;
        operatorProposer = msg.sender;
        emit OperatorProposed(msg.sender, newOperator);
    }

    function acceptOperator() external onlyParty {
        if (pendingOperator == address(0)) revert NoPendingOperator();
        if (msg.sender == operatorProposer) revert SameProposer();
        emit OperatorChanged(operator, pendingOperator);
        operator = pendingOperator;
        pendingOperator = address(0);
        operatorProposer = address(0);
    }

    /// @notice Issuer tops up inventory, e.g. after one side was bought or sold out. Goes straight to Kuru margin.
    function addInventory(uint256 baseAmount, uint256 quoteAmount) external onlyIssuer nonReentrant {
        if (finalized || block.number >= endBlock) revert NotLive();
        MarketScale memory s = _scale;
        if (baseAmount > 0) IERC20(s.baseToken).safeTransferFrom(msg.sender, address(this), baseAmount);
        if (quoteAmount > 0) IERC20(s.quoteToken).safeTransferFrom(msg.sender, address(this), quoteAmount);
        KuruV1Adapter.depositToMargin(marginAccount, s.baseToken, baseAmount);
        KuruV1Adapter.depositToMargin(marginAccount, s.quoteToken, quoteAmount);
        emit InventoryAdded(msg.sender, baseAmount, quoteAmount);
    }

    /// @notice Inventory (incl. fills, which Kuru credits to this vault's margin) returns only to the issuer.
    function withdrawInventory() external onlyIssuer nonReentrant {
        if (block.number < endBlock) revert NotEnded();
        address base = _scale.baseToken;
        address quote = _scale.quoteToken;
        KuruV1Adapter.withdrawFromMargin(marginAccount, base, KuruV1Adapter.marginBalance(marginAccount, base));
        KuruV1Adapter.withdrawFromMargin(marginAccount, quote, KuruV1Adapter.marginBalance(marginAccount, quote));
        uint256 b = IERC20(base).balanceOf(address(this));
        uint256 q = IERC20(quote).balanceOf(address(this));
        if (b > 0) IERC20(base).safeTransfer(issuer, b);
        if (q > 0) IERC20(quote).safeTransfer(issuer, q);
        emit InventoryWithdrawn(issuer, b, q);
    }

    /// @notice Permissionless once ended and every epoch is settled: pays out the stream, refunds the
    ///         unused retainer to the issuer and releases the remaining bond to the MM.
    function finalize() external nonReentrant {
        if (finalized) revert AlreadyFinalized();
        if (block.number < endBlock) revert NotEnded();
        uint256 settled = IHeartbeat(heartbeat).settledEpochs();
        if (settled < totalEpochs()) revert NotFullySettled();
        finalized = true;
        IPaystream(paystream).finalize();
        IBondVault(bondVault).release();
        emit Finalized(settled);
    }

    // ------------------------------------------------------------------ views

    /// @notice Kuru order ids currently owned by the vault's latest quote set.
    function openOrders() external view returns (uint40[] memory) {
        return _openOrders;
    }

    function terms() external view returns (Terms memory) {
        return _terms;
    }

    function marketScale() external view returns (MarketScale memory) {
        return _scale;
    }

    /// @notice The last proven mid and the drift anchor (see `_checkDrift`).
    function priceRef() external view returns (PriceRef memory) {
        return _ref;
    }

    function isLive() public view returns (bool) {
        return !finalized && block.number >= startBlock && block.number < endBlock;
    }

    function currentEpoch() public view returns (uint256) {
        if (block.number < startBlock) return 0;
        return (block.number - startBlock) / _terms.epochBlocks;
    }

    function totalEpochs() public view returns (uint256) {
        return (endBlock - startBlock) / _terms.epochBlocks;
    }

    function venuePaused() external view returns (bool) {
        return KuruV1Adapter.venuePaused(_terms.market, marginAccount, _scale.quoteToken);
    }

    /// @notice Inventory currently free in Kuru margin (resting orders lock the rest inside the book).
    function marginBalances() external view returns (uint256 base, uint256 quote) {
        base = KuruV1Adapter.marginBalance(marginAccount, _scale.baseToken);
        quote = KuruV1Adapter.marginBalance(marginAccount, _scale.quoteToken);
    }
}
