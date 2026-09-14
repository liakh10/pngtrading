// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PNG Trading market
/// @notice One collection of numbered PNG editions on a linear bonding curve. Every buy and sell pays a 5%
/// fee into a perp pool. When the pool reaches its target, 1-3x Long and Short positions open on the same
/// curve price. Formulas follow the ones JPEG Trading publishes and match pngtrading/lib/engine.js exactly.
/// Deployed as EIP-1167 clones by PngFactory; all amounts are in wei.
contract PngMarket {
    uint256 private constant WEI = 1e18;
    uint256 private constant MIN = 1e12;
    uint256 private constant MAX_MARGIN = 100 ether;
    uint256 private constant NFT_FEE_BPS = 500;
    uint256 private constant OPEN_BPS = 10;
    uint256 private constant CLOSE_BPS = 10;
    uint256 private constant MAINT_BPS = 500;
    uint256 private constant BORROW_BPS_DAY = 5;
    uint256 private constant LIQ_REWARD_BPS = 50;
    uint256 private constant MAX_BATCH = 20;

    struct Position {
        address owner;
        bool long;
        bool open;
        uint8 lev;
        uint40 openedAt;
        uint256 margin;
        uint256 notional;
        uint256 entry;
        uint256 qty;
        uint256 reserve;
    }

    struct Mark {
        uint256 price;
        int256 pnl;
        uint256 borrow;
        uint256 equity;
        uint256 closing;
        uint256 payout;
        bool liquidatable;
    }

    // collection
    string public name;
    string public symbol;
    string public art;
    address public creator;
    address public factory;
    uint64 public createdAt;

    // terms, fixed at creation
    uint256 public base;
    uint256 public maxSupply;
    uint256 public step;
    uint256 public maximum;
    uint256 public principal;
    uint256 public target;
    uint256 public capacity;

    // state
    uint256 public supply;
    uint256 public curve;
    uint256 public pool;
    uint256 public reserved;
    uint256 public gross;
    uint256 public margins;
    uint256 public volume;
    bool public live;
    uint256 public nextTokenId = 1;
    uint256 public nextPositionId = 1;
    mapping(uint256 => Position) public positions;

    // ERC-721
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approvals;
    mapping(address => mapping(address => bool)) private _operators;
    bool private _initialized;
    uint256 private _lock = 1;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Bought(address indexed buyer, uint256 n, uint256 firstId, uint256 raw, uint256 fee, uint256 priceBefore, uint256 priceAfter);
    event Sold(address indexed seller, uint256 n, uint256 raw, uint256 fee, uint256 priceBefore, uint256 priceAfter);
    event PoolLive(uint256 pool);
    event Opened(uint256 indexed id, address indexed owner, bool long, uint256 margin, uint8 lev, uint256 entry, uint256 qty, uint256 reserve, uint256 fee);
    event Closed(uint256 indexed id, address indexed owner, address indexed by, bool liquidated, uint256 exitPrice, int256 pnl, uint256 borrow, uint256 payout, uint256 reward);

    error AlreadyInitialized();
    error BadTerms();
    error BadAmount();
    error SoldOut();
    error NotOwner();
    error NotLive();
    error Slippage();
    error PositionClosed();
    error NotLiquidatable();
    error ExposureLimit();
    error ReserveLimit();
    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() {
        _initialized = true; // the implementation itself can never be used as a market
    }

    function initialize(
        address creator_,
        string calldata name_,
        string calldata symbol_,
        string calldata art_,
        uint256 base_,
        uint256 supply_,
        uint256 target_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _lock = 1;
        nextTokenId = 1;
        nextPositionId = 1;
        factory = msg.sender;
        creator = creator_;
        name = name_;
        symbol = symbol_;
        art = art_;
        createdAt = uint64(block.timestamp);

        if (base_ < MIN || base_ > WEI || supply_ < 10 || supply_ > 10_000) revert BadTerms();
        uint256 step_ = _ceilDiv(base_, supply_);
        uint256 maximum_ = base_ + step_ * supply_;
        uint256 principal_ = supply_ * base_ + (step_ * supply_ * (supply_ - 1)) / 2;
        uint256 minTarget = _ceilDiv(_bps(principal_, NFT_FEE_BPS), 4);
        uint256 maxTarget = _bps(principal_, NFT_FEE_BPS);
        uint256 capacity_ = (base_ * 500 * WEI) / (20_000 * step_);
        if ((capacity_ * base_) / WEI < 2 * MIN || minTarget < _ceilDiv(MIN * (maximum_ - base_), base_)) revert BadTerms();
        uint256 t = target_ == 0 ? minTarget : target_;
        if (t < minTarget || t > maxTarget) revert BadTerms();

        base = base_;
        maxSupply = supply_;
        step = step_;
        maximum = maximum_;
        principal = principal_;
        target = t;
        capacity = capacity_;
    }

    /* ---------------- curve ---------------- */

    function cum(uint256 k) public view returns (uint256) {
        if (k == 0) return 0;
        return k * base + (step * k * (k - 1)) / 2;
    }

    function price() public view returns (uint256) {
        return base + step * supply;
    }

    function quoteBuy(uint256 n) public view returns (uint256 raw, uint256 fee, uint256 total) {
        if (n == 0 || n > MAX_BATCH) revert BadAmount();
        if (supply + n > maxSupply) revert SoldOut();
        raw = cum(supply + n) - cum(supply);
        fee = _bps(raw, NFT_FEE_BPS);
        total = raw + fee;
    }

    function quoteSell(uint256 n) public view returns (uint256 raw, uint256 fee, uint256 total) {
        if (n == 0 || n > MAX_BATCH || n > supply) revert BadAmount();
        raw = cum(supply) - cum(supply - n);
        fee = _bps(raw, NFT_FEE_BPS);
        total = raw - fee;
    }

    /// @notice Buy n editions. Send at least the quoted total; anything above it is refunded.
    function buy(uint256 n) external payable nonReentrant returns (uint256 firstId) {
        (uint256 raw, uint256 fee, uint256 total) = quoteBuy(n);
        if (msg.value < total) revert Slippage();
        uint256 before = price();
        supply += n;
        curve += raw;
        pool += fee;
        volume += raw;
        firstId = nextTokenId;
        for (uint256 i = 0; i < n; ++i) _mint(msg.sender, nextTokenId++);
        _checkLive();
        emit Bought(msg.sender, n, firstId, raw, fee, before, price());
        if (msg.value > total) _send(msg.sender, msg.value - total);
    }

    /// @notice Sell editions back to the curve for at least minOut.
    function sell(uint256[] calldata ids, uint256 minOut) external nonReentrant returns (uint256 out) {
        uint256 n = ids.length;
        (uint256 raw, uint256 fee, uint256 total) = quoteSell(n);
        if (total < minOut) revert Slippage();
        for (uint256 i = 0; i < n; ++i) {
            if (_owners[ids[i]] != msg.sender) revert NotOwner();
            _burn(ids[i]);
        }
        uint256 before = price();
        supply -= n;
        curve -= raw;
        pool += fee;
        volume += raw;
        _checkLive();
        emit Sold(msg.sender, n, raw, fee, before, price());
        out = total;
        _send(msg.sender, out);
    }

    /* ---------------- perps ---------------- */

    function openFee(uint256 margin, uint8 lev) public pure returns (uint256) {
        return _bps(margin * lev, OPEN_BPS);
    }

    function maxCollateral(uint8 lev, bool long) external view returns (uint256 m) {
        if (!live || lev == 0) return 0;
        uint256 p = price();
        uint256 free = pool - reserved;
        uint256 qty = capacity > gross ? capacity - gross : 0;
        uint256 room = long ? maximum - p : p - base;
        uint256 byReserve = room == 0 ? qty : (free * WEI) / room;
        uint256 q = qty < byReserve ? qty : byReserve;
        m = q == 0 ? 0 : ((q + 1) * p - 1) / (uint256(lev) * WEI);
        if (m > MAX_MARGIN) m = MAX_MARGIN;
        if (m < MIN || (m * lev * WEI) / p == 0) m = 0;
    }

    /// @notice Open a position. Send margin + openFee(margin, lev).
    function open(bool long, uint256 margin, uint8 lev) external payable nonReentrant returns (uint256 id) {
        if (!live) revert NotLive();
        if (lev < 1 || lev > 3) revert BadAmount();
        if (margin < MIN || margin > MAX_MARGIN) revert BadAmount();
        uint256 notional = margin * lev;
        uint256 fee = _bps(notional, OPEN_BPS);
        if (msg.value != margin + fee) revert BadAmount();
        uint256 p = price();
        uint256 qty = (notional * WEI) / p;
        if (qty == 0) revert BadAmount();
        uint256 reserve = _ceilDiv(qty * (long ? maximum - p : p - base), WEI);
        if (gross + qty > capacity) revert ExposureLimit();
        if (reserve > pool - reserved + fee) revert ReserveLimit();
        pool += fee;
        reserved += reserve;
        gross += qty;
        margins += margin;
        id = nextPositionId++;
        positions[id] = Position(msg.sender, long, true, lev, uint40(block.timestamp), margin, notional, p, qty, reserve);
        emit Opened(id, msg.sender, long, margin, lev, p, qty, reserve, fee);
    }

    function mark(uint256 id) public view returns (Mark memory k) {
        Position storage pos = positions[id];
        uint256 p = price();
        bool good = pos.long ? p >= pos.entry : p <= pos.entry;
        uint256 diff = p >= pos.entry ? p - pos.entry : pos.entry - p;
        uint256 abs = good ? (pos.qty * diff) / WEI : _ceilDiv(pos.qty * diff, WEI);
        k.price = p;
        k.pnl = good ? int256(abs) : -int256(abs);
        uint256 secs = block.timestamp > pos.openedAt ? block.timestamp - pos.openedAt : 0;
        k.borrow = _ceilDiv(pos.notional * BORROW_BPS_DAY * secs, 10_000 * 86_400);
        uint256 plus = pos.margin + (good ? abs : 0);
        uint256 minus = (good ? 0 : abs) + k.borrow;
        k.equity = plus > minus ? plus - minus : 0;
        k.closing = _bps((pos.qty * p) / WEI, CLOSE_BPS);
        if (k.closing > k.equity) k.closing = k.equity;
        k.payout = k.equity - k.closing;
        k.liquidatable = k.equity <= _bps(pos.notional, MAINT_BPS);
    }

    /// @notice The owner closes a position at any time; anyone may close one that is liquidatable.
    function close(uint256 id) external nonReentrant returns (uint256 payout, uint256 reward) {
        Position storage pos = positions[id];
        if (!pos.open) revert PositionClosed();
        Mark memory k = mark(id);
        address owner = pos.owner;
        if (msg.sender != owner) {
            if (!k.liquidatable) revert NotLiquidatable();
            reward = _bps(pos.notional, LIQ_REWARD_BPS);
            if (reward > k.payout) reward = k.payout;
        }
        payout = k.payout - reward;
        // pool receives the margin and pays out; the reserve taken at open covers the largest possible profit
        pool = pool + pos.margin - payout - reward;
        margins -= pos.margin;
        reserved -= pos.reserve;
        gross -= pos.qty;
        pos.open = false;
        emit Closed(id, owner, msg.sender, msg.sender != owner, k.price, k.pnl, k.borrow, payout, reward);
        if (payout > 0) _send(owner, payout);
        if (reward > 0) _send(msg.sender, reward);
    }

    /* ---------------- views for the page ---------------- */

    function terms() external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256) {
        return (base, maxSupply, step, maximum, principal, target, capacity);
    }

    function stats() external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool) {
        return (supply, curve, pool, reserved, gross, margins, volume, live);
    }

    /* ---------------- ERC-721 ---------------- */

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert NotOwner();
    }

    function tokenURI(uint256) external view returns (string memory) {
        return art;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approvals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operators[owner][operator];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !_operators[owner][msg.sender]) revert NotOwner();
        _approvals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        if (owner != from || to == address(0)) revert NotOwner();
        if (msg.sender != owner && _approvals[tokenId] != msg.sender && !_operators[owner][msg.sender]) revert NotOwner();
        delete _approvals[tokenId];
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }

    /* ---------------- internal ---------------- */

    function _mint(address to, uint256 tokenId) private {
        _owners[tokenId] = to;
        unchecked {
            _balances[to] += 1;
        }
        emit Transfer(address(0), to, tokenId);
    }

    function _burn(uint256 tokenId) private {
        address owner = _owners[tokenId];
        delete _approvals[tokenId];
        delete _owners[tokenId];
        unchecked {
            _balances[owner] -= 1;
        }
        emit Transfer(owner, address(0), tokenId);
    }

    function _checkLive() private {
        if (!live && pool >= target) {
            live = true;
            emit PoolLive(pool);
        }
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _bps(uint256 x, uint256 b) private pure returns (uint256) {
        return _ceilDiv(x * b, 10_000);
    }
}
