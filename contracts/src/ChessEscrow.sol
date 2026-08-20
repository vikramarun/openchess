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
///    snapshotted at open), so it can never mint balance or pay outsiders.
///  - `claimTimeout` refunds both stakes if a game is never settled.
///  - A tournament pool is funded by entries, by **sponsors**, or by both. Every
///    path in also has a path out if the pool is never settled: entrants use
///    `claimRefund`, sponsors `refundSponsorship`.
///
/// Solvency: the contract's token balance always equals the sum of all bankrolls
/// plus, for every tournament, `pool - claimedAmount` — the part of a pool it
/// still holds that is not yet in anyone's bankroll. Fuzzed in
/// `test/Invariant.t.sol`.
contract ChessEscrow {
    // --- storage ----------------------------------------------------------

    IERC20 public immutable token;
    address public oracle;        // platform result-signing key
    address public owner;         // can rotate oracle / fee params / pause
    address public pendingOwner;  // Ownable2Step
    address public feeRecipient;  // accrues rake as a normal bankroll balance
    uint16 public feeBps;         // rake in basis points (e.g. 100 = 1%)
    // Set once at construction. Do NOT add a setter: it is used live as
    // `openedAt + settleTimeout` in the settle/refund windows, so changing it
    // would retroactively move those boundaries for in-flight games/tournaments.
    // If it ever must change, snapshot it per-game like `feeBps`.
    uint64 public settleTimeout;
    // How long after `openTournament` new entries are still accepted. Set once
    // at construction alongside `settleTimeout`, and for the same reason:
    // `openedAt + entryWindow` is read live, so a setter would retroactively
    // move the boundary for tournaments already open.
    //
    // Why it exists at all: the settle clock starts at `openTournament`, and
    // both settlement paths revert permanently once it lapses, but entry used
    // to have no deadline of its own. A field could therefore still be filling
    // as the window closed, and an event that is legal to enter but impossible
    // to settle is one that pays nobody — every entrant falls through to
    // `claimRefund` and the standings are thrown away. Closing entry first
    // leaves `settleTimeout - entryWindow` for the games to actually be played.
    uint64 public entryWindow;
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

    // Tournaments: a uniform buy-in is moved from each entrant's bankroll into
    // the pool at entry (so losers never need touching at settle). Settlement is
    // either a direct signed payout list (small fields) or a signed Merkle root
    // that winners claim individually (scales to any field size). If the oracle
    // never settles, each entrant can permissionlessly reclaim their buy-in
    // after the timeout.
    //
    // The buy-in MAY be zero: a pool can instead (or additionally) be funded by
    // sponsors, who move their own unlocked bankroll in via `sponsorTournament`.
    // That is what makes free-entry prize events possible. Sponsorship is
    // irrevocable before the timeout on purpose — a sponsor able to withdraw at
    // will could rug a field that paid to enter a pool advertised at a size.
    struct Tournament {
        uint256 buyIn;
        uint256 pool;
        uint256 claimedAmount; // sum credited via root-claims so far
        uint32 entrants;
        uint64 openedAt;
        bool settled;
        bytes32 payoutRoot; // non-zero only in root/claim mode
        bool exists;
    }

    mapping(bytes32 => Tournament) public tournaments;
    mapping(bytes32 => mapping(address => bool)) public tournamentEntered;
    mapping(bytes32 => mapping(address => bool)) public tournamentClaimed;
    /// Per-sponsor contribution, so an unsettled pool can be handed back. Without
    /// this the sponsor's money would be stranded forever whenever a tournament
    /// is abandoned — `claimRefund` only ever returns `buyIn`, to entrants.
    mapping(bytes32 => mapping(address => uint256)) public sponsorship;

    // EIP-712 (domain separator recomputed if the chain id changes, e.g. a fork)
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 public constant RESULT_TYPEHASH =
        keccak256("GameResult(bytes32 gameId,address winner,uint256 deadline)");
    bytes32 public constant TOURNAMENT_TYPEHASH = keccak256(
        "TournamentResult(bytes32 tournamentId,bytes32 winnersHash,bytes32 payoutsHash,uint256 deadline)"
    );
    bytes32 public constant TOURNAMENT_ROOT_TYPEHASH = keccak256(
        "TournamentRoot(bytes32 tournamentId,bytes32 payoutRoot,uint256 totalPayout,uint256 deadline)"
    );

    uint256 private _reentrancyGuard = 1;

    // --- events -----------------------------------------------------------

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event GameOpened(bytes32 indexed gameId, address indexed white, address indexed black, uint256 stake);
    event GameSettled(bytes32 indexed gameId, address winner, uint256 stake, uint256 rake);
    event GameRefunded(bytes32 indexed gameId);
    event TournamentOpened(bytes32 indexed tournamentId, uint256 buyIn);
    event TournamentEntered(bytes32 indexed tournamentId, address indexed player);
    event TournamentSponsored(bytes32 indexed tournamentId, address indexed sponsor, uint256 amount);
    event TournamentSponsorRefunded(
        bytes32 indexed tournamentId, address indexed sponsor, uint256 amount
    );
    event TournamentSettled(bytes32 indexed tournamentId, uint256 pool, uint256 rake);
    event TournamentRootSet(bytes32 indexed tournamentId, bytes32 payoutRoot);
    event TournamentClaimed(bytes32 indexed tournamentId, address indexed account, uint256 amount);
    event TournamentRefunded(bytes32 indexed tournamentId, address indexed account);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event FeeUpdated(address indexed feeRecipient, uint16 feeBps);
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
    error TournamentExists();
    error UnknownTournament();
    error BadDistribution();
    error AlreadyEntered();
    error NotEntered();
    error AlreadyClaimed();
    error NoRoot();
    error InvalidProof();
    error SettleWindowClosed();
    error EntryWindowClosed();
    error NotSponsor();

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
        uint64 settleTimeout_,
        uint64 entryWindow_
    ) {
        require(token_ != address(0) && oracle_ != address(0) && feeRecipient_ != address(0), "zero addr");
        require(feeBps_ <= 1_000, "fee too high");
        // An entry window at or past the settle window is no window at all —
        // it would re-admit the very state this exists to prevent (a field
        // still filling when settlement is already impossible).
        require(entryWindow_ < settleTimeout_, "entry window must close first");
        token = IERC20(token_);
        oracle = oracle_;
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        settleTimeout = settleTimeout_;
        entryWindow = entryWindow_;

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

    // --- tournaments ------------------------------------------------------

    /// Open a tournament with a uniform buy-in. Oracle-only.
    ///
    /// `buyIn` MAY be zero: a free-entry event whose prize pool is funded by
    /// `sponsorTournament` instead. Nothing downstream divides by it, and an
    /// entry of zero simply records the entrant without moving money.
    function openTournament(bytes32 tid, uint256 buyIn) external whenNotPaused {
        if (msg.sender != oracle) revert NotOracle();
        if (tournaments[tid].exists) revert TournamentExists();
        tournaments[tid] = Tournament({
            buyIn: buyIn,
            pool: 0,
            claimedAmount: 0,
            entrants: 0,
            openedAt: uint64(block.timestamp),
            settled: false,
            payoutRoot: bytes32(0),
            exists: true
        });
        emit TournamentOpened(tid, buyIn);
    }

    /// Enter a player, moving their buy-in from bankroll into the pool. Funds
    /// leave the entrant's bankroll now, so losers never need touching at
    /// settle (which is what lets settlement/claims be O(1) per winner).
    /// Oracle-only; one entry per address.
    ///
    /// Refused once `entryWindow` has elapsed. Without that an entrant could
    /// join a tournament that had already run out of time to be settled: both
    /// settle paths revert past `openedAt + settleTimeout`, so the event could
    /// only ever resolve into `claimRefund` and its standings would be
    /// discarded. Note this is the entry window, not the settle window — the
    /// gap between them is the time the games themselves get.
    function enterTournament(bytes32 tid, address player) external whenNotPaused {
        if (msg.sender != oracle) revert NotOracle();
        Tournament storage t = tournaments[tid];
        if (!t.exists) revert UnknownTournament();
        if (t.settled) revert AlreadySettled();
        if (block.timestamp > t.openedAt + entryWindow) revert EntryWindowClosed();
        if (player == feeRecipient) revert BadPlayers();
        if (tournamentEntered[tid][player]) revert AlreadyEntered();
        if (available(player) < t.buyIn) revert InsufficientUnlocked();

        bankroll[player] -= t.buyIn; // moved into the pool
        t.pool += t.buyIn;
        t.entrants += 1;
        tournamentEntered[tid][player] = true;
        emit TournamentEntered(tid, player);
    }

    /// Fund a tournament's prize pool from your own unlocked bankroll.
    ///
    /// **Permissionless, and deliberately not oracle-gated.** It moves only the
    /// caller's own money into a named pool, which is the same trust model as
    /// `deposit` — gating it would buy nothing and cost an oracle round trip and
    /// its gas. Anyone may sponsor, any number of times, and several sponsors
    /// may fund one pool.
    ///
    /// Refused once the settle window has closed: funding a pool that can no
    /// longer be settled would only park the money until `refundSponsorship`.
    ///
    /// No `nonReentrant`, deliberately: this moves bankroll into a pool with no
    /// external call, exactly like `enterTournament` and `claimRefund`. The
    /// guard belongs on the functions that touch the token (`deposit`,
    /// `withdraw`); putting it here would cost gas and imply a reentrancy
    /// surface that isn't there.
    function sponsorTournament(bytes32 tid, uint256 amount) external whenNotPaused {
        Tournament storage t = tournaments[tid];
        if (!t.exists) revert UnknownTournament();
        if (t.settled) revert AlreadySettled();
        if (amount == 0) revert ZeroStake();
        if (block.timestamp > t.openedAt + settleTimeout) revert SettleWindowClosed();
        if (available(msg.sender) < amount) revert InsufficientUnlocked();

        bankroll[msg.sender] -= amount; // moved into the pool, exactly like an entry
        t.pool += amount;
        sponsorship[tid][msg.sender] += amount;
        emit TournamentSponsored(tid, msg.sender, amount);
    }

    /// Return a sponsor's contribution from a tournament that was never settled.
    /// Permissionless (credits `sponsor`), O(1), and available only after the
    /// timeout — the same safety net `claimRefund` gives entrants.
    ///
    /// Without this a sponsored pool is stranded permanently whenever a
    /// tournament is abandoned, because `claimRefund` returns `buyIn` and only
    /// to entrants. Abandonment is not hypothetical: the server abandons any
    /// tournament that was mid-flight when it restarted.
    function refundSponsorship(bytes32 tid, address sponsor) external {
        Tournament storage t = tournaments[tid];
        if (!t.exists) revert UnknownTournament();
        if (t.settled) revert AlreadySettled();
        if (block.timestamp <= t.openedAt + settleTimeout) revert TimeoutNotReached();
        uint256 amount = sponsorship[tid][sponsor];
        if (amount == 0) revert NotSponsor();

        sponsorship[tid][sponsor] = 0;
        t.pool -= amount;
        bankroll[sponsor] += amount;
        emit TournamentSponsorRefunded(tid, sponsor, amount);
    }

    /// Settle a small field directly: credit each winner. Losers are not listed
    /// (their buy-in already left their bankroll at entry). The remainder
    /// (pool - sum(payouts)) is the rake. Must be within the settle window.
    function settleTournament(
        bytes32 tid,
        address[] calldata winners,
        uint256[] calldata payouts,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Tournament storage t = tournaments[tid];
        if (!t.exists) revert UnknownTournament();
        if (t.settled) revert AlreadySettled();
        if (block.timestamp > deadline) revert Expired();
        if (block.timestamp > t.openedAt + settleTimeout) revert SettleWindowClosed();
        if (winners.length != payouts.length) revert BadDistribution();

        bytes32 digest = digestTournamentResult(tid, winners, payouts, deadline);
        if (_recover(digest, v, r, s) != oracle) revert BadSignature();

        t.settled = true;
        uint256 sumPay = 0;
        for (uint256 i = 0; i < winners.length; i++) {
            bankroll[winners[i]] += payouts[i];
            sumPay += payouts[i];
        }
        if (sumPay > t.pool) revert BadDistribution();
        uint256 rake = t.pool - sumPay;
        if (rake > 0) {
            bankroll[feeRecipient] += rake;
        }
        t.claimedAmount = t.pool;
        emit TournamentSettled(tid, t.pool, rake);
    }

    /// Settle a large field by committing a signed Merkle root of (account,
    /// amount) leaves. `totalPayout` is the sum of all leaf amounts and is part
    /// of the signed data; the rake (pool - totalPayout) is taken immediately,
    /// and claims are bounded by `totalPayout`, so no pool remainder can ever be
    /// stranded (unclaimable). Winners then `claimTournament` individually.
    function settleTournamentRoot(
        bytes32 tid,
        bytes32 payoutRoot,
        uint256 totalPayout,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Tournament storage t = tournaments[tid];
        if (!t.exists) revert UnknownTournament();
        if (t.settled) revert AlreadySettled();
        if (block.timestamp > deadline) revert Expired();
        if (block.timestamp > t.openedAt + settleTimeout) revert SettleWindowClosed();
        if (totalPayout > t.pool) revert BadDistribution();

        bytes32 digest = digestTournamentRoot(tid, payoutRoot, totalPayout, deadline);
        if (_recover(digest, v, r, s) != oracle) revert BadSignature();

        t.settled = true;
        t.payoutRoot = payoutRoot;
        uint256 rake = t.pool - totalPayout;
        t.pool = totalPayout; // claims are now bounded by the committed total
        if (rake > 0) {
            bankroll[feeRecipient] += rake;
        }
        emit TournamentRootSet(tid, payoutRoot);
    }

    /// Claim a payout from a root-settled tournament. Permissionless (credits
    /// `account`). `amount` + proof must be in the committed tree. O(1).
    function claimTournament(
        bytes32 tid,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        Tournament storage t = tournaments[tid];
        if (t.payoutRoot == bytes32(0)) revert NoRoot();
        if (tournamentClaimed[tid][account]) revert AlreadyClaimed();

        // OZ-style double-hashed leaf prevents second-preimage attacks.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!_verifyProof(proof, t.payoutRoot, leaf)) revert InvalidProof();
        if (t.claimedAmount + amount > t.pool) revert BadDistribution();

        tournamentClaimed[tid][account] = true;
        t.claimedAmount += amount;
        bankroll[account] += amount;
        emit TournamentClaimed(tid, account, amount);
    }

    /// If a tournament is never settled within the timeout, each entrant can
    /// permissionlessly reclaim their entry. O(1) per entrant, with no oracle and
    /// no entrant-list needed (non-custodial safety net at any field size).
    ///
    /// A free-entry tournament has nothing to give back here — its money came
    /// from sponsors, who use `refundSponsorship`. Refusing outright beats
    /// burning the caller's `tournamentClaimed` flag on a zero transfer.
    function claimRefund(bytes32 tid, address account) external {
        Tournament storage t = tournaments[tid];
        if (!t.exists) revert UnknownTournament();
        if (t.settled) revert AlreadySettled();
        if (t.buyIn == 0) revert ZeroStake();
        if (block.timestamp <= t.openedAt + settleTimeout) revert TimeoutNotReached();
        if (!tournamentEntered[tid][account]) revert NotEntered();
        if (tournamentClaimed[tid][account]) revert AlreadyClaimed();

        tournamentClaimed[tid][account] = true;
        t.pool -= t.buyIn;
        bankroll[account] += t.buyIn;
        emit TournamentRefunded(tid, account);
    }

    // --- admin ------------------------------------------------------------

    function setOracle(address oracle_) external onlyOwner {
        require(oracle_ != address(0), "zero addr");
        emit OracleUpdated(oracle, oracle_);
        oracle = oracle_;
    }

    function setFee(address feeRecipient_, uint16 feeBps_) external onlyOwner {
        require(feeRecipient_ != address(0), "zero addr");
        require(feeBps_ <= 1_000, "fee too high"); // hard cap 10%
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        emit FeeUpdated(feeRecipient_, feeBps_);
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

    /// EIP-712 digest the oracle signs for a tournament distribution.
    function digestTournamentResult(
        bytes32 tid,
        address[] calldata players,
        uint256[] calldata payouts,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TOURNAMENT_TYPEHASH,
                tid,
                keccak256(abi.encodePacked(players)),
                keccak256(abi.encodePacked(payouts)),
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// EIP-712 digest for a Merkle-root tournament settlement.
    function digestTournamentRoot(
        bytes32 tid,
        bytes32 payoutRoot,
        uint256 totalPayout,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TOURNAMENT_ROOT_TYPEHASH, tid, payoutRoot, totalPayout, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// Standard sorted-pair Merkle proof verification (OpenZeppelin-compatible).
    function _verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf)
        internal
        pure
        returns (bool)
    {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            computed =
                computed <= p ? keccak256(abi.encodePacked(computed, p)) : keccak256(abi.encodePacked(p, computed));
        }
        return computed == root;
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
