# Operations

How to deploy and run OpenChess: the production checklist, the deploy runbooks,
every environment variable, and the caveats for hosting it somewhere other than
the setup it was built on (Fly.io for the server, Vercel for the web).

## Production status

OpenChess is live on Base mainnet with real USDC. The code-level money paths fail
closed, but several protections that a larger deployment needs are not in place.
The 25 USDC stake cap is the guardrail standing in for them.

**Done**

- **Contract deployed.** `ChessEscrow` v2 was deployed with
  `contracts/script/Deploy.s.sol` and verified on Basescan, against canonical
  Base USDC ([deployments.md](deployments.md)).
- **Owner.** The contract owner is a hardware wallet. The `Ownable2Step`
  transfer has been accepted.
- **TLS.** HTTPS for the web app and the server, WSS for game sockets.
- **Strict boot.** `REQUIRE_ONCHAIN=1` makes the server refuse to boot unless
  Postgres, onchain settlement, `SIWE_DOMAIN` and `WEB_ORIGIN` are all
  configured.
- **Readiness.** `/ready` fails when wagering is live but there's no database,
  and when a configured database doesn't answer.
- **Single machine.** `deploy-server.sh` asserts exactly one machine, and the
  server pages if it ever sees a sibling (`singlenode.rs`).
- **Rate limiting.** Per-IP limits are applied in the app (`ratelimit.rs`).
- **Alerts.** Money-path failures post to `ALERT_WEBHOOK_URL`, best effort.
- **Database.** Postgres is attached on Fly.

**Not done**

- [ ] **Third-party audit** of the contract. There have been internal reviews
  only ([security-reviews.md](security-reviews.md)).
- [ ] **Oracle key in a KMS/HSM.** Today `ORACLE_KEY` is a plaintext secret.
  Signing is a single `sign_hash` call on a digest the contract computes, so
  swapping in an external signer (alloy supports AWS KMS) is mechanical.
- [ ] **Multisig owner, with `setOracle` behind a timelock.** Without these, an
  oracle rotation takes effect instantly.
- [ ] **A multisig or threshold oracle**, which needs ERC-1271 support in the
  contract. Do this before raising `MAX_STAKE`.
- [ ] **Edge rate limiting** (Cloudflare or a gateway), for floods the app never
  sees.
- [ ] **Monitoring.**
  - Onchain events (`OracleUpdated`, `PausedSet`, `Ownership*`).
  - A solvency check: reconcile deposits and withdrawals against the contract's
    USDC balance.
  - Outbox depth and age.
  - The oracle's ETH balance.
  - Metrics and log shipping.
- [ ] **Confirmed database backups.** Point-in-time recovery hasn't been
  checked.
- [ ] **Migrations as a one-shot deploy step.** Today they run in-process on
  boot. That's fine for additive changes; move it to a separate step before any
  destructive migration.
- [ ] **Legal review** for real-money gaming in your jurisdictions: licensing,
  AML/KYC, money-transmitter rules, terms, geofencing. This is not legal advice.

**Known limitations**

- **Single-node.** See [multi-node.md](multi-node.md).
- **Restarts end live games.** A restart ends every live game as an unrated,
  refunded draw. Use maintenance mode before a planned deploy.
- **No onchain dispute window.** The operator could sign a wrong result.
- **Off-chain stake cap.** `MAX_STAKE` (25 USDC) is a constant in
  `crates/server/src/main.rs`. Raising it means changing code and redeploying,
  and the contract enforces no cap of its own.

## Deploying the game server

`chess-server` is a long-lived, stateful WebSocket process, so it needs a host
that runs a persistent container. It can't run on Vercel. The repo has a
multi-stage `Dockerfile`, which runs the server as non-root, and a `fly.toml`.
Migrations are embedded and run on boot, and queries are checked at runtime, so
the image builds without a database.

### Fly.io

```bash
fly launch --no-deploy --copy-config --name <app> --ha=false   # uses the repo Dockerfile + fly.toml
fly postgres create --name <app>-db && fly postgres attach <app>-db   # sets DATABASE_URL
fly secrets set RPC_URL="https://..." ESCROW_ADDR="0x..." ORACLE_KEY="0x..." HOUSE_WALLET="0x..."
# edit fly.toml: app name, SIWE_DOMAIN and WEB_ORIGIN for your web host
SERVER_URL=https://<app>.fly.dev ./scripts/deploy-server.sh
```

**Always deploy with `./scripts/deploy-server.sh`, never a bare `fly deploy`.**
A bare deploy re-adds Fly's high-availability second machine. Every piece of live
state is per-process, so two machines breaks things silently: sign-ins fail
intermittently and offers appear and vanish. The script:
- deploys with `--ha=false`;
- pins the machine count to one and fails if it isn't;
- starts the machine if the rollout left it stopped (`auto_start_machines` is
  off, so nothing else would);
- gates on `/health`, `/ready` and `/config`.

Set `SERVER_URL` when deploying anything other than the production app, or
those checks will hit production instead of your server.

`fly.toml` sets `kill_timeout = "20s"`. That has to exceed the shutdown drain's
10-second budget (`DRAIN_BUDGET`), which is what ends live games and queues
their refunds. Fly's default of 5 seconds would cut the drain off partway.

### Planned deploys: maintenance mode

1. As the escrow's onchain owner, sign in to the web app and turn on
   **maintenance mode**. Use the banner's "Pause new games" toggle, or
   `POST /admin/maintenance {"on": true}` with the owner's session.
2. New games, challenges and tournament creates or joins now return 503.
   Running tournaments pause at their next round.
3. Let live games finish, then run `deploy-server.sh`.
4. The flag is stored in Postgres, so the new build comes up still paused. Turn
   it off once it's healthy, and resume any paused tournaments: the organizer
   calls start again.

Deploying without the drain is safe for money but rude to players. On shutdown
every live game ends as an unrated aborted draw, and its refund is queued in the
outbox before the process exits. Only a hard kill or a crash skips that. Those
stakes then wait for the contract's `claimTimeout`.

**Rollback.** Migrations are forward-only. An older binary won't boot against a
database that has a migration it doesn't know about. To roll back past one,
delete that version's row from `_sqlx_migrations`, but only if the migration is
additive and the old code ignores the new column.

### Other hosts (Railway, Render, a VM)

The root `Dockerfile` works anywhere. Set the same environment, expose port 8080,
run **exactly one** instance, and point the health check at `/ready`. Know what
you lose off Fly:

- **Rate limits key on `Fly-Client-IP`.** Behind any other proxy that header is
  client-supplied, so per-IP limits can be bypassed until you change
  `client_ip` in `ratelimit.rs` to trust your proxy's header.
- **Shutdown grace must exceed 10 seconds**, so the drain can finish.
- **The second-machine detector only runs on Fly.** It uses `FLY_APP_NAME` and
  `<app>.internal` DNS.
- **Postgres connections are plaintext.** sqlx is built without TLS, so a
  database that requires `sslmode=require` won't connect. Use a private
  network, as Fly does, or add a TLS feature to `crates/persistence`.

### The oracle needs gas

The server sends `openGame`, `enterTournament` and settlement transactions from
the oracle address, which therefore needs Base ETH. If it runs dry, staked games
fail closed: they're refused, not lost. Keep it funded and watch the balance.

## Deploying the web app (Vercel)

1. Import the repo into Vercel and set **Root Directory = `apps/web`**. It has
   its own `package.json` and lockfile; pnpm 10 is pinned in `packageManager`.
2. Set the environment variables listed below.
3. Deploy. Merges to `main` auto-deploy. The Stockfish WASM under
   `public/engines/` is served as static files, and the build is
   single-threaded, so no COOP/COEP headers are needed.

On the server, set `WEB_ORIGIN` to the web app's full origin (used for CORS), and
`SIWE_DOMAIN` to its host. The host must equal the browser's URL exactly.

### Dynamic (sign-in)

In the [Dynamic dashboard](https://app.dynamic.xyz), for each environment:

- **Chains.** Enable Base (8453), plus Base Sepolia if you build with the
  testnet flag. These must match the chain list in `apps/web/lib/wagmi.ts`.
- **Logins.** Enable email and Google sign-in, with embedded wallets created on
  sign-up.
- **Wallets.** Enable the external wallets you want, and set your own
  WalletConnect project id.
- **CORS origins** (Security → CORS Origin). **An empty list is not
  enforced**, so adding the first origin switches enforcement on for
  everything. Use scheme + host + port, with no trailing slash. Keep a
  `*.vercel.app` preview wildcard in the *sandbox* environment only. The
  environment id is public, so a wildcard on *live* lets any Vercel deployment
  sign in against your quota.

If `NEXT_PUBLIC_DYNAMIC_ENV_ID` is unset, the app still works for spectating,
replays, profiles and `/play`. Everything that seats a player shows "sign-in
isn't configured" instead.

## Deploying the house bot

The house bot keeps standing offers at each lobby time control so a visitor
always has an opponent. It's `chess-client connect --auto` plus Stockfish, in its
own Fly app.

```bash
fly apps create <app>-housebot
fly secrets set --stage -a <app>-housebot OPENCHESS_WALLET_KEY=0x...   # a fresh, UNFUNDED key
fly deploy --config fly.housebot.toml --ha=false && fly scale count 1 -a <app>-housebot
```

`--stage` is needed on a new app, because there's no machine yet to push the
secret to. Set the server's `HOUSE_WALLET` to this key's address: that is how the
lobby's quick-play button finds the bot's offers, and how the server grants the
bot its `HouseBot` username. The bot's games are casual, so its wallet holds
nothing. Configuration (seats per time control, move budget, opening book) is in
the header of `scripts/house-bot.sh`. Keep time controls × seats **under**
`RL_MAX_OPEN_OFFERS` (default 16).

## Releasing `chess-client`

Prebuilt binaries are built and published by `.github/workflows/release.yml` on
any `v*` tag. The tag must match the `byo-client` crate version, so bump
`crates/byo-client/Cargo.toml` first and then tag:

```bash
git tag v0.1.2 && git push origin v0.1.2
```

The artifact names (`chess-client-{macos-arm64,macos-x64,linux-x64}.tar.gz`,
`chess-client-windows-x64.zip`) are load-bearing: the web app's `/connect` page
links to `releases/latest/download/<name>`. The client uses rustls, so `wss://`
works without a system OpenSSL.

## Enabling stakes on Base Sepolia

To test the full money loop without real money:

1. **Make the oracle keypair.** Run `cast wallet new`. The address is the
   contract's `ORACLE`; the private key is the server's `ORACLE_KEY`.
2. **Get funds.** Base Sepolia ETH for a deployer wallet, and test USDC from
   <https://faucet.circle.com> for player wallets.
3. **Deploy.** The script picks Base Sepolia USDC automatically on chain 84532:

   ```bash
   cd contracts
   ORACLE=0x<oracle> forge script script/Deploy.s.sol:Deploy \
     --rpc-url $BASE_SEPOLIA_RPC --private-key $DEPLOYER_KEY --broadcast --verify
   ```

4. **Point the server at it.** Set `RPC_URL`, `ESCROW_ADDR` and `ORACLE_KEY`,
   and `SIWE_CHAIN_ID=84532`, then deploy.
5. **Build the web app with `NEXT_PUBLIC_ENABLE_TESTNET=1`.** Without the flag,
   Base Sepolia isn't in the wallet config. The escrow address and chain come
   from the server's `GET /config`.
6. **Test it.** Deposit test USDC, post a staked challenge from one wallet,
   accept from another, and watch it settle. For tournaments,
   `scripts/test-sepolia-tournament.sh` drives the Merkle claim and refund paths
   against a live testnet escrow.

For a fully local loop, use `scripts/onchain-demo.sh` (one-on-one games) and
`scripts/tournament-demo.sh` (settled and abandoned tournaments). Both run on
Anvil.

## Environment variables

### Server (`chess-server`)

| Variable | Default | Purpose |
|---|---|---|
| `BIND` | `127.0.0.1:8080` | Listen address (`0.0.0.0:8080` in a container) |
| `DATABASE_URL` | — | Postgres. Without it the server runs in memory, with no history and no durable settlement |
| `RPC_URL`, `ESCROW_ADDR`, `ORACLE_KEY` | — | Onchain settlement. If any is missing, the server logs settlements instead and refuses every stake |
| `SIWE_DOMAIN` | — | Must equal the web app's host |
| `SIWE_CHAIN_ID` | `8453` | Chain expected in SIWE messages (84532 for Base Sepolia) |
| `WEB_ORIGIN` | — | CORS allow-origin: the web app's full origin |
| `REQUIRE_ONCHAIN` | off | `1` refuses to boot unless the database, onchain settlement, `SIWE_DOMAIN` and `WEB_ORIGIN` are all set |
| `HOUSE_WALLET` | — | The house bot's address. Without it, quick play falls back to the `/play` demo |
| `HOUSE_USERNAME` | `HouseBot` | Username granted to `HOUSE_WALLET` at boot. It's reserved for everyone else |
| `ADMIN_WALLET` | escrow `owner()` | Who may toggle maintenance mode. Unset means the onchain owner, re-read on every call. Set it only to override, for example locally |
| `ALERT_WEBHOOK_URL` | — | Slack, Discord or generic webhook for money-path failures. Best effort |
| `SETTLE_CONFIRMATIONS` | `1` | Blocks to wait before a write counts as landed. Raising it adds latency to game starts |
| `RUST_LOG` | `info` | Log filter (`tracing` `EnvFilter`) |
| `FLY_APP_NAME` | set by Fly | Enables the second-machine detector |

**Rate limits** (`RL_*`; defaults in `crates/server/src/ratelimit.rs`):

| Variable | What it limits |
|---|---|
| `RL_{AUTH,OFFERS,CREATE,WS,READS,POLLS,AVATAR,USERNAME}_{BURST,PER_SEC}` | Per-IP token buckets for each route family |
| `RL_GAME_CONNS_MAX`, `RL_GAME_CONNS_PER_IP` | Concurrent game sockets, total (2048) and per IP (128) |
| `RL_AGENT_CONNS_MAX`, `RL_AGENT_CONNS_PER_IP` | Concurrent bot-agent sockets, total (512) and per IP (16) |
| `RL_MAX_OPEN_OFFERS` | Open challenges per poster (16) |
| `RL_MAX_OPEN_TOURNAMENTS` | Open pooled tournaments per organizer (3) |
| `RL_MAX_TOURNAMENTS` | Tournaments in the lobby (256) |
| `RL_MAX_ROOMS` | Live game rooms (4096) |

### Web (`apps/web`)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SERVER_HTTP` | The game server's HTTPS origin |
| `NEXT_PUBLIC_SERVER_WS` | The game server's WSS origin |
| `NEXT_PUBLIC_DYNAMIC_ENV_ID` | Dynamic environment id: sandbox for previews, live for production |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata and share cards. Defaults to production, so set it on previews |
| `NEXT_PUBLIC_ENABLE_TESTNET` | `1` adds Base Sepolia to the wallet config |

### Contract deploy (`contracts/script/Deploy.s.sol`)

| Variable | Default | Purpose |
|---|---|---|
| `ORACLE` | required | The result signer's address |
| `TOKEN` | canonical USDC for the chain | Base mainnet or Base Sepolia, picked by chain id |
| `FEE_RECIPIENT` | `ORACLE` | Where the rake goes. Use a fresh address |
| `FEE_BPS` | `100` (1%) | Rake, at most 1000 |
| `SETTLE_TIMEOUT` | `86400` (24h) | Seconds before refunds open. Must be at least 1 hour, which the script enforces, because it also bounds every staked game's `claimTimeout` |

### House bot (`scripts/house-bot.sh`)

`OPENCHESS_WALLET_KEY` (required, unfunded), `SERVER`, `ENGINE`, `TCS`, `SEATS`,
`MOVE_BUDGET`, `MIN_MOVE_MS`, `BOOK`, `BOOK_MAX_PLY`. The script header
documents each one.
