// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IKuruOrderBook} from "../../src/interfaces/IKuru.sol";

contract MockERC20 is ERC20 {
    uint8 internal immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @notice Mirrors Kuru v1 MarginAccount semantics we rely on (modifier order, errors, msg.sender accounting).
contract MockMarginAccount {
    error OnlyVerifiedMarketsAllowed();
    error InsufficientBalance();
    error ProtocolPaused();

    bool internal protocolPaused; // no getter, like Kuru
    mapping(address => bool) public verifiedMarket;
    mapping(address => mapping(address => uint256)) internal balances;

    modifier protocolActive() {
        if (protocolPaused) revert ProtocolPaused();
        _;
    }

    function setPaused(bool p) external {
        protocolPaused = p;
    }

    function setMarket(address m) external {
        verifiedMarket[m] = true;
    }

    function deposit(address user, address token, uint256 amount) external payable protocolActive {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        balances[user][token] += amount;
    }

    function withdraw(uint256 amount, address token) external protocolActive {
        if (balances[msg.sender][token] < amount) revert InsufficientBalance();
        balances[msg.sender][token] -= amount;
        IERC20(token).transfer(msg.sender, amount);
    }

    function debitUser(address user, address token, uint256 amount) external protocolActive {
        if (!verifiedMarket[msg.sender]) revert OnlyVerifiedMarketsAllowed();
        if (balances[user][token] < amount) revert InsufficientBalance();
        balances[user][token] -= amount;
    }

    function creditUser(address user, address token, uint256 amount, bool) external protocolActive {
        if (!verifiedMarket[msg.sender]) revert OnlyVerifiedMarketsAllowed();
        balances[user][token] += amount;
    }

    function getBalance(address user, address token) external view returns (uint256) {
        return balances[user][token];
    }
}

/// @notice Minimal Kuru-like CLOB: post-only crossing check, margin-funded orders, owner-only cancel, fills.
contract MockOrderBook {
    error PostOnlyError();
    error MarketStateError();
    error OnlyOwnerAllowedError();
    error LengthMismatch();

    struct Order {
        address owner;
        uint32 price;
        uint96 size;
        bool isBuy;
        bool active;
    }

    event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy);
    event OrdersCanceled(uint40[] orderId, address owner);
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

    MockMarginAccount public immutable margin;
    address public immutable base;
    address public immutable quote;
    uint32 public immutable pricePrecision;
    uint96 public immutable sizePrecision;
    uint256 public immutable baseDec;
    uint256 public immutable quoteDec;

    IKuruOrderBook.MarketState public marketState;
    uint40 public counter;
    mapping(uint40 => Order) public orders;
    uint40[] internal _active; // resting order ids (swap-remove), keeps best-price scans O(open orders)
    mapping(uint40 => uint256) internal _activeIdx; // 1-based

    function _deactivate(uint40 id) internal {
        orders[id].active = false;
        uint256 i = _activeIdx[id];
        if (i == 0) return;
        uint40 last = _active[_active.length - 1];
        _active[i - 1] = last;
        _activeIdx[last] = i;
        _active.pop();
        delete _activeIdx[id];
    }

    constructor(MockMarginAccount m, address b, address q, uint32 pp, uint96 sp) {
        margin = m;
        base = b;
        quote = q;
        pricePrecision = pp;
        sizePrecision = sp;
        baseDec = MockERC20(b).decimals();
        quoteDec = MockERC20(q).decimals();
    }

    function s_orderIdCounter() external view returns (uint40) {
        return counter;
    }

    function setState(IKuruOrderBook.MarketState s) external {
        marketState = s;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (pricePrecision, sizePrecision, base, baseDec, quote, quoteDec, 1, 1, type(uint96).max, 0, 0);
    }

    function _quoteAmt(uint256 price, uint256 size) internal view returns (uint256) {
        return (price * size * (10 ** quoteDec)) / (uint256(pricePrecision) * sizePrecision);
    }

    function _baseAmt(uint256 size) internal view returns (uint256) {
        return (size * (10 ** baseDec)) / sizePrecision;
    }

    /// @notice Kuru semantics: 1e18-scaled; empty bid = type(uint256).max, empty ask = 0.
    function bestBidAsk() external view returns (uint256, uint256) {
        (uint256 bid, uint256 ask) = _best();
        return (
            bid == 0 ? type(uint256).max : (bid * 1e18) / pricePrecision,
            ask == type(uint256).max ? 0 : (ask * 1e18) / pricePrecision
        );
    }

    function _best() internal view returns (uint256 bid, uint256 ask) {
        ask = type(uint256).max;
        for (uint256 i; i < _active.length; ++i) {
            Order storage o = orders[_active[i]];
            if (o.isBuy && o.price > bid) bid = o.price;
            if (!o.isBuy && o.price < ask) ask = o.price;
        }
    }

    function getL2Book(uint32, uint32) external pure returns (bytes memory) {
        return "";
    }

    function _add(address owner, uint32 price, uint96 size, bool isBuy, bool postOnly) internal {
        if (marketState != IKuruOrderBook.MarketState.ACTIVE) revert MarketStateError();
        (uint256 bid, uint256 ask) = _best();
        if (postOnly) {
            if (isBuy && price >= ask) revert PostOnlyError();
            if (!isBuy && price <= bid) revert PostOnlyError();
        }
        if (isBuy) margin.debitUser(owner, quote, _quoteAmt(price, size));
        else margin.debitUser(owner, base, _baseAmt(size));
        uint40 id = ++counter;
        orders[id] = Order(owner, price, size, isBuy, true);
        _active.push(id);
        _activeIdx[id] = _active.length;
        emit OrderCreated(id, owner, size, price, isBuy);
    }

    function _cancel(uint40 id) internal {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert OnlyOwnerAllowedError();
        if (!o.active) return;
        _deactivate(id);
        if (o.isBuy) margin.creditUser(o.owner, quote, _quoteAmt(o.price, o.size), true);
        else margin.creditUser(o.owner, base, _baseAmt(o.size), true);
    }

    function addBuyOrder(uint32 price, uint96 size, bool postOnly) external {
        _add(msg.sender, price, size, true, postOnly);
    }

    function addSellOrder(uint32 price, uint96 size, bool postOnly) external {
        _add(msg.sender, price, size, false, postOnly);
    }

    function batchUpdate(
        uint32[] calldata buyPrices,
        uint96[] calldata buySizes,
        uint32[] calldata sellPrices,
        uint96[] calldata sellSizes,
        uint40[] calldata cancelIds,
        bool postOnly
    ) external {
        if (marketState == IKuruOrderBook.MarketState.HARD_PAUSED) revert MarketStateError();
        if (buyPrices.length != buySizes.length || sellPrices.length != sellSizes.length) revert LengthMismatch();
        for (uint256 i; i < cancelIds.length; ++i) {
            _cancel(cancelIds[i]);
        }
        if (cancelIds.length > 0) emit OrdersCanceled(cancelIds, msg.sender);
        for (uint256 i; i < buyPrices.length; ++i) {
            _add(msg.sender, buyPrices[i], buySizes[i], true, postOnly);
        }
        for (uint256 i; i < sellPrices.length; ++i) {
            _add(msg.sender, sellPrices[i], sellSizes[i], false, postOnly);
        }
    }

    function batchCancelOrders(uint40[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            _cancel(ids[i]);
        }
        emit OrdersCanceled(ids, msg.sender);
    }

    /// @notice Test helper: a taker fully fills resting order `id`; maker is credited in margin (like Kuru).
    function fill(uint40 id, address taker) external {
        Order storage o = orders[id];
        require(o.active, "inactive");
        _deactivate(id);
        uint256 q = _quoteAmt(o.price, o.size);
        uint256 b = _baseAmt(o.size);
        if (o.isBuy) {
            margin.creditUser(o.owner, base, b, true);
            margin.creditUser(taker, quote, q, true);
        } else {
            margin.creditUser(o.owner, quote, q, true);
            margin.creditUser(taker, base, b, true);
        }
        emit Trade(id, o.owner, o.isBuy, o.price, 0, taker, tx.origin, o.size);
    }
}
