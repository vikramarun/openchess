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

    function setUp() public {
        oracle = vm.addr(oracleKey);
        usdc = new MockUSDC();
        // 1% rake, 1 hour timeout
        escrow = new ChessEscrow(address(usdc), oracle, fee, 100, 3600);

        // fund and deposit for both players
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

    function _assert(bool cond, string memory what) internal pure {
        require(cond, what);
    }

    function test_deposit_credits_bankroll() public view {
        _assert(escrow.bankroll(white) == 10 * STAKE, "white bankroll");
        _assert(escrow.available(white) == 10 * STAKE, "white available");
    }

    function test_open_locks_stake_and_caps_withdrawal() public {
        bytes32 gameId = keccak256("g1");
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);

        _assert(escrow.locked(white) == STAKE, "white locked");
        _assert(escrow.available(white) == 10 * STAKE - STAKE, "white available after lock");

        // cannot withdraw locked funds
        vm.prank(white);
        vm.expectRevert();
        escrow.withdraw(10 * STAKE);
    }

    function test_settle_pays_winner_minus_rake() public {
        bytes32 gameId = keccak256("g2");
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);

        bytes32 digest = escrow.digestGameResult(gameId, white);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleGame(gameId, white, v, r, s); // anyone may relay

        uint256 rake = (STAKE * 100) / 10_000; // 1%
        _assert(escrow.bankroll(white) == 10 * STAKE + STAKE - rake, "winner bankroll");
        _assert(escrow.bankroll(black) == 10 * STAKE - STAKE, "loser bankroll");
        _assert(escrow.bankroll(fee) == rake, "fee accrued");
        // stakes unlocked
        _assert(escrow.locked(white) == 0 && escrow.locked(black) == 0, "unlocked");
        // conservation: total bankroll unchanged
        _assert(
            escrow.bankroll(white) + escrow.bankroll(black) + escrow.bankroll(fee) == 20 * STAKE,
            "conservation"
        );
    }

    function test_draw_refunds_both() public {
        bytes32 gameId = keccak256("g3");
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);

        bytes32 digest = escrow.digestGameResult(gameId, address(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleGame(gameId, address(0), v, r, s);

        _assert(escrow.bankroll(white) == 10 * STAKE, "white unchanged");
        _assert(escrow.bankroll(black) == 10 * STAKE, "black unchanged");
        _assert(escrow.locked(white) == 0, "white unlocked");
    }

    function test_forged_signature_rejected() public {
        bytes32 gameId = keccak256("g4");
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);

        // sign with the wrong key
        bytes32 digest = escrow.digestGameResult(gameId, white);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, digest);
        vm.expectRevert();
        escrow.settleGame(gameId, white, v, r, s);
    }

    function test_double_settle_rejected() public {
        bytes32 gameId = keccak256("g5");
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);

        bytes32 digest = escrow.digestGameResult(gameId, white);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleGame(gameId, white, v, r, s);

        vm.expectRevert();
        escrow.settleGame(gameId, white, v, r, s);
    }

    function test_timeout_refunds() public {
        bytes32 gameId = keccak256("g6");
        vm.prank(oracle);
        escrow.openGame(gameId, white, black, STAKE);

        vm.warp(block.timestamp + 3601);
        escrow.claimTimeout(gameId); // anyone

        _assert(escrow.locked(white) == 0 && escrow.locked(black) == 0, "refunded");
        _assert(escrow.bankroll(white) == 10 * STAKE, "white whole");
    }

    function test_open_requires_unlocked_balance() public {
        bytes32 gameId = keccak256("g7");
        vm.prank(oracle);
        vm.expectRevert();
        escrow.openGame(gameId, white, black, 100 * STAKE); // more than deposited
    }
}
