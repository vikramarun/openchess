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
- [x] **Per-IP rate limiting in-app** (`crates/server/src/ratelimit.rs`):
  token-bucket throttles on `/auth/*`, park create/accept, WS upgrades, and
  `/players/*`+`/leaderboard`; global + per-IP WS connection caps; a per-owner
  open-offer cap. Env-tunable (`RL_*`), keyed on `Fly-Client-IP`. **Still add
  edge rate limiting** (Cloudflare/gateway) as defense-in-depth for the L3/L4
  floods the app never sees, and pin `Fly-Client-IP` trust to the deploy.
- [ ] Set `REQUIRE_ONCHAIN=1` so a misconfigured node refuses to boot.

### 4. Observability
- [ ] Put `/ready` (DB check) in the load-balancer health check; keep `/health`
  for liveness.
- [~] **Alert on settlement failures and outbox depth/age.** `ALERT_WEBHOOK_URL`
  (unset ⇒ no-op) now fires a best-effort webhook on the two money-critical
  give-ups (escrow-refund-after-abort, settlement-outbox exhausted). Still add
  real paging + outbox depth/age metrics — a single webhook POST can itself fail.
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
- **In-browser wagering**: all three wager modes run fully in-browser — connect a
  wallet, deposit USDC into the escrow (approve + `deposit`), and your in-browser
  engine plays your seat while settlement runs on-chain:
  - **Park / Patzer** — post or accept a staked offer.
  - **Gauntlet** — pick a tier; auto-queue, play, re-queue, with a live tally.
  - **Tournament** — create/join (buy-in → pool), start a round-robin, auto-play
    your bracket; the pool pays out by standings (small fields credit the
    bankroll directly; large fields settle a Merkle root, claimed on-chain).
  The escrow address + chain are single-sourced from the server's `GET /config`.
  The native client remains for headless / custom engines.

## Deploying the game server (Fly.io / Railway / any Docker host)

The Rust `chess-server` is a long-lived, stateful WebSocket process — host it on
a platform that runs persistent containers (Fly.io, Railway, Render, a VM), **not
Vercel**. A `Dockerfile` (multi-stage; builds the `chess-server` binary, runs it
as non-root) and a `fly.toml` are in the repo root. Migrations are embedded and
run on boot; queries are runtime sqlx, so the image builds without a database.

**Fly.io (recommended — handles WebSockets + has managed Postgres):**

```bash
fly launch --no-deploy --copy-config --name openchess-server   # uses the repo Dockerfile + fly.toml
fly postgres create --name openchess-db                        # managed Postgres
fly postgres attach openchess-db                               # sets the DATABASE_URL secret
# On-chain wagering (omit for a casual-only server):
fly secrets set RPC_URL="https://..." ESCROW_ADDR="0x..." ORACLE_KEY="0x..."
# Edit SIWE_DOMAIN + WEB_ORIGIN in fly.toml to your Vercel domain, then:
fly deploy
fly scale count 1                                              # exactly ONE instance (single-node)
```

Then point the Vercel app's `NEXT_PUBLIC_SERVER_HTTP` / `NEXT_PUBLIC_SERVER_WS`
at `https://openchess-server.fly.dev` / `wss://openchess-server.fly.dev` and
redeploy the web app.

**Railway / Render / VM:** they auto-detect the root `Dockerfile`. Set the same
env (`DATABASE_URL`, `BIND=0.0.0.0:8080`, `SIWE_DOMAIN`, `WEB_ORIGIN`, and the
on-chain vars), expose port 8080, and run a **single** instance. Use the
platform's health check on `/ready`.

Critical reminders (see "Known limitations"): **one instance only**, don't
auto-stop the machine (it holds live games in memory), set `WEB_ORIGIN` +
`SIWE_DOMAIN` to the exact Vercel host, and set `REQUIRE_ONCHAIN=1` once the
on-chain vars are in so a misconfigured node refuses to boot.

**Drain before deploying** so a redeploy doesn't kill live games: as the escrow
owner, sign in on the web app and flip **maintenance mode** on (the banner's
"Pause new games" toggle, or `POST /admin/maintenance {"on":true}` with the
owner's bearer token). New games stop starting; let in-flight games finish, then
`deploy-server.sh`. The flag is DB-persisted, so the node comes back up still
paused — flip it off once the new build is healthy.

## Deploying the web app to Vercel

Vercel hosts the **Next.js frontend only** (`apps/web`). The Rust game server is
a long-lived, stateful WebSocket process — it **cannot** run on Vercel's
serverless functions. Host it on a VM / Fly.io / Railway / Render (anything that
runs a persistent process, accepts WebSockets, and reaches Postgres + an RPC),
then point the web app at it.

1. Push the repo to GitHub (done).
2. Vercel → **New Project** → import the repo → set **Root Directory =
   `apps/web`** (it has its own `package.json` + lockfile; Next.js is auto-detected).
3. Add Environment Variables (Project Settings → Environment Variables):
   - `NEXT_PUBLIC_SERVER_HTTP` = `https://<your-game-server-host>`
   - `NEXT_PUBLIC_SERVER_WS`   = `wss://<your-game-server-host>`
   - `NEXT_PUBLIC_WC_PROJECT_ID` = your WalletConnect Cloud project id
4. Deploy. `public/stockfish.js` is served as a static asset — the in-browser
   engine works with no extra config (single-threaded build, no COOP/COEP).

On the **game server** side, set `WEB_ORIGIN=https://<your-app>.vercel.app` (CORS)
and `SIWE_DOMAIN=<your-app>.vercel.app` (must equal the browser origin host), plus
`DATABASE_URL`, `RPC_URL`, `ESCROW_ADDR`, `ORACLE_KEY`, `REQUIRE_ONCHAIN=1`.
Terminate TLS in front of it so the browser can reach it over `https`/`wss`.

## Enabling on-chain wagering (Base Sepolia testnet)

This turns the casual-only deployment into a real *staked* one you can test with
a wallet, on testnet (no real money — defers the legal review).

**1. Make the oracle keypair.** The server signs results with this key; the
contract is told its *address*. They must match.

```bash
cast wallet new            # prints an Address (= ORACLE) and a Private Key (= ORACLE_KEY)
```

**2. Fund a deployer + get test USDC.**
- Base Sepolia ETH for the deployer wallet (Coinbase / Alchemy / QuickNode faucet).
- Test USDC for each player wallet — Circle faucet (https://faucet.circle.com),
  Base Sepolia. USDC there is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

**3. Deploy `ChessEscrow`** (the script auto-picks Base Sepolia USDC at chain
84532; `FEE_RECIPIENT` defaults to the oracle, fee 1%, timeout 24h):

```bash
cd contracts
ORACLE=0x<oracle-addr> forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_SEPOLIA_RPC --private-key $DEPLOYER_KEY --broadcast --verify
# (verification needs a Basescan API key: --verifier etherscan --etherscan-api-key $KEY)
```

Note the deployed escrow address.

**4. Point the server at it** (Fly secrets), then redeploy:

```bash
fly secrets set \
  RPC_URL="$BASE_SEPOLIA_RPC" \
  ESCROW_ADDR="0x<deployed-escrow>" \
  ORACLE_KEY="0x<oracle-private-key>"   # the key from step 1
# in fly.toml [env]: SIWE_CHAIN_ID = "84532", REQUIRE_ONCHAIN = "1"
fly deploy
```

**5. No frontend change.** `GET /config` now reports `wager_enabled` + the escrow
+ chain 84532; the web app already bundles Base Sepolia, and the bankroll panel
prompts the wallet to switch networks. Just keep `NEXT_PUBLIC_SERVER_*` pointed
at the server.

**6. Test the loop.** Connect a wallet on Base Sepolia → deposit test USDC in the
bankroll panel → post a staked Park game → accept from a second wallet → watch it
settle and the winner's bankroll grow. (Mainnet is the same flow with real USDC —
but do the contract audit + oracle-key hardening + legal review first.)

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
| `ALERT_WEBHOOK_URL` | recommended | Slack/Discord/generic webhook; best-effort alert on money-critical failures (unset ⇒ no-op) |
| `RL_*` | no | rate-limit tuning (per-bucket burst/rate, WS conn caps, open-offer cap); sane defaults in `ratelimit.rs` |
| `ADMIN_WALLET` | no | who may toggle maintenance/drain mode; defaults to the on-chain escrow `owner()`, so only set to override (e.g. local dev without a chain) |

**Web** (`apps/web`): `NEXT_PUBLIC_SERVER_HTTP`, `NEXT_PUBLIC_SERVER_WS`,
`NEXT_PUBLIC_WC_PROJECT_ID`.

**Deploy** (`script/Deploy.s.sol`): `TOKEN` (defaults to Base USDC), `ORACLE`,
`FEE_RECIPIENT`, `FEE_BPS`, `SETTLE_TIMEOUT`.
