// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChessEscrow, IERC20} from "../src/ChessEscrow.sol";

/// Minimal Foundry cheatcode interface (avoids depending on forge-std so the
/// project compiles fully offline).
interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
}

/// Mock USDC with a 6-decimal feel; just enough ERC-20 for the escrow.
contract MockUSDC is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ChessEscrowTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    MockUSDC usdc;
    ChessEscrow escrow;

    uint256 oracleKey = 0xA11CE;
    address oracle;
    address fee = address(0xFEE);
    address white = address(0x1111);
    address black = address(0x2222);

    uint256 constant STAKE = 1_000_000; // 1 USDC (6 decimals)
    uint256 constant DEADLINE = 1 << 250; // effectively never expires in tests

    function setUp() public {
        oracle = vm.addr(oracleKey);
        usdc = new MockUSDC();
        // 1% rake, 1 hour timeout
        escrow = new ChessEscrow(address(usdc), oracle, fee, 100, 3600);

        _fund(white, 10 * STAKE);
        _fund(black, 10 * STAKE);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(escrow), amount);
        vm.prank(who);
        escrow.deposit(amount);
    }

    function _open(bytes32 gameId) internal {
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);
    }

    function _settle(bytes32 gameId, address winner, uint256 deadline) internal {
        bytes32 digest = escrow.digestGameResult(gameId, winner, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleGame(gameId, winner, deadline, v, r, s);
    }

    function _assert(bool cond, string memory what) internal pure {
        require(cond, what);
    }

    function test_deposit_credits_bankroll() public view {
        _assert(escrow.bankroll(white) == 10 * STAKE, "white bankroll");
        _assert(escrow.available(white) == 10 * STAKE, "white available");
    }

    function test_open_locks_stake_and_caps_withdrawal() public {
        _open(keccak256("g1"));
        _assert(escrow.locked(white) == STAKE, "white locked");
        _assert(escrow.available(white) == 10 * STAKE - STAKE, "white available after lock");
        vm.prank(white);
        vm.expectRevert();
        escrow.withdraw(10 * STAKE);
    }

    function test_settle_pays_winner_minus_rake() public {
        bytes32 g = keccak256("g2");
        _open(g);
        _settle(g, white, DEADLINE);

        uint256 rake = (STAKE * 100) / 10_000; // 1%
        _assert(escrow.bankroll(white) == 10 * STAKE + STAKE - rake, "winner bankroll");
        _assert(escrow.bankroll(black) == 10 * STAKE - STAKE, "loser bankroll");
        _assert(escrow.bankroll(fee) == rake, "fee accrued");
        _assert(escrow.locked(white) == 0 && escrow.locked(black) == 0, "unlocked");
        _assert(
            escrow.bankroll(white) + escrow.bankroll(black) + escrow.bankroll(fee) == 20 * STAKE,
            "conservation"
        );
    }

    function test_draw_refunds_both() public {
        bytes32 g = keccak256("g3");
        _open(g);
        _settle(g, address(0), DEADLINE);
        _assert(escrow.bankroll(white) == 10 * STAKE, "white unchanged");
        _assert(escrow.bankroll(black) == 10 * STAKE, "black unchanged");
        _assert(escrow.locked(white) == 0, "white unlocked");
    }

    function test_forged_signature_rejected() public {
        bytes32 g = keccak256("g4");
        _open(g);
        bytes32 digest = escrow.digestGameResult(g, white, DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, digest);
        vm.expectRevert();
        escrow.settleGame(g, white, DEADLINE, v, r, s);
    }

    function test_double_settle_rejected() public {
        bytes32 g = keccak256("g5");
        _open(g);
        _settle(g, white, DEADLINE);
        bytes32 digest = escrow.digestGameResult(g, white, DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        vm.expectRevert();
        escrow.settleGame(g, white, DEADLINE, v, r, s);
    }

    function test_timeout_refunds() public {
        bytes32 g = keccak256("g6");
        _open(g);
        vm.warp(block.timestamp + 3601);
        escrow.claimTimeout(g);
        _assert(escrow.locked(white) == 0 && escrow.locked(black) == 0, "refunded");
        _assert(escrow.bankroll(white) == 10 * STAKE, "white whole");
    }

    function test_open_requires_unlocked_balance() public {
        vm.prank(oracle);
        vm.expectRevert();
        escrow.openGame(keccak256("g7"), white, black, 100 * STAKE);
    }

    // --- new hardening tests ---------------------------------------------

    function test_white_equals_black_rejected() public {
        vm.prank(oracle);
        vm.expectRevert();
        escrow.openGame(keccak256("g8"), white, white, STAKE);
    }

    function test_fee_recipient_cannot_play() public {
        _fund(fee, 10 * STAKE);
        vm.prank(oracle);
        vm.expectRevert();
        escrow.openGame(keccak256("g9"), fee, black, STAKE);
    }

    function test_zero_stake_rejected() public {
        vm.prank(oracle);
        vm.expectRevert();
        escrow.openGame(keccak256("g10"), white, black, 0);
    }

    function test_expired_signature_rejected() public {
        bytes32 g = keccak256("g11");
        _open(g);
        // deadline in the past
        bytes32 digest = escrow.digestGameResult(g, white, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        vm.warp(1000);
        vm.expectRevert();
        escrow.settleGame(g, white, 1, v, r, s);
    }

    function test_pause_blocks_deposit_and_open() public {
        // owner is this test contract (deployer)
        escrow.setPaused(true);
        usdc.mint(white, STAKE);
        vm.prank(white);
        usdc.approve(address(escrow), STAKE);
        vm.prank(white);
        vm.expectRevert();
        escrow.deposit(STAKE);

        vm.prank(oracle);
        vm.expectRevert();
        escrow.openGame(keccak256("g12"), white, black, STAKE);
    }

    function test_ownership_two_step() public {
        address newOwner = address(0xABCD);
        escrow.transferOwnership(newOwner);
        // not transferred until accepted
        _assert(escrow.owner() == address(this), "still old owner");
        vm.prank(newOwner);
        escrow.acceptOwnership();
        _assert(escrow.owner() == newOwner, "new owner");
    }

    // --- tournaments ------------------------------------------------------

    address carol = address(0x3333);

    function _enterAll(bytes32 tid) internal {
        _fund(carol, 10 * STAKE);
        vm.prank(oracle);
        escrow.openTournament(tid, STAKE);
        vm.prank(oracle);
        escrow.enterTournament(tid, white);
        vm.prank(oracle);
        escrow.enterTournament(tid, black);
        vm.prank(oracle);
        escrow.enterTournament(tid, carol);
    }

    function _players3() internal view returns (address[] memory p) {
        p = new address[](3);
        p[0] = white;
        p[1] = black;
        p[2] = carol;
    }

    function _settleT(bytes32 tid, address[] memory players, uint256[] memory payouts, uint256 deadline)
        internal
    {
        bytes32 d = escrow.digestTournamentResult(tid, players, payouts, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, d);
        escrow.settleTournament(tid, players, payouts, deadline, v, r, s);
    }

    function test_tournament_distributes_pool() public {
        bytes32 tid = keccak256("t1");
        _enterAll(tid);
        // buy-in moved out of each entrant's bankroll into the pool at entry
        _assert(escrow.bankroll(white) == 9 * STAKE && escrow.bankroll(carol) == 9 * STAKE, "post-entry");
        (, uint256 pool,,,,,,) = escrow.tournaments(tid);
        _assert(pool == 3 * STAKE, "pool");

        // pool = 3 STAKE; pay white 2, black 1, carol 0 (no rake)
        uint256[] memory payouts = new uint256[](3);
        payouts[0] = 2 * STAKE;
        payouts[1] = STAKE;
        payouts[2] = 0;
        _settleT(tid, _players3(), payouts, DEADLINE);

        _assert(escrow.bankroll(white) == 11 * STAKE, "white +1 net");
        _assert(escrow.bankroll(black) == 10 * STAKE, "black even");
        _assert(escrow.bankroll(carol) == 9 * STAKE, "carol -1");
        _assert(escrow.locked(white) == 0 && escrow.locked(carol) == 0, "unlocked");
        _assert(
            escrow.bankroll(white) + escrow.bankroll(black) + escrow.bankroll(carol)
                + escrow.bankroll(fee) == 30 * STAKE,
            "conservation"
        );
    }

    function test_tournament_rake_is_remainder() public {
        bytes32 tid = keccak256("t2");
        _enterAll(tid);
        // pay only the winner 2 STAKE; remaining 1 STAKE is rake
        uint256[] memory payouts = new uint256[](3);
        payouts[0] = 2 * STAKE;
        _settleT(tid, _players3(), payouts, DEADLINE);
        _assert(escrow.bankroll(fee) == STAKE, "rake to fee");
        _assert(
            escrow.bankroll(white) + escrow.bankroll(black) + escrow.bankroll(carol)
                + escrow.bankroll(fee) == 30 * STAKE,
            "conservation"
        );
    }

    function test_tournament_overpay_rejected() public {
        bytes32 tid = keccak256("t3");
        _enterAll(tid);
        uint256[] memory payouts = new uint256[](3);
        payouts[0] = 4 * STAKE; // exceeds the 3 STAKE pool
        bytes32 d = escrow.digestTournamentResult(tid, _players3(), payouts, DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, d);
        vm.expectRevert();
        escrow.settleTournament(tid, _players3(), payouts, DEADLINE, v, r, s);
    }

    function test_tournament_timeout_refunds() public {
        bytes32 tid = keccak256("t4");
        _enterAll(tid);
        vm.warp(block.timestamp + 3601);
        // each entrant permissionlessly reclaims their buy-in
        escrow.claimRefund(tid, white);
        escrow.claimRefund(tid, black);
        escrow.claimRefund(tid, carol);
        _assert(escrow.bankroll(white) == 10 * STAKE, "white whole");
        _assert(escrow.bankroll(carol) == 10 * STAKE, "carol whole");
        // double refund rejected
        vm.expectRevert();
        escrow.claimRefund(tid, white);
    }

    function test_tournament_double_entry_rejected() public {
        bytes32 tid = keccak256("t5");
        _fund(carol, 10 * STAKE);
        vm.prank(oracle);
        escrow.openTournament(tid, STAKE);
        vm.prank(oracle);
        escrow.enterTournament(tid, white);
        vm.prank(oracle);
        vm.expectRevert();
        escrow.enterTournament(tid, white);
    }

    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, amt))));
    }

    function test_tournament_merkle_claim() public {
        bytes32 tid = keccak256("t6");
        _enterAll(tid); // pool = 3 STAKE

        // Tree of 2 leaves: white gets 2 STAKE, black gets 1 STAKE (sum = pool).
        bytes32 lw = _leaf(white, 2 * STAKE);
        bytes32 lb = _leaf(black, STAKE);
        bytes32 root = lw <= lb
            ? keccak256(abi.encodePacked(lw, lb))
            : keccak256(abi.encodePacked(lb, lw));

        uint256 deadline = block.timestamp + 100;
        uint256 total = 3 * STAKE; // leaves sum to the full pool (0 rake)
        bytes32 digest = escrow.digestTournamentRoot(tid, root, total, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleTournamentRoot(tid, root, total, deadline, v, r, s);

        bytes32[] memory proofW = new bytes32[](1);
        proofW[0] = lb;
        bytes32[] memory proofB = new bytes32[](1);
        proofB[0] = lw;

        escrow.claimTournament(tid, white, 2 * STAKE, proofW); // anyone can relay
        escrow.claimTournament(tid, black, STAKE, proofB);

        _assert(escrow.bankroll(white) == 11 * STAKE, "white claimed");
        _assert(escrow.bankroll(black) == 10 * STAKE, "black claimed");
        _assert(escrow.bankroll(carol) == 9 * STAKE, "carol unpaid (lost buy-in)");

        // double claim rejected
        vm.expectRevert();
        escrow.claimTournament(tid, white, 2 * STAKE, proofW);

        // forged amount / bad proof rejected
        vm.expectRevert();
        escrow.claimTournament(tid, carol, STAKE, proofW);

        // refund blocked once root-settled
        vm.expectRevert();
        escrow.claimRefund(tid, carol);
    }

    function test_tournament_root_rake_taken_at_settle() public {
        bytes32 tid = keccak256("t7");
        _enterAll(tid); // pool = 3 STAKE
        // Commit a tree that pays out only 2 STAKE; the other 1 STAKE is rake
        // and must go to the fee recipient at settle (never stranded).
        bytes32 lw = _leaf(white, 2 * STAKE);
        uint256 total = 2 * STAKE;
        uint256 deadline = block.timestamp + 100;
        bytes32 digest = escrow.digestTournamentRoot(tid, lw, total, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleTournamentRoot(tid, lw, total, deadline, v, r, s);

        _assert(escrow.bankroll(fee) == STAKE, "rake taken at settle");

        bytes32[] memory empty = new bytes32[](0);
        escrow.claimTournament(tid, white, 2 * STAKE, empty); // single-leaf root
        _assert(escrow.bankroll(white) == 11 * STAKE, "white claimed");
        // pool fully accounted: 2 claimed + 1 rake = 3
        _assert(
            escrow.bankroll(white) + escrow.bankroll(black) + escrow.bankroll(carol)
                + escrow.bankroll(fee) == 30 * STAKE,
            "conservation"
        );
    }

    function test_claim_on_direct_settle_rejected() public {
        bytes32 tid = keccak256("t8");
        _enterAll(tid);
        uint256[] memory payouts = new uint256[](3);
        payouts[0] = 3 * STAKE;
        _settleT(tid, _players3(), payouts, DEADLINE);
        // no root in direct mode -> claim reverts NoRoot
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert();
        escrow.claimTournament(tid, white, 3 * STAKE, empty);
    }
}
