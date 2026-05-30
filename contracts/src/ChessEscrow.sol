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
///    capped at `bankroll - locked`, so a user can never withdraw staked funds
///    or over-wager. This is what makes sub-dollar / gauntlet games viable:
///    deposit once, lock+settle many games with no per-game token transfer.
///  - A game is settled by submitting an **EIP-712 signed result** from the
///    platform oracle key. Anyone may relay the signature. The oracle can only
///    move a locked stake between the two committed players (minus rake); it
///    can never mint balance, pay outsiders, or touch un-locked funds.
///  - `claimTimeout` refunds both stakes if a game is never settled, protecting
///    against griefing / oracle silence.
contract ChessEscrow {
    // --- storage ----------------------------------------------------------

    IERC20 public immutable token;
    address public oracle;        // platform result-signing key
    address public owner;         // can rotate oracle / fee params
    address public feeRecipient;  // accrues rake as a normal bankroll balance
    uint16 public feeBps;         // rake in basis points (e.g. 100 = 1%)
    uint64 public settleTimeout;  // seconds after open before timeout refund

    mapping(address => uint256) public bankroll; // total deposited per user
    mapping(address => uint256) public locked;   // exposure locked in open games

    struct Game {
        address white;
        address black;
        uint256 stake;   // per-player stake
        uint64 openedAt; // block timestamp at open
        bool settled;
    }

    mapping(bytes32 => Game) public games;

    // EIP-712
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant RESULT_TYPEHASH =
        keccak256("GameResult(bytes32 gameId,address winner)");

    uint256 private _reentrancyGuard = 1;

    // --- events -----------------------------------------------------------

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event GameOpened(bytes32 indexed gameId, address indexed white, address indexed black, uint256 stake);
    event GameSettled(bytes32 indexed gameId, address winner, uint256 stake, uint256 rake);
    event GameRefunded(bytes32 indexed gameId);
    event OracleUpdated(address oracle);

    // --- errors -----------------------------------------------------------

    error NotOwner();
    error NotOracle();
    error Reentrancy();
    error InsufficientUnlocked();
    error GameExists();
    error UnknownGame();
    error AlreadySettled();
    error BadWinner();
    error BadSignature();
    error TimeoutNotReached();
    error TransferFailed();

    // --- modifiers --------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
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
        token = IERC20(token_);
        oracle = oracle_;
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        settleTimeout = settleTimeout_;

        DOMAIN_SEPARATOR = keccak256(
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

    // --- bankroll ---------------------------------------------------------

    /// Deposit USDC into your bankroll. Requires prior ERC-20 approval.
    function deposit(uint256 amount) external nonReentrant {
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        bankroll[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// Withdraw up to your *unlocked* balance.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount > available(msg.sender)) revert InsufficientUnlocked();
        bankroll[msg.sender] -= amount;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// Bankroll not currently locked in open games.
    function available(address user) public view returns (uint256) {
        return bankroll[user] - locked[user];
    }

    // --- game lifecycle ---------------------------------------------------

    /// Open a game, locking `stake` from each player. Called by the platform
    /// (oracle) when two players have committed. Both must have enough unlocked
    /// bankroll.
    function openGame(bytes32 gameId, address white, address black, uint256 stake) external {
        if (msg.sender != oracle) revert NotOracle();
        if (games[gameId].stake != 0 || games[gameId].settled) revert GameExists();
        if (available(white) < stake || available(black) < stake) revert InsufficientUnlocked();

        locked[white] += stake;
        locked[black] += stake;
        games[gameId] =
            Game({white: white, black: black, stake: stake, openedAt: uint64(block.timestamp), settled: false});

        emit GameOpened(gameId, white, black, stake);
    }

    /// Settle a game with an EIP-712 result signed by the oracle. Anyone may
    /// relay the signature. `winner == address(0)` settles a draw.
    function settleGame(bytes32 gameId, address winner, uint8 v, bytes32 r, bytes32 s)
        external
    {
        Game storage g = games[gameId];
        if (g.stake == 0) revert UnknownGame();
        if (g.settled) revert AlreadySettled();
        if (winner != address(0) && winner != g.white && winner != g.black) revert BadWinner();

        bytes32 digest = digestGameResult(gameId, winner);
        if (_recover(digest, v, r, s) != oracle) revert BadSignature();

        g.settled = true;
        uint256 stake = g.stake;
        locked[g.white] -= stake;
        locked[g.black] -= stake;

        uint256 rake = 0;
        if (winner != address(0)) {
            address loser = winner == g.white ? g.black : g.white;
            rake = (stake * feeBps) / 10_000;
            bankroll[loser] -= stake;
            bankroll[winner] += stake - rake;
            bankroll[feeRecipient] += rake;
        }
        emit GameSettled(gameId, winner, stake, rake);
    }

    /// Refund both stakes if a game is never settled within `settleTimeout`.
    /// Callable by anyone (griefing / oracle-silence protection).
    function claimTimeout(bytes32 gameId) external {
        Game storage g = games[gameId];
        if (g.stake == 0) revert UnknownGame();
        if (g.settled) revert AlreadySettled();
        if (block.timestamp <= g.openedAt + settleTimeout) revert TimeoutNotReached();

        g.settled = true;
        locked[g.white] -= g.stake;
        locked[g.black] -= g.stake;
        emit GameRefunded(gameId);
    }

    // --- admin ------------------------------------------------------------

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleUpdated(oracle_);
    }

    function setFee(address feeRecipient_, uint16 feeBps_) external onlyOwner {
        require(feeBps_ <= 1_000, "fee too high"); // hard cap 10%
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    // --- EIP-712 helpers --------------------------------------------------

    /// The EIP-712 digest the oracle signs for a game result. Exposed so the
    /// off-chain oracle and tests sign exactly what the contract verifies.
    function digestGameResult(bytes32 gameId, address winner) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(RESULT_TYPEHASH, gameId, winner));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
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
}
