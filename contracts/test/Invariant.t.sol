// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChessEscrow} from "../src/ChessEscrow.sol";
import {MockUSDC, Vm} from "./ChessEscrow.t.sol";

/// Constrains the invariant fuzzer to *valid* sequences of escrow operations
/// (fund/deposit/withdraw/open/settle) across a fixed set of actors, so the
/// solvency invariant is exercised against realistic state, not random reverts.
contract Handler {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    ChessEscrow public escrow;
    MockUSDC public usdc;
    uint256 oracleKey;
    address oracle;
    address[3] public actors;
    uint256 gameCounter;
    bytes32[] openGames;

    constructor(ChessEscrow e, MockUSDC u, uint256 ok, address[3] memory a) {
        escrow = e;
        usdc = u;
        oracleKey = ok;
        oracle = vm.addr(ok);
        actors = a;
    }

    function deposit(uint256 seed, uint256 amt) public {
        address a = actors[seed % 3];
        amt = (amt % (1_000 * 1e6)) + 1; // bounded, non-zero
        usdc.mint(a, amt);
        vm.prank(a);
        usdc.approve(address(escrow), amt);
        vm.prank(a);
        escrow.deposit(amt);
    }

    function withdraw(uint256 seed, uint256 amt) public {
        address a = actors[seed % 3];
        uint256 avail = escrow.available(a);
        if (avail == 0) return;
        amt = (amt % avail) + 1; // [1, avail]
        vm.prank(a);
        escrow.withdraw(amt);
    }

    function openGame(uint256 seed, uint256 stake) public {
        address w = actors[seed % 3];
        address b = actors[(seed / 7 + 1) % 3];
        if (w == b) return;
        uint256 cap = escrow.available(w);
        uint256 capB = escrow.available(b);
        if (capB < cap) cap = capB;
        if (cap == 0) return;
        stake = (stake % cap) + 1;
        bytes32 g = keccak256(abi.encode("h", gameCounter++));
        vm.prank(oracle);
        escrow.openGame(g, w, b, stake);
        openGames.push(g);
    }

    function settleGame(uint256 seed, uint8 outcome) public {
        if (openGames.length == 0) return;
        bytes32 g = openGames[seed % openGames.length];
        (address w, address b,,,, bool settled, bool exists) = escrow.games(g);
        if (!exists || settled) return;
        address winner = outcome % 3 == 0 ? w : (outcome % 3 == 1 ? b : address(0));
        uint256 deadline = 1 << 250;
        bytes32 digest = escrow.digestGameResult(g, winner, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleGame(g, winner, deadline, v, r, s);
    }
}

/// Invariant: the escrow's USDC balance always equals the sum of all tracked
/// bankrolls. Every path preserves this — deposits/withdrawals move token and
/// bankroll together; settlement only moves bankroll *between* accounts (no
/// token leaves the contract until a withdraw). A violation would mean funds
/// were minted, burned, or stranded.
contract SolvencyInvariant {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    ChessEscrow escrow;
    MockUSDC usdc;
    Handler handler;

    address fee = address(0xFEE);
    address[3] actors = [address(0xA1), address(0xA2), address(0xA3)];
    uint256 oracleKey = 0xA11CE;

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new ChessEscrow(address(usdc), vm.addr(oracleKey), fee, 100, 3600);
        handler = new Handler(escrow, usdc, oracleKey, actors);
    }

    /// Only fuzz the handler (not MockUSDC / the escrow directly).
    function targetContracts() public view returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(handler);
    }

    function invariant_solvency() public view {
        uint256 sum = escrow.bankroll(fee);
        for (uint256 i = 0; i < 3; i++) {
            sum += escrow.bankroll(actors[i]);
            // A player's locked exposure can never exceed their bankroll.
            require(escrow.locked(actors[i]) <= escrow.bankroll(actors[i]), "locked > bankroll");
        }
        require(usdc.balanceOf(address(escrow)) == sum, "solvency: balance != sum(bankroll)");
    }
}
