// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Terms, Proof, MarketScale} from "./libraries/Types.sol";
import {SLALib} from "./libraries/SLALib.sol";
import {KuruV1Adapter} from "./adapters/KuruV1Adapter.sol";
import {IHeartbeat, IPaystream, IBondVault} from "./interfaces/IQuoral.sol";

/// @title InventoryVault
/// @notice Root contract of one Quoral agreement (its address *is* the agreement id).
///         Owns the Kuru margin balance and every resting order. The MM's operator key can only
///         `requote` / `cancel`; inventory leaves only to the issuer, only after notice or expiry.
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

    event Requoted(uint256 indexed epoch, Proof proof, uint256 bidLevels, uint256 askLevels);
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
    /// Reverts (no heartbeat) on crossing (Kuru PostOnlyError), wide spread or thin depth.
    function requote(
        uint32[] calldata bidPrices,
        uint96[] calldata bidSizes,
        uint32[] calldata askPrices,
        uint96[] calldata askSizes
    ) external onlyOperator nonReentrant returns (uint256 epoch) {
        if (!isLive()) revert NotLive();
        epoch = currentEpoch();

        _openOrders = KuruV1Adapter.requote(_terms.market, bidPrices, bidSizes, askPrices, askSizes, _openOrders);

        Proof memory proof = SLALib.evaluate(_scale, bidPrices, bidSizes, askPrices, askSizes, _terms.maxSpreadBps);
        SLALib.enforce(proof, _terms.maxSpreadBps, _terms.minDepthQuote);

        IHeartbeat(heartbeat).record(epoch, proof);
        emit Requoted(epoch, proof, bidPrices.length, askPrices.length);
    }

    /// @notice Pull all of the vault's resting quotes. Operator while live; issuer after the end (to free inventory).
    function cancel() external nonReentrant {
        if (msg.sender == operator) {
            if (!isLive()) revert NotLive();
        } else if (msg.sender == issuer) {
            if (block.number < endBlock) revert NotEnded();
        } else {
            revert NotOperator();
        }
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
