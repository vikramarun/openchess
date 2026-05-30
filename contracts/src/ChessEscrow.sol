// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ERC-20 surface used by the escrow (USDC implements this).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title ChessEscrow
/// @notice Non-custodial escrow for the machine-vs-machine chess wagering
/// platform, deployed on Base and denominated in USDC.
///
/// Design (see plan §money layer):
///  - A single pooled contract holds every player's **bankroll**. Funds live in
///    this contract, never in a platform wallet.
///  - Each game **locks** a stake from both players' bankrolls. Withdrawals are
///    capped at `bankroll - locked`, so a user can never withdraw staked funds.
///  - A game is settled by submitting a **time-bounded EIP-712 signed result**
///    from the platform oracle. Anyone may relay the signature. The oracle can
///    only move a locked stake between the two committed players (minus the rake
///    snapshotted at open) — it can never mint balance or pay outsiders.
///  - `claimTimeout` refunds both stakes if a game is never settled.
contract ChessEscrow {
    // --- storage ----------------------------------------------------------

    IERC20 public immutable token;
    address public oracle;        // platform result-signing key
    address public owner;         // can rotate oracle / fee params / pause
    address public pendingOwner;  // Ownable2Step
    address public feeRecipient;  // accrues rake as a normal bankroll balance
    uint16 public feeBps;         // rake in basis points (e.g. 100 = 1%)
    uint64 public settleTimeout;  // seconds after open before timeout refund
    bool public paused;

    mapping(address => uint256) public bankroll; // total deposited per user
    mapping(address => uint256) public locked;   // exposure locked in open games

    struct Game {
        address white;
        address black;
        uint256 stake;
        uint16 feeBps;   // rake snapshotted at open
        uint64 openedAt;
        bool settled;
        bool exists;
    }

    mapping(bytes32 => Game) public games;

    // EIP-712 (domain separator recomputed if the chain id changes, e.g. a fork)
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 public constant RESULT_TYPEHASH =
        keccak256("GameResult(bytes32 gameId,address winner,uint256 deadline)");

    uint256 private _reentrancyGuard = 1;

    // --- events -----------------------------------------------------------

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event GameOpened(bytes32 indexed gameId, address indexed white, address indexed black, uint256 stake);
    event GameSettled(bytes32 indexed gameId, address winner, uint256 stake, uint256 rake);
    event GameRefunded(bytes32 indexed gameId);
    event OracleUpdated(address oracle);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedSet(bool paused);

    // --- errors -----------------------------------------------------------

    error NotOwner();
    error NotOracle();
    error Reentrancy();
    error Paused();
    error InsufficientUnlocked();
    error GameExists();
    error UnknownGame();
    error AlreadySettled();
    error BadPlayers();
    error BadWinner();
    error BadSignature();
    error Expired();
    error TimeoutNotReached();
    error TransferFailed();
    error ZeroStake();

    // --- modifiers --------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyGuard != 1) revert Reentrancy();
        _reentrancyGuard = 2;
        _;
        _reentrancyGuard = 1;
    }

    // --- constructor ------------------------------------------------------

    constructor(
        address token_,
        address oracle_,
        address feeRecipient_,
        uint16 feeBps_,
        uint64 settleTimeout_
    ) {
        require(token_ != address(0) && oracle_ != address(0) && feeRecipient_ != address(0), "zero addr");
        require(feeBps_ <= 1_000, "fee too high");
        token = IERC20(token_);
        oracle = oracle_;
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        settleTimeout = settleTimeout_;

        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    // --- bankroll ---------------------------------------------------------

    /// Deposit USDC into your bankroll. Requires prior ERC-20 approval. Credits
    /// the *measured* balance delta to be safe against fee-on-transfer tokens.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        uint256 before = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        bankroll[msg.sender] += received;
        emit Deposited(msg.sender, received);
    }

    /// Withdraw up to your *unlocked* balance. Always available (even paused).
    function withdraw(uint256 amount) external nonReentrant {
        if (amount > available(msg.sender)) revert InsufficientUnlocked();
        bankroll[msg.sender] -= amount;
        _safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// Bankroll not currently locked in open games.
    function available(address user) public view returns (uint256) {
        return bankroll[user] - locked[user];
    }

    // --- game lifecycle ---------------------------------------------------

    /// Open a game, locking `stake` from each player. Oracle-only. Both players
    /// must be distinct, non-fee addresses with enough unlocked bankroll.
    function openGame(bytes32 gameId, address white, address black, uint256 stake)
        external
        whenNotPaused
    {
        if (msg.sender != oracle) revert NotOracle();
        if (stake == 0) revert ZeroStake();
        if (white == black || white == feeRecipient || black == feeRecipient) revert BadPlayers();
        if (games[gameId].exists) revert GameExists();
        if (available(white) < stake || available(black) < stake) revert InsufficientUnlocked();

        locked[white] += stake;
        locked[black] += stake;
        games[gameId] = Game({
            white: white,
            black: black,
            stake: stake,
            feeBps: feeBps,
            openedAt: uint64(block.timestamp),
            settled: false,
            exists: true
        });

        emit GameOpened(gameId, white, black, stake);
    }

    /// Settle a game with a time-bounded EIP-712 result signed by the oracle.
    /// Anyone may relay. `winner == address(0)` settles a draw.
    function settleGame(
        bytes32 gameId,
        address winner,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Game storage g = games[gameId];
        if (!g.exists) revert UnknownGame();
        if (g.settled) revert AlreadySettled();
        if (block.timestamp > deadline) revert Expired();
        if (winner != address(0) && winner != g.white && winner != g.black) revert BadWinner();

        bytes32 digest = digestGameResult(gameId, winner, deadline);
        if (_recover(digest, v, r, s) != oracle) revert BadSignature();

        g.settled = true;
        uint256 stake = g.stake;
        locked[g.white] -= stake;
        locked[g.black] -= stake;

        uint256 rake = 0;
        if (winner != address(0)) {
            address loser = winner == g.white ? g.black : g.white;
            rake = (stake * g.feeBps) / 10_000;
            bankroll[loser] -= stake;
            bankroll[winner] += stake - rake;
            bankroll[feeRecipient] += rake;
        }
        emit GameSettled(gameId, winner, stake, rake);
    }

    /// Refund both stakes if a game is never settled within `settleTimeout`.
    function claimTimeout(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (!g.exists) revert UnknownGame();
        if (g.settled) revert AlreadySettled();
        if (block.timestamp <= g.openedAt + settleTimeout) revert TimeoutNotReached();

        g.settled = true;
        locked[g.white] -= g.stake;
        locked[g.black] -= g.stake;
        emit GameRefunded(gameId);
    }

    // --- admin ------------------------------------------------------------

    function setOracle(address oracle_) external onlyOwner {
        require(oracle_ != address(0), "zero addr");
        oracle = oracle_;
        emit OracleUpdated(oracle_);
    }

    function setFee(address feeRecipient_, uint16 feeBps_) external onlyOwner {
        require(feeRecipient_ != address(0), "zero addr");
        require(feeBps_ <= 1_000, "fee too high"); // hard cap 10%
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// Ownable2Step: start a transfer; the new owner must `acceptOwnership`.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // --- EIP-712 helpers --------------------------------------------------

    /// The EIP-712 digest the oracle signs for a game result. Exposed so the
    /// off-chain oracle and tests sign exactly what the contract verifies.
    function digestGameResult(bytes32 gameId, address winner, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(RESULT_TYPEHASH, gameId, winner, deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _domainSeparator() internal view returns (bytes32) {
        if (block.chainid == _CACHED_CHAIN_ID) return _CACHED_DOMAIN_SEPARATOR;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ChessEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        // Reject malleable (upper-half) s values.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    // --- SafeERC20-lite ---------------------------------------------------
    // Handles tokens that return no boolean (USDT-style) as well as USDC.

    function _safeTransfer(address to, uint256 amount) private {
        _callOptionalReturn(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        _callOptionalReturn(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
    }

    function _callOptionalReturn(bytes memory data) private {
        (bool ok, bytes memory ret) = address(token).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
