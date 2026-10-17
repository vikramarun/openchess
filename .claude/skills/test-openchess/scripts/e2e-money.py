#!/usr/bin/env python3
"""Live money-path E2E for OpenChess, on a throwaway local chain.

Real stack, nothing mocked: a fresh Anvil, the escrow compiled from THIS
checkout's contracts/, a scratch Postgres database, the real chess-server
(SIWE, durable outboxes, onchain settlement), and chess-client + Stockfish
playing the seats.

Tests (run all, or pick with --only):
  staked-settle   park game staked 1 USDC, played to the end -> settled through
                  the outbox; funds conserved, nothing left locked
  staked-forfeit  the acceptor never connects -> reaped after the 60s start
                  window -> the present player is paid the whole pot
  tourney-settle  3-entrant buy-in round-robin -> pool distributed onchain
  tourney-abandon buy-in tournament, server SIGKILLed mid-event -> reboot marks
                  it abandoned -> chain time jumps -> every entrant claimRefunds
  drain-staked    a deploy (SIGINT) mid staked game -> the shutdown drain
                  enqueues a refund durably -> the next boot pays it back;
                  shutdown must finish inside fly.toml's kill_timeout
  drain-tourney   a deploy (SIGINT) during a buy-in tournament's FINAL round,
                  repeated with more and more other games live (it is a race)
                  -> the event must NOT complete or settle on the drain's
                  aborted draw (a game nobody finished)

Usage:
  python3 e2e-money.py [--repo PATH] [--only a,b] [--drain-loads 0,4,8]
                       [--anvil-port 18545] [--server-port 18080] [--keep-db]

Ports default away from the dev ones (8545/8080) so a running dev stack is
left alone, and the run refuses to start if they are taken. The database is
ALWAYS a throwaway one created and dropped here — the server applies the
branch's migrations at boot, so pointing it at any real database (the `chess`
dev DB included) is how a branch migration reaches somewhere it shouldn't.
The server's environment is scrubbed of real chain and alert settings.
Exit 0 iff every selected test passed.
"""
import argparse, json, os, re, signal, socket, subprocess, sys, tempfile, time
import urllib.error, urllib.request
from datetime import datetime, timezone

ap = argparse.ArgumentParser()
ap.add_argument("--repo", default=None)
ap.add_argument("--only", default="")
ap.add_argument("--anvil-port", type=int, default=18545)
ap.add_argument("--server-port", type=int, default=18080)
ap.add_argument("--drain-loads", default="0,4,8,12,16", help="other live games per drain-tourney trial")
ap.add_argument("--logs", default=None)
ap.add_argument("--keep-db", action="store_true")
ap.add_argument("--no-build", action="store_true")
args = ap.parse_args()
if not __debug__:
    sys.exit("run without -O: every check here is an assert")

ROOT = args.repo or subprocess.run(["git", "rev-parse", "--show-toplevel"], text=True, capture_output=True).stdout.strip()
ROOT = os.path.abspath(ROOT)
LOGS = args.logs or tempfile.mkdtemp(prefix="openchess-e2e.")
os.makedirs(LOGS, exist_ok=True)
RPC = f"http://127.0.0.1:{args.anvil_port}"
H = f"http://127.0.0.1:{args.server_port}"
WS = f"ws://127.0.0.1:{args.server_port}"
SERVER = f"{ROOT}/target/debug/chess-server"
CLIENT = f"{ROOT}/target/debug/chess-client"
SETTLE_TIMEOUT = 600
DRAIN_LOADS = [int(x) for x in args.drain_loads.split(",") if x.strip()]
ENTRY_WINDOW = 300
STAKE = 1_000_000  # 1 USDC (6dp)

# Anvil's deterministic accounts. Test-chain keys only.
K0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; A0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"  # deployer + fee recipient
K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; A1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"  # oracle
PLAYERS = [
    ("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"),
    ("0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"),
    ("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"),
]

procs, clients = {}, []


def log(msg):
    print(msg, flush=True)


def sh(cmd, cwd=None, check=True):
    r = subprocess.run(cmd, shell=True, text=True, capture_output=True, cwd=cwd)
    if check and r.returncode != 0:
        raise RuntimeError(f"command failed: {cmd}\n{r.stdout}\n{r.stderr}")
    return r.stdout.strip()


def cast(a):
    return sh(f"cast {a} --rpc-url {RPC}")


# --- database: always our own, created inside the run's try/finally ----------
own_db = f"openchess_e2e_{os.getpid()}"
DB = f"postgres://localhost/{own_db}"
DBNAME = own_db
# Settings that reach something real are never inherited by the server.
SCRUB = ("RPC_URL", "ESCROW_ADDR", "ORACLE_KEY", "ALERT_WEBHOOK_URL", "ADMIN_WALLET",
         "HOUSE_WALLET", "DATABASE_URL")
BASE_ENV = {k: v for k, v in os.environ.items() if k not in SCRUB}


def q(sql):
    return sh(f'psql -d {DBNAME} -At -c "{sql}"')


# --- process management ----------------------------------------------------
def http(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(H + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


def start_server():
    env = dict(BASE_ENV, DATABASE_URL=DB, SIWE_DOMAIN="chess.local", SIWE_CHAIN_ID="8453",
               RPC_URL=RPC, ESCROW_ADDR=ESCROW, ORACLE_KEY=K1, BIND=f"127.0.0.1:{args.server_port}",
               RL_CREATE_BURST="1000", RL_CREATE_PER_SEC="100",
               RL_OFFERS_BURST="1000", RL_OFFERS_PER_SEC="100", RUST_LOG="info")
    p = subprocess.Popen([SERVER], env=env, stdout=open(f"{LOGS}/server.log", "a"), stderr=subprocess.STDOUT)
    procs["server"] = p
    for _ in range(100):
        # A 200 from a process that is not ours (a stale run on the same
        # port) would send every test to the wrong server and database.
        if p.poll() is not None:
            raise RuntimeError(f"server exited with {p.returncode} (see server.log)")
        try:
            if http("GET", "/config")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError("server did not come up (see server.log)")


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s_:
        return s_.connect_ex(("127.0.0.1", port)) != 0


def kill_server():
    p = procs.pop("server", None)
    if p:
        p.kill()
        p.wait()


def graceful_stop():
    """SIGINT, which is what Fly sends on deploy. Returns seconds to exit."""
    p = procs.pop("server")
    t0 = time.time()
    p.send_signal(signal.SIGINT)
    try:
        p.wait(timeout=KILL_TIMEOUT + 5)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        return None
    return time.time() - t0


def stop_clients():
    while clients:
        c = clients.pop()
        if c.poll() is None:
            c.terminate()


def play(game_id, token, tag):
    clients.append(subprocess.Popen([CLIENT, "play", "--server", WS, "--game", game_id, "--token", token],
                                    stdout=open(f"{LOGS}/client_{tag}.log", "w"), stderr=subprocess.STDOUT))


def siwe_login(key, addr):
    st, r = http("GET", "/auth/nonce")
    assert st == 200, f"nonce {st}: {r}"
    issued = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    msg = ("chess.local wants you to sign in with your Ethereum account:\n" f"{addr}\n\nSign in to OpenChess.\n\n"
           f"URI: http://chess.local\nVersion: 1\nChain ID: 8453\nNonce: {r['nonce']}\nIssued At: {issued}")
    sig = subprocess.run(["cast", "wallet", "sign", "--private-key", key, msg], text=True, capture_output=True, check=True).stdout.strip()
    st, r = http("POST", "/auth/verify", body={"message": msg, "signature": sig})
    assert st == 200, f"siwe verify {st}: {r}"
    return r["token"]


def login_all():
    return [siwe_login(k, a) for a, k in PLAYERS]


def fresh_server():
    stop_clients()
    kill_server()
    start_server()
    return login_all()


# --- chain helpers -----------------------------------------------------------
def bankroll(a):
    return int(cast(f'call {ESCROW} "bankroll(address)(uint256)" {a}').split()[0])


def available(a):
    return int(cast(f'call {ESCROW} "available(address)(uint256)" {a}').split()[0])


def b32(uuid):
    raw = uuid.replace("-", "")
    return "0x" + raw + "0" * (64 - len(raw))


def tournament_onchain(tid):
    """The tournaments() struct by FIELD NAME, decoded with this checkout's ABI —
    so the harness survives the struct gaining a field (startedAt did)."""
    out = cast(f'call {ESCROW} "{T_SIG}" {b32(tid)}').splitlines()
    return {n: v.split()[0] for n, v in zip(T_FIELDS, out)}


def wait_for(pred, secs, step=1.0):
    end = time.time() + secs
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


# --- tests -------------------------------------------------------------------
def t_staked_settle():
    s = fresh_server()
    before = [bankroll(a) for a, _ in PLAYERS[:2]]
    st, r = http("POST", "/park/offers", token=s[0], body={"stake": str(STAKE), "initial_secs": 3, "increment_secs": 0})
    assert st == 200, f"offer {st}: {r}"
    oid = r["offer_id"]
    st, acc = http("POST", f"/park/offers/{oid}/accept", token=s[1], body={})
    assert st == 200, f"accept {st}: {acc}"
    gid = acc["game_id"]
    st, mine = http("GET", f"/park/offers/{oid}", token=s[0])
    assert [available(a) for a, _ in PLAYERS[:2]] == [b - STAKE for b in before], "stakes not locked onchain"
    play(gid, mine["token"], "settle_poster")
    play(gid, acc["token"], "settle_acceptor")
    ob = wait_for(lambda: q(f"SELECT status FROM settlement_outbox WHERE game_id='{gid}'") == "settled", 120)
    result, reason = (q(f"SELECT result||'|'||coalesce(result_reason,'') FROM games WHERE id='{gid}'") or "|").split("|")
    plies = int(q(f"SELECT count(*) FROM moves WHERE game_id='{gid}'") or 0)
    white = q(f"SELECT white_addr FROM games WHERE id='{gid}'").lower()
    after = [bankroll(a) for a, _ in PLAYERS[:2]]
    log(f"  result={result}/{reason} plies={plies} bankrolls {before} -> {after}")
    assert ob, "settlement outbox never reached 'settled'"
    # A forfeit or an abort also settles and conserves funds, and is exactly
    # what a broken seat (wrong token, an acceptor that can't attach, no
    # engine) produces — so "settled + conserved" alone would stay green on a
    # bug that hands every acceptor's stake to the poster.
    assert reason not in ("aborted", "forfeit") and plies >= 2, f"no game was played ({reason}, {plies} plies)"
    assert sum(after) == sum(before), "funds not conserved (fee is 0 on this deployment)"
    assert [available(a) for a, _ in PLAYERS[:2]] == after, "a stake is still locked after settlement"
    # And the money went to whoever the board says won.
    delta = {a.lower(): after[i] - before[i] for i, (a, _) in enumerate(PLAYERS[:2])}
    if result == "draw":
        assert all(d == 0 for d in delta.values()), f"a draw moved money: {delta}"
    else:
        winner = white if result == "white" else next(a for a in delta if a != white)
        assert delta[winner] == STAKE and sum(delta.values()) == 0, f"{result} won but paid {delta}"


def run_tournament(s, name, entrants, initial_secs):
    st, r = http("POST", "/tournaments", token=s[0], body={"name": name, "buy_in": str(STAKE), "initial_secs": initial_secs, "increment_secs": 0})
    assert st == 200, f"create {st}: {r}"
    tid = r["tournament_id"]
    for tok in s[:entrants]:
        st, r = http("POST", f"/tournaments/{tid}/join", token=tok, body={})
        assert st == 200, f"join {st}: {r}"
    return tid


def play_tournament(tid, s, until_status=("settled", "complete", "abandoned"), first_round_only=False, secs=180):
    played = set()
    end = time.time() + secs
    while time.time() < end:
        st, t = http("GET", f"/tournaments/{tid}")
        if isinstance(t, dict) and t.get("status") in until_status:
            return t["status"]
        for i, tok in enumerate(s):
            st, games = http("GET", f"/tournaments/{tid}/my-games", token=tok)
            for g in games if isinstance(games, list) else []:
                key = (g["game_id"], g["color"])
                if key not in played and g.get("token"):
                    played.add(key)
                    play(g["game_id"], g["token"], f"t_{g['game_id'][:8]}_{g['color']}")
        if first_round_only and played:
            time.sleep(1.5)
            return "first-round-dispatched"
        time.sleep(1.0)
    return "timeout"


def t_tourney_settle():
    s = fresh_server()
    before = [bankroll(a) for a, _ in PLAYERS]
    tid = run_tournament(s, "e2e settle", 3, 3)
    assert [bankroll(a) for a, _ in PLAYERS] == [b - STAKE for b in before], "buy-ins not taken onchain"
    st, r = http("POST", f"/tournaments/{tid}/start", token=s[0])
    assert st == 200, f"start {st}: {r}"
    if "startedAt" in T_FIELDS:
        assert int(tournament_onchain(tid)["startedAt"]) != 0, "start did not record startedAt onchain"
    status = play_tournament(tid, s, until_status=("settled", "abandoned"))
    assert status == "settled", f"tournament ended '{status}'"
    ob = wait_for(lambda: q(f"SELECT status FROM tournament_outbox WHERE tid='{tid}'") == "settled" and "settled", 60)
    after = wait_for(lambda: (lambda b: b if sum(b) == sum(before) else None)([bankroll(a) for a, _ in PLAYERS]), 60)
    log(f"  outbox={ob} bankrolls {before} -> {after}")
    assert after and ob == "settled", "pool never distributed"
    assert tournament_onchain(tid)["settled"] == "true", "chain does not agree it settled"


def t_tourney_abandon():
    s = fresh_server()
    before = [bankroll(a) for a, _ in PLAYERS]
    tid = run_tournament(s, "e2e abandon", 3, 3)
    st, r = http("POST", f"/tournaments/{tid}/start", token=s[0])
    assert st == 200, f"start {st}: {r}"
    play_tournament(tid, s, first_round_only=True)
    kill_server()  # a crash, not a deploy: no drain runs
    stop_clients()
    start_server()
    pg = q(f"SELECT status FROM tournaments WHERE id='{tid}'")
    log(f"  after crash + reboot: status={pg}")
    assert pg == "abandoned", f"expected abandoned, got {pg}"
    cast(f"rpc evm_increaseTime {SETTLE_TIMEOUT + ENTRY_WINDOW + 60}")
    cast("rpc evm_mine")
    for addr, key in PLAYERS:
        cast(f'send {ESCROW} "claimRefund(bytes32,address)" {b32(tid)} {addr} --private-key {key}')
    after = [bankroll(a) for a, _ in PLAYERS]
    assert after == before, f"refund incomplete: {before} -> {after}"


def t_drain_staked():
    s = fresh_server()
    before = [available(a) for a, _ in PLAYERS[:2]]
    st, r = http("POST", "/park/offers", token=s[0], body={"stake": str(STAKE), "initial_secs": 120, "increment_secs": 0})
    assert st == 200, f"offer {st}: {r}"
    oid = r["offer_id"]
    st, acc = http("POST", f"/park/offers/{oid}/accept", token=s[1], body={})
    assert st == 200, f"accept {st}: {acc}"
    gid = acc["game_id"]
    st, mine = http("GET", f"/park/offers/{oid}", token=s[0])
    play(gid, mine["token"], "drain_poster")
    play(gid, acc["token"], "drain_acceptor")
    time.sleep(5)
    took = graceful_stop()
    stop_clients()
    ob = q(f"SELECT status||' winner='||coalesce(winner_addr,'NULL') FROM settlement_outbox WHERE game_id='{gid}'")
    log(f"  SIGINT -> exit in {took and round(took, 3)}s (kill_timeout {KILL_TIMEOUT}s); outbox={ob or '(none)'}")
    assert took is not None and took < KILL_TIMEOUT, "shutdown did not finish inside kill_timeout"
    assert ob, "the drain enqueued nothing: the stakes would sit locked until claimTimeout"
    start_server()
    after = wait_for(lambda: (lambda v: v if v == before else None)([available(a) for a, _ in PLAYERS[:2]]), 60)
    log(f"  available {before} -> after reboot {after}")
    assert after == before, "the drained game was not refunded on the next boot"


def drain_tourney_trial(extra):
    s = fresh_server()
    tid = run_tournament(s, f"e2e drain {extra}", 2, 120)  # 2 entrants: one round, one game
    # Other live games, so the drain has more than one room to end — the
    # tournament's outcome then gets processed while the drain is still running.
    for _ in range(extra):
        st, r = http("POST", "/park/offers", token=s[2], body={"initial_secs": 120, "increment_secs": 0})
        assert st == 200, f"casual offer {st}: {r}"
        st, a = http("POST", f"/park/offers/{r['offer_id']}/accept", token=s[0], body={})
        assert st == 200, f"casual accept {st}: {a}"
    st, r = http("POST", f"/tournaments/{tid}/start", token=s[0])
    assert st == 200, f"start {st}: {r}"
    time.sleep(1)
    # The scenario must actually be in place, or "nothing leaked" proves nothing.
    assert q(f"SELECT status FROM tournaments WHERE id='{tid}'") == "running", "tournament not running before the deploy"
    took = graceful_stop()
    stop_clients()
    assert took is not None, "the server did not exit on SIGINT"
    pg = q(f"SELECT status FROM tournaments WHERE id='{tid}'")
    ob = q(f"SELECT status FROM tournament_outbox WHERE tid='{tid}'")
    drained = q(f"SELECT count(*) FROM tournament_games tg JOIN games g ON g.id = tg.game_id "
                f"WHERE tg.tournament_id='{tid}' AND g.result_reason='aborted'")
    log(f"  trial: {extra:2d} other live games -> exit {round(took, 3)}s; status={pg} outbox={ob or '(none)'} drained_games={drained}")
    assert int(drained or 0) >= 1, "the drain did not end the tournament's game"
    return pg in ("complete", "settled") or bool(ob)


def t_drain_tourney():
    # A race, not a deterministic path: whether the drained outcome reaches the
    # tournament before the process exits depends on how many rooms the drain
    # is still ending. One clean trial proves nothing, so try several loads.
    leaks = [n for n in DRAIN_LOADS if drain_tourney_trial(n)]
    start_server()  # leave a server up for any later test's fresh_server()
    assert not leaks, (
        f"with {leaks} other live games a deploy completed the tournament on the drain's aborted "
        "draw — a game nobody finished, which the next boot would pay out")


def t_staked_forfeit():
    """A DECISIVE payout: the acceptor never shows, so after START_WINDOW (60s)
    the room reaps it as a forfeit and the poster takes the whole pot."""
    s = fresh_server()
    before = [bankroll(a) for a, _ in PLAYERS[:2]]
    st, r = http("POST", "/park/offers", token=s[0], body={"stake": str(STAKE), "initial_secs": 60, "increment_secs": 0})
    assert st == 200, f"offer {st}: {r}"
    oid = r["offer_id"]
    st, acc = http("POST", f"/park/offers/{oid}/accept", token=s[1], body={})
    assert st == 200, f"accept {st}: {acc}"
    gid = acc["game_id"]
    st, mine = http("GET", f"/park/offers/{oid}", token=s[0])
    play(gid, mine["token"], "forfeit_poster")  # only the poster's engine connects
    log("  acceptor is a no-show; waiting out the 60s start window...")
    ob = wait_for(lambda: q(f"SELECT status FROM settlement_outbox WHERE game_id='{gid}'") == "settled", 120, 2)
    res = q(f"SELECT result||'/'||coalesce(result_reason,'') FROM games WHERE id='{gid}'")
    after = [bankroll(a) for a, _ in PLAYERS[:2]]
    log(f"  result={res} bankrolls {before} -> {after}")
    assert ob, "settlement outbox never reached 'settled'"
    assert after == [before[0] + STAKE, before[1] - STAKE], "the present player was not paid the pot"


TESTS = {"staked-settle": t_staked_settle, "staked-forfeit": t_staked_forfeit, "tourney-settle": t_tourney_settle, "tourney-abandon": t_tourney_abandon,
         "drain-staked": t_drain_staked, "drain-tourney": t_drain_tourney}


def teardown():
    stop_clients()
    kill_server()
    a = procs.pop("anvil", None)
    if a:
        a.kill()
    if not args.keep_db:
        subprocess.run(f"dropdb --if-exists {own_db}", shell=True, capture_output=True)


# --- run ---------------------------------------------------------------------
selected = [t.strip() for t in args.only.split(",") if t.strip()] or list(TESTS)
unknown = [t for t in selected if t not in TESTS]
if unknown:
    sys.exit(f"unknown test(s) {unknown}; choose from {list(TESTS)}")

def _on_signal(signum, _frame):
    raise SystemExit(f"interrupted by signal {signum}")  # runs the finally below


for _sig in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(_sig, _on_signal)

results = {}
try:
    for port in (args.anvil_port, args.server_port):
        if not port_free(port):
            raise SystemExit(f"port {port} is in use — a stale run? Refusing rather than test someone else's stack.")
    sh(f"createdb {own_db}")
    m = re.search(r'kill_timeout\s*=\s*"?(\d+)s?"?', open(f"{ROOT}/fly.toml").read())
    KILL_TIMEOUT = int(m.group(1)) if m else 5  # Fly's default
    if not args.no_build:
        log("== building server + client ==")
        sh("cargo build -q -p server -p byo-client", cwd=ROOT)
    log("== compiling contracts ==")
    sh("forge build -q", cwd=f"{ROOT}/contracts")
    abi = json.load(open(f"{ROOT}/contracts/out/ChessEscrow.sol/ChessEscrow.json"))["abi"]
    ctor = next(x for x in abi if x["type"] == "constructor")["inputs"]
    tfn = next(x for x in abi if x.get("name") == "tournaments")
    T_FIELDS = [o["name"] for o in tfn["outputs"]]
    T_SIG = "tournaments(bytes32)(" + ",".join(o["type"] for o in tfn["outputs"]) + ")"
    log(f"== anvil on :{args.anvil_port}; db={DBNAME}; logs={LOGS} ==")
    procs["anvil"] = subprocess.Popen(["anvil", "--port", str(args.anvil_port)], stdout=open(f"{LOGS}/anvil.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(2)
    USDC = json.loads(sh(f"forge create test/ChessEscrow.t.sol:MockUSDC --rpc-url {RPC} --private-key {K0} --broadcast --json", cwd=f"{ROOT}/contracts"))["deployedTo"]
    by_name = {"token_": USDC, "oracle_": A1, "feeRecipient_": A0, "feeBps_": 0,
               "settleTimeout_": SETTLE_TIMEOUT, "entryWindow_": ENTRY_WINDOW}
    missing = [i["name"] for i in ctor if i["name"] not in by_name]
    if missing:
        sys.exit(f"ChessEscrow constructor gained {missing}: teach e2e-money.py a test value for it")
    ctor_args = " ".join(str(by_name[i["name"]]) for i in ctor)
    ESCROW = json.loads(sh(f"forge create src/ChessEscrow.sol:ChessEscrow --rpc-url {RPC} --private-key {K0} --broadcast --json --constructor-args {ctor_args}", cwd=f"{ROOT}/contracts"))["deployedTo"]
    log(f"   escrow={ESCROW} ctor=({', '.join(i['name'] for i in ctor)}) tournaments=({', '.join(T_FIELDS)})")
    for addr, key in PLAYERS:
        cast(f'send {USDC} "mint(address,uint256)" {addr} 100000000 --private-key {key}')
        cast(f'send {USDC} "approve(address,uint256)" {ESCROW} 100000000 --private-key {key}')
        cast(f'send {ESCROW} "deposit(uint256)" 100000000 --private-key {key}')

    for name in selected:
        log(f"\n## {name}")
        try:
            TESTS[name]()
            results[name] = "PASS"
        except Exception as e:  # keep going: one run should show every result
            results[name] = f"FAIL: {e}"
        log(f"   -> {results[name]}")
finally:
    teardown()

log("\n== summary ==")
for k, v in results.items():
    log(f"{k:16s} {v}")
log(f"logs: {LOGS}")
sys.exit(0 if results and all(v == "PASS" for v in results.values()) else 1)
