# Going to production

OpenChess has been **hardened** through three audit rounds (see `AUDIT.md`) — the
code-level Critical/High findings are fixed, and the money paths fail closed. But
**this is not yet a turnkey production deployment**: several items are infra /
ops / legal decisions that only you (the operator) can make. This doc is the
honest checklist.

> **Bottom line:** do not put real USDC behind this until (1) the contract has an
> independent third-party audit, (2) the oracle key is in an HSM/KMS behind a
> multisig+timelock, and (3) you've completed the legal/regulatory review. The
> rest is standard deploy/ops.

---

## What's already done for you (hardening)

- **Contract** (`ChessEscrow.sol`, 22 Foundry tests): non-custodial bankroll +
  per-game escrow + tournament pool (direct + Merkle-claim), `Ownable2Step`,
  `Pausable`, EIP-712 results with `deadline` + fork-safe domain separator,
  SafeERC20-lite + deposit-by-delta, fee snapshot at open, replay guards,
  conservation-tested, timeout/refund safety nets, indexer events, a deploy
  script (`script/Deploy.s.sol`).
- **Server**: SIWE-gated wagers with seats bound to the authenticated wallet,
  fail-closed (no wager without on-chain settlement), durable retrying
  settlement outboxes (per-game + tournament) with reaper + idempotency,
  input bounds, entrant caps, non-poisoning locks (`parking_lot`), supervised
  workers, SIGTERM-aware graceful shutdown, restricted CORS, WS message-size
  limits, state eviction, `/health` + `/ready`, request tracing, and a
  `REQUIRE_ONCHAIN` boot profile that refuses to start half-configured.
- **Frontend**: in-browser WASM engine with load-failure handling, resilient
  play client (resign instead of stall on engine/move failure), SRI on CDN CSS,
  client-only wagmi config.
- **CI** (`.github/workflows/ci.yml`): Postgres + `forge test` + `cargo test` +
  web build.

## Action items only you can do (before mainnet)

### 1. Smart contract
- [ ] **Independent third-party audit** of the final bytecode. Two internal
  rounds are not a substitute.
- [ ] **Deploy via `script/Deploy.s.sol`** to Base, **verify on Basescan** with
  exact constructor args. Use canonical Base USDC
  (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) — never `MockUSDC`/`forge create`.
- [ ] Choose parameters deliberately: `feeBps` (rake, ≤ 1000), `settleTimeout`
  (long enough the oracle always settles first; short enough funds aren't locked
  forever — hours, not the 1h used in demos), `feeRecipient` (a fresh address;
  USDC blacklisting of it strands only rake).
- [ ] **Owner = a multisig (Safe)**; put `setOracle` behind a `TimelockController`
  (24–48h) so an oracle rotation can't instantly drain locked stakes.

### 2. Oracle key (the crown jewel)
- [ ] **Do not run with `ORACLE_KEY` as a plaintext env var in production.** Move
  signing to an HSM/KMS (alloy supports external/AWS-KMS signers; the digest is
  already computed by the contract, so it's a mechanical swap of `sign_hash`).
- [ ] Plan a path to a **multisig/threshold oracle** (ERC-1271 verification in the
  contract) before raising stake limits. A single hot key is the dominant risk.
- [ ] Establish key rotation + monitoring on `OracleUpdated`.

### 3. Infrastructure
- [ ] **Run exactly one `chess-server` replica.** Multi-replica is *broken* today
  (rooms, launch tokens, lobby, and SIWE sessions are in-process) — needs the
  Redis-backed session/lobby + sharded rooms work first.
- [ ] Managed **Postgres** with automated backups + PITR. Run migrations as a
  **one-shot deploy step** (not in-process on every boot) before any future
  destructive migration.
- [ ] **TLS everywhere**: serve the web over `https` and the server over `wss`
  (terminate at a reverse proxy). The launch token rides in the WS query string —
  keep it on TLS and out of logs.
- [ ] **Per-IP rate limiting at the edge** (nginx/Cloudflare/API gateway). The app
  has size caps + state eviction but no in-app per-IP limiter.
- [ ] Set `REQUIRE_ONCHAIN=1` so a misconfigured node refuses to boot.

### 4. Observability
- [ ] Put `/ready` (DB check) in the load-balancer health check; keep `/health`
  for liveness.
- [ ] **Alert on settlement failures and outbox depth/age** — a settlement that
  exhausts retries currently only logs an error; stuck funds must page someone.
- [ ] Monitor on-chain events (`OracleUpdated`, `PausedSet`, `Ownership*`,
  `GameSettled`, `Tournament*`) and reconcile `Deposited/Withdrawn` vs the
  contract's USDC balance to detect solvency drift.
- [ ] Ship structured logs to a collector; add metrics (the `TraceLayer` is
  mounted; add a metrics exporter).

### 5. Legal / compliance (not legal advice — get counsel)
- [ ] **Real-money gaming / gambling licensing** review for your jurisdictions.
- [ ] **AML/KYC** and possible **money-transmitter/MSB** obligations for taking
  USDC wagers.
- [ ] Terms of service, geofencing, and responsible-play controls as required.

### 6. Frontend config
- [ ] Set `NEXT_PUBLIC_WC_PROJECT_ID` (WalletConnect Cloud) for production.
- [ ] Set `WEB_ORIGIN` (server CORS) and ensure the browser origin host equals the
  server's `SIWE_DOMAIN`, and `SIWE_CHAIN_ID` matches your chain (8453 Base).
- [ ] Set `NEXT_PUBLIC_SERVER_HTTP` / `NEXT_PUBLIC_SERVER_WS` to your deployed
  server (https/wss).

## Known limitations (not production-ready as-is)

- **Single-node only** (see Infra #1).
- **Tournament restart**: tournament entrants/standings are now persisted. On
  restart, a tournament whose games all finished is **settled by result**; one
  with games still in flight is marked `abandoned` (their rooms are gone) and
  entrants recover via on-chain `claimRefund`. Resuming *in-flight* games across
  a restart still requires the room-resumption work (single-node limitation).
- **Results are signed + client-verifiable** (the oracle signs `result_hash`;
  clients recover the signer vs `/oracle`). A full **on-chain dispute window**
  (optimistic settlement with fraud proofs) is still a TODO — today a malicious
  operator could sign an incorrect result, matching a standard result-oracle
  trust model.
- **No anti-collusion / wash-trading controls** (rating/Sybil) yet.
- **In-browser wagering UI not built** — Quick Play is fully in-browser; wager
  modes (park/gauntlet/tournament) run via the native client (the web pages are
  labeled beta).

## Environment variables

**Server** (`chess-server`):

| Var | Required | Purpose |
|---|---|---|
| `BIND` | no (`127.0.0.1:8080`) | listen address |
| `DATABASE_URL` | prod yes | Postgres; without it, in-memory + no durable settlement |
| `RPC_URL` / `ESCROW_ADDR` / `ORACLE_KEY` | prod yes | on-chain settlement; missing ⇒ log-only sink (wagers refused) |
| `SIWE_DOMAIN` | prod yes | must equal the web origin host |
| `SIWE_CHAIN_ID` | no (`8453`) | expected chain in SIWE messages |
| `WEB_ORIGIN` | prod yes | CORS allow-origin |
| `REQUIRE_ONCHAIN` | recommended | `1` ⇒ fail boot unless fully configured |

**Web** (`apps/web`): `NEXT_PUBLIC_SERVER_HTTP`, `NEXT_PUBLIC_SERVER_WS`,
`NEXT_PUBLIC_WC_PROJECT_ID`.

**Deploy** (`script/Deploy.s.sol`): `TOKEN` (defaults to Base USDC), `ORACLE`,
`FEE_RECIPIENT`, `FEE_BPS`, `SETTLE_TIMEOUT`.
