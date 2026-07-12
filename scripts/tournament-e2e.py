#!/usr/bin/env python3
"""Live E2E money-path smoke test: SETTLED + ABANDONED on-chain tournament.

Exercises the full staked-tournament loop against a *real* stack — local Anvil
chain, real Postgres, real wallets (Anvil deterministic keys), and the real
chess-server (SIWE auth, durable settlement outbox, on-chain settlement via the
ledger crate). This is the money-path smoke test HANDOFF.md flagged as
outstanding; run it after any change to the tournament / settlement / escrow path.

Prereqs: anvil, forge, cast (Foundry), psql, a reachable Postgres at $DATABASE_URL
(default postgres://$USER@localhost/chess with migrations applied), and a debug
build (`cargo build`).

  Test A (settled):  3 players buy in (locked on-chain via enterTournament) ->
  organizer starts -> round-by-round round-robin played by chess-client engines ->
  server aggregates standings -> pool distributed on-chain by settleTournament.
  Asserts bankroll conservation (0% rake => sum preserved) and status=settled.

  Test B (abandoned): 3 players buy in -> organizer starts (pool open, status
  running, persisted) -> server KILLED mid-tournament -> restarted -> recovery
  marks it abandoned -> anvil time jumps past the settle window -> each entrant
  recovers their buy-in on-chain via claimRefund. Asserts full refund + conservation.

Usage:  python3 scripts/tournament-e2e.py
"""
import json, os, signal, subprocess, sys, time, urllib.request, urllib.error

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], text=True,
                      capture_output=True, cwd=os.path.dirname(__file__)).stdout.strip()
RPC = "http://127.0.0.1:8545"
H = "http://127.0.0.1:8080"
CLIENT = f"{ROOT}/target/debug/chess-client"
SERVER = f"{ROOT}/target/debug/chess-server"
DB = os.environ.get("DATABASE_URL", f"postgres://{os.environ.get('USER')}@localhost/chess")
DBNAME = DB.rsplit("/", 1)[-1]
SETTLE_TIMEOUT = 600  # settleTimeout (prod is 24h). Test A settles inside it;
                      # Test B jumps anvil time past it to reach claimRefund.

K0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # deployer/fee
A1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # oracle
A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"  # fee recipient
PLAYERS = [
    ("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"),
    ("0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"),
    ("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"),
]

procs = {}
def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, text=True, capture_output=True, **kw)
def shout(cmd, **kw):
    r = sh(cmd, **kw)
    if r.returncode != 0:
        print(f"CMD FAILED: {cmd}\n{r.stdout}\n{r.stderr}"); cleanup(); sys.exit(1)
    return r.stdout.strip()

def cast(args): return shout(f"cast {args} --rpc-url {RPC}")
def bankroll(escrow, addr):
    return int(cast(f'call {escrow} "bankroll(address)(uint256)" {addr}').split()[0])

def http(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(H + path, data=data, method=method)
    if token: req.add_header("authorization", f"Bearer {token}")
    if data is not None: req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def siwe_login(key, addr):
    n = None
    for _ in range(30):
        try:
            _, n = http("GET", "/auth/nonce")
            if n: break
        except Exception:
            time.sleep(0.3)
    nonce = n["nonce"]
    msg = (f"chess.local wants you to sign in with your Ethereum account:\n{addr}\n\n"
           f"Sign in.\n\nURI: http://chess.local\nVersion: 1\nChain ID: 8453\n"
           f"Nonce: {nonce}\nIssued At: 2026-05-30T00:00:00Z")
    sig = shout(f"cast wallet sign --private-key {key} '{msg}'")
    st, r = http("POST", "/auth/verify", body={"message": msg, "signature": sig})
    assert st == 200, f"siwe verify {st}: {r}"
    return r["token"]

def start_server():
    env = dict(os.environ, DATABASE_URL=DB, SIWE_DOMAIN="chess.local", SIWE_CHAIN_ID="8453",
               RPC_URL=RPC, ESCROW_ADDR=ESCROW, ORACLE_KEY=K1, RUST_LOG="info,chess_server=info,ledger=info")
    f = open("/tmp/tourney_server.log", "a")
    procs["server"] = subprocess.Popen([SERVER], env=env, stdout=f, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            st, _ = http("GET", "/config")
            if st == 200: return
        except Exception:
            time.sleep(0.3)
    print("server did not come up"); cleanup(); sys.exit(1)

def stop_server():
    p = procs.pop("server", None)
    if p: p.send_signal(signal.SIGKILL); p.wait()

def cleanup():
    stop_server()
    p = procs.pop("anvil", None)
    if p: p.send_signal(signal.SIGKILL)
    subprocess.run(["pkill", "-f", "target/debug/chess-client"], capture_output=True)

# ---------------------------------------------------------------- setup
open("/tmp/tourney_server.log", "w").close()
print("== reset DB game/tournament/outbox tables (harness hygiene) ==")
# Stale outbox rows from prior runs would be retried on the fresh chain and
# collide with the synchronous oracle open_* txs (nonce races). Start clean.
shout(f'''psql -d {DBNAME} -c "TRUNCATE settlement_outbox, tournament_outbox, tournament_games, tournaments, moves, games CASCADE"''')
print("== anvil ==")
procs["anvil"] = subprocess.Popen(["anvil"], stdout=open("/tmp/anvil.log", "w"), stderr=subprocess.STDOUT)
time.sleep(2)

try:
    os.chdir(f"{ROOT}/contracts")
    print("== deploy MockUSDC + ChessEscrow (0% rake) ==")
    USDC = json.loads(shout(f"forge create test/ChessEscrow.t.sol:MockUSDC --rpc-url {RPC} --private-key {K0} --broadcast --json"))["deployedTo"]
    ESCROW = json.loads(shout(f"forge create src/ChessEscrow.sol:ChessEscrow --rpc-url {RPC} --private-key {K0} --broadcast --json --constructor-args {USDC} {A1} {A0} 0 {SETTLE_TIMEOUT}"))["deployedTo"]
    print(f"USDC={USDC} ESCROW={ESCROW}")

    for addr, key in PLAYERS:
        cast(f'send {USDC} "mint(address,uint256)" {addr} 10000000 --private-key {key}')
        cast(f'send {USDC} "approve(address,uint256)" {ESCROW} 10000000 --private-key {key}')
        cast(f'send {ESCROW} "deposit(uint256)" 10000000 --private-key {key}')
    print("funded + deposited 10 USDC each")

    start_server()
    sessions = [siwe_login(k, a) for a, k in PLAYERS]
    print("signed in 3 players")

    def run_tournament(name):
        org = sessions[0]
        st, r = http("POST", "/tournaments", token=org,
                     body={"name": name, "buy_in": "1000000", "initial_secs": 3, "increment_secs": 0})
        assert st == 200, f"create {st}: {r}"
        tid = r["tournament_id"]
        for s in sessions:
            st, r = http("POST", f"/tournaments/{tid}/join", token=s, body={})
            assert st == 200, f"join {st}: {r}"
        return tid

    def play_until_done(tid, stop_after_first_round=False):
        """Drive round-by-round play. Poll each player's /my-games; play any seat
        with a browser token we haven't started yet (each seat needs its own
        client). Returns final status."""
        played = set()
        deadline = time.time() + 120
        first_round_seen = False
        while time.time() < deadline:
            st, t = http("GET", f"/tournaments/{tid}")
            status = t["status"] if isinstance(t, dict) else "?"
            if status in ("settled", "complete", "abandoned"):
                return status
            for (addr, _), sess in zip(PLAYERS, sessions):
                st, games = http("GET", f"/tournaments/{tid}/my-games", token=sess)
                if not isinstance(games, list):
                    continue
                for g in games:
                    seatkey = (g["game_id"], g["color"])
                    if seatkey in played or not g.get("token"):
                        continue
                    played.add(seatkey)
                    first_round_seen = True
                    subprocess.Popen([CLIENT, "play", "--game", g["game_id"], "--token", g["token"]],
                                     stdout=open(f"/tmp/t_{g['game_id']}_{g['color']}.out", "w"),
                                     stderr=subprocess.STDOUT)
            if stop_after_first_round and first_round_seen:
                time.sleep(1.5)
                return status
            time.sleep(1.0)
        return "timeout"

    # ================================================= TEST A: settled
    print("\n########## TEST A: SETTLED TOURNAMENT ##########")
    before = [bankroll(ESCROW, a) for a, _ in PLAYERS]
    print(f"bankrolls before: {before}  (sum={sum(before)})")
    tidA = run_tournament("E2E Settled Open")
    after_join = [bankroll(ESCROW, a) for a, _ in PLAYERS]
    print(f"bankrolls after join (1 USDC locked each): {after_join}")
    assert all(after_join[i] == before[i] - 1_000_000 for i in range(3)), "buy-in not locked on-chain!"
    st, r = http("POST", f"/tournaments/{tidA}/start", token=sessions[0])
    assert st == 200, f"start {st}: {r}"
    print(f"started; {len(r)} game(s) in first round")
    play_until_done(tidA)
    st, t = http("GET", f"/tournaments/{tidA}")
    assert t["status"] == "settled", f"expected settled, got {t['status']}"
    # settle_tournament ENQUEUES to the durable tournament_outbox; the worker
    # drains it on-chain asynchronously. Poll bankrolls until the pool lands.
    after = after_join
    for _ in range(40):
        after = [bankroll(ESCROW, a) for a, _ in PLAYERS]
        if sum(after) == sum(before) and after != after_join:
            break
        time.sleep(1)
    ob = shout(f'''psql -d {DBNAME} -t -c "SELECT status FROM tournament_outbox WHERE tid='{tidA}'"''').strip()
    print(f"final status: {t['status']}  (tournament_outbox={ob})")
    print(f"bankrolls after settle: {after}  (sum={sum(after)})")
    assert sum(after) == sum(before), f"NOT CONSERVED: before {sum(before)} != after {sum(after)}"
    assert after != after_join, "pool never distributed (bankrolls unchanged from locked state)"
    print("TEST A PASS: pool distributed on-chain, funds conserved ✓")

    # ================================================= TEST B: abandoned
    print("\n########## TEST B: ABANDONED TOURNAMENT (restart -> claimRefund) ##########")
    beforeB = [bankroll(ESCROW, a) for a, _ in PLAYERS]
    print(f"bankrolls before: {beforeB}")
    tidB = run_tournament("E2E Abandoned Open")
    lockedB = [bankroll(ESCROW, a) for a, _ in PLAYERS]
    print(f"bankrolls after join (locked): {lockedB}")
    assert all(lockedB[i] == beforeB[i] - 1_000_000 for i in range(3)), "buy-in not locked!"
    st, r = http("POST", f"/tournaments/{tidB}/start", token=sessions[0])
    assert st == 200, f"start {st}: {r}"
    print("started (status=running, pool open on-chain). Now KILL server mid-tournament...")
    play_until_done(tidB, stop_after_first_round=True)
    time.sleep(1)
    stop_server()
    print("server killed. restarting -> recovery should mark tournament abandoned...")
    subprocess.run(["pkill", "-f", "target/debug/chess-client"], capture_output=True)
    start_server()
    time.sleep(2)
    st, t = http("GET", f"/tournaments/{tidB}")
    pg_status = shout(f'''psql -d {DBNAME} -t -c "SELECT status FROM tournaments WHERE id='{tidB}'"''').strip()
    print(f"post-restart status: pg={pg_status}")
    assert pg_status == "abandoned", f"expected abandoned in DB, got '{pg_status}'"

    print(f"jumping anvil past the {SETTLE_TIMEOUT}s settle window...")
    cast(f'rpc evm_increaseTime {SETTLE_TIMEOUT + 20}')
    cast("rpc evm_mine")
    raw = tidB.replace("-", "")
    gid32 = "0x" + raw + "0" * (64 - len(raw))
    for (addr, key) in PLAYERS:
        cast(f'send {ESCROW} "claimRefund(bytes32,address)" {gid32} {addr} --private-key {key}')
    afterB = [bankroll(ESCROW, a) for a, _ in PLAYERS]
    print(f"bankrolls after claimRefund: {afterB}")
    assert afterB == beforeB, f"refund incomplete: before {beforeB} != after {afterB}"
    print("TEST B PASS: abandoned -> every entrant fully refunded on-chain ✓")

    print("\n=========================================")
    print("ALL LIVE E2E MONEY-PATH TESTS PASSED ✓")
    print("=========================================")
finally:
    cleanup()
