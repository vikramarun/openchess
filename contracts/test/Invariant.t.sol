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
    uint256 tournamentCounter;
    bytes32[] tournaments;

    /// The two leaves committed by a root settle, kept so `claimTournament` can
    /// rebuild the proof the contract will verify. Two leaves is the smallest
    /// tree that still exercises sorted-pair hashing and a non-empty proof.
    struct RootPayout {
        address a0;
        uint256 amt0;
        address a1;
        uint256 amt1;
    }

    mapping(bytes32 => RootPayout) rootPayouts;
    bytes32[] rootTournaments;

    /// Every tournament this handler has opened, so the invariant can account
    /// for the pools the escrow still holds.
    function tournamentIdsAll() external view returns (bytes32[] memory) {
        return tournaments;
    }

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

    // --- tournaments ------------------------------------------------------
    // None of this was fuzzed before, so `pool` was always zero and the solvency
    // invariant held trivially over the tournament half of the contract.

    /// Buy-in of zero every 4th tournament, so free-entry (sponsor-funded)
    /// pools are exercised alongside paid ones.
    function openTournament(uint256 seed, uint256 buyIn) public {
        buyIn = seed % 4 == 0 ? 0 : (buyIn % (100 * 1e6)) + 1;
        bytes32 t = keccak256(abi.encode("t", tournamentCounter++));
        vm.prank(oracle);
        escrow.openTournament(t, buyIn);
        tournaments.push(t);
    }

    function enterTournament(uint256 tSeed, uint256 aSeed) public {
        if (tournaments.length == 0) return;
        bytes32 t = tournaments[tSeed % tournaments.length];
        address a = actors[aSeed % 3];
        (uint256 buyIn,,,,, bool settled,,) = escrow.tournaments(t);
        if (settled || escrow.tournamentEntered(t, a) || escrow.available(a) < buyIn) return;
        vm.prank(oracle);
        escrow.enterTournament(t, a);
    }

    function sponsorTournament(uint256 tSeed, uint256 aSeed, uint256 amt) public {
        if (tournaments.length == 0) return;
        bytes32 t = tournaments[tSeed % tournaments.length];
        address a = actors[aSeed % 3];
        (,,,, uint64 openedAt, bool settled,,) = escrow.tournaments(t);
        if (settled || block.timestamp > openedAt + escrow.settleTimeout()) return;
        uint256 cap = escrow.available(a);
        if (cap == 0) return;
        amt = (amt % cap) + 1;
        vm.prank(a);
        escrow.sponsorTournament(t, amt);
    }

    /// Settle directly with a distribution that sums to AT MOST the pool, so
    /// both an exhaustive split and one leaving a rake remainder are covered.
    function settleTournament(uint256 tSeed, uint256 seed) public {
        if (tournaments.length == 0) return;
        bytes32 t = tournaments[tSeed % tournaments.length];
        (, uint256 pool,,, uint64 openedAt, bool settled,,) = escrow.tournaments(t);
        if (settled || block.timestamp > openedAt + escrow.settleTimeout()) return;

        address[] memory winners = new address[](3);
        uint256[] memory payouts = new uint256[](3);
        uint256 remaining = pool;
        for (uint256 i = 0; i < 3; i++) {
            winners[i] = actors[i];
            uint256 amt = remaining == 0 ? 0 : uint256(keccak256(abi.encode(seed, i))) % (remaining + 1);
            payouts[i] = amt;
            remaining -= amt;
        }
        uint256 deadline = 1 << 250;
        bytes32 digest = escrow.digestTournamentResult(t, winners, payouts, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleKey, digest);
        escrow.settleTournament(t, winners, payouts, deadline, v, r, s);
    }

    function claimRefund(uint256 tSeed, uint256 aSeed) public {
        if (tournaments.length == 0) return;
        bytes32 t = tournaments[tSeed % tournaments.length];
        address a = actors[aSeed % 3];
        (uint256 buyIn,,,, uint64 openedAt, bool settled,,) = escrow.tournaments(t);
        if (settled || buyIn == 0 || block.timestamp <= openedAt + escrow.settleTimeout()) return;
        if (!escrow.tournamentEntered(t, a) || escrow.tournamentClaimed(t, a)) return;
        escrow.claimRefund(t, a);
    }

    function refundSponsorship(uint256 tSeed, uint256 aSeed) public {
        if (tournaments.length == 0) return;
        bytes32 t = tournaments[tSeed % tournaments.length];
        address a = actors[aSeed % 3];
        (,,,, uint64 openedAt, bool settled,,) = escrow.tournaments(t);
        if (settled || block.timestamp <= openedAt + escrow.settleTimeout()) return;
        if (escrow.sponsorship(t, a) == 0) return;
        escrow.refundSponsorship(t, a);
    }

    /// Settle by committing a Merkle root, the path large fields take.
    ///
    /// This half of tournament settlement was outside the invariant entirely:
    /// with only the direct settle fuzzed, `payoutRoot` was never set, so
    /// `claimTournament` below was unreachable and the regime where the escrow
    /// holds a pool it has already committed but not yet paid out — the only
    /// one where `pool - claimedAmount` is neither 0 nor the whole pool — was
    /// never asserted against.
    function settleTournamentRoot(uint256 tSeed, uint256 seed) public {
        if (tournaments.length == 0) return;
        bytes32 t = tournaments[tSeed % tournaments.length];
        (, uint256 pool,,, uint64 openedAt, bool settled,,) = escrow.tournaments(t);
        if (settled || block.timestamp > openedAt + escrow.settleTimeout()) return;

        RootPayout memory p;
        p.a0 = actors[seed % 3];
        p.a1 = actors[(seed / 7 + 1) % 3];
        // Distinct leaves: the same account twice would be blocked by
        // `tournamentClaimed` on the second claim, so it would only waste a run.
        if (p.a0 == p.a1) return;

        // Sum to at most the pool, so both an exhaustive split and one leaving a
        // rake remainder are covered.
        p.amt0 = pool == 0 ? 0 : uint256(keccak256(abi.encode(seed, "a"))) % (pool + 1);
        uint256 rest = pool - p.amt0;
        p.amt1 = rest == 0 ? 0 : uint256(keccak256(abi.encode(seed, "b"))) % (rest + 1);

        // Signing lives in its own frame — inline it and this function is one
        // local past "stack too deep".
        _commitRoot(t, p);
        rootPayouts[t] = p;
        rootTournaments.push(t);
    }

    function _commitRoot(bytes32 t, RootPayout memory p) private {
        bytes32 l0 = _leaf(p.a0, p.amt0);
        bytes32 l1 = _leaf(p.a1, p.amt1);
        bytes32 root =
            l0 <= l1 ? keccak256(abi.encodePacked(l0, l1)) : keccak256(abi.encodePacked(l1, l0));
        uint256 total = p.amt0 + p.amt1;
        uint256 deadline = 1 << 250;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(oracleKey, escrow.digestTournamentRoot(t, root, total, deadline));
        escrow.settleTournamentRoot(t, root, total, deadline, v, r, s);
    }

    /// Claim one committed leaf. Bounded by `claimedAmount + amount <= pool`
    /// onchain, which is the check the corrected invariant term relies on.
    function claimTournament(uint256 tSeed, uint256 which) public {
        if (rootTournaments.length == 0) return;
        bytes32 t = rootTournaments[tSeed % rootTournaments.length];
        RootPayout memory p = rootPayouts[t];

        address who;
        uint256 amount;
        bytes32 sibling;
        if (which % 2 == 0) {
            (who, amount, sibling) = (p.a0, p.amt0, _leaf(p.a1, p.amt1));
        } else {
            (who, amount, sibling) = (p.a1, p.amt1, _leaf(p.a0, p.amt0));
        }
        if (escrow.tournamentClaimed(t, who)) return;

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        escrow.claimTournament(t, who, amount, proof);
    }

    /// OZ-style double-hashed leaf, matching `ChessEscrow._verifyProof`.
    function _leaf(address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, amt))));
    }

    /// Advance time in small steps so a sequence crosses the settle timeout part
    /// way through — otherwise the refund paths above are unreachable and the
    /// settle paths are the only ones ever fuzzed.
    function warp(uint256 secs) public {
        vm.warp(block.timestamp + (secs % 600) + 1);
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
        escrow = new ChessEscrow(address(usdc), vm.addr(oracleKey), fee, 100, 3600, 1800);
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
        // Plus every tournament pool the escrow still holds but has not yet
        // credited to anyone. `pool - claimedAmount` is that amount in all three
        // regimes: unsettled (nothing credited, and entrant/sponsor refunds
        // decrement `pool` as they pay out), direct-settled (`claimedAmount` is
        // set to `pool`, so zero — everything was credited at settle), and
        // root-settled (`pool` is trimmed to the committed total and each claim
        // moves `claimedAmount` up).
        //
        // Summing bare `pool` instead would double-count every settled
        // tournament, and dropping the term entirely — which is what this
        // invariant did while no handler function ever opened one — makes the
        // whole tournament half of the contract unverified.
        bytes32[] memory tids = handler.tournamentIdsAll();
        for (uint256 i = 0; i < tids.length; i++) {
            (, uint256 pool, uint256 claimed,,,,,) = escrow.tournaments(tids[i]);
            require(claimed <= pool, "claimed > pool");
            sum += pool - claimed;
        }
        require(
            usdc.balanceOf(address(escrow)) == sum,
            "solvency: balance != sum(bankroll) + unpaid pools"
        );
    }
}
