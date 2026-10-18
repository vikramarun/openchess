# Contributing

Thanks for looking. This file covers setup, tests and conventions. For the
detail behind every non-obvious rule in the codebase, and why each one exists,
read [CLAUDE.md](CLAUDE.md). Despite the name, it's the most complete
engineering reference in the repo, for people and coding agents alike.

## Setup

- **Rust ≥ 1.91** (a requirement of `alloy`). CI runs the newest stable, so
  run the lints on it too.
- **[Foundry](https://getfoundry.sh)**: `forge`, `anvil`, `cast`.
- **Node and pnpm 10.** The version is pinned in `apps/web/package.json`
  (`packageManager`); `corepack enable` picks it up.
- **Optional:** Postgres (for the persistence tests and a realistic server),
  and `stockfish` on your PATH (for the native client and the house bot).

```bash
cargo run -p server                        # game server on 127.0.0.1:8080
(cd apps/web && pnpm install && pnpm dev)  # web app on http://localhost:3000
```

The signed-in parts of the web app need a Dynamic sandbox environment id in
`apps/web/.env.local`; see `apps/web/.env.example`. `/play` works without one.

## Tests

CI (`.github/workflows/ci.yml`) runs all of this on every pull request, against a
real Postgres:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test                                 # ~240 tests; set DATABASE_URL for the DB round-trip tests
(cd contracts && forge test)               # 34 tests, incl. a solvency invariant over 128k random calls
(cd apps/web && pnpm build)
(cd apps/web && pnpm test:<suite>)         # 29 focused suites; the list is in package.json and CLAUDE.md
```

To run every gate locally in one go, without stopping at the first failure, use
the CI script:

```bash
bash .claude/skills/test-openchess/scripts/ci-gates.sh
```

It creates and drops its own throwaway database, and scrubs anything from the
environment that could reach a real chain or alert channel. Don't point the
persistence tests at a database you care about: they apply the branch's
migrations to it.

**Changes that touch money paths** (contract, ledger, settlement, staking,
tournaments) should also pass the live end-to-end tests. They run real staked
games, tournaments and shutdown drains against a local Anvil chain:

```bash
python3 .claude/skills/test-openchess/scripts/e2e-money.py
```

**Every bug fix should come with a regression test that fails without the
fix.** Most of the tests in this repo exist because something shipped broken.

## Conventions

- **Money is `rust_decimal` / `U256`, never floats.** USDC has 6 decimals.
- **Fail closed.** No stake is accepted unless onchain settlement is
  configured. A seat's wallet always comes from the authenticated session,
  never a request body. A new game-creating or money-moving route must call
  `state.reject_if_draining()?`.
- **The server is the authority.** UI gates are UX; the server re-checks
  everything.
- **Single-node.** All live state is in process memory. Don't add anything that
  assumes a second machine ([docs/multi-node.md](docs/multi-node.md)).
- **No engine-weakening options anywhere.** Not `Skill Level`, not
  `UCI_LimitStrength`. The product promise is full-strength engines.
- **Contract ABIs are vendored** in `crates/ledger/abi/`. Re-vendor after any
  contract change; the command is above the `sol!` macros in
  `crates/ledger/src/lib.rs`.
- **Migrations are append-only.** Never edit an applied migration. sqlx
  checksums them, and an edited one stops the server from booting.

## Pull requests

- Branch from `main` and open a pull request. CI and a Vercel preview build must
  pass before it merges.
- Merging deploys the web app (Vercel). It does **not** deploy the server or the
  house bot; see [docs/operations.md](docs/operations.md).
- Keep docs in step with behaviour. If you change something a doc describes,
  update the doc in the same pull request.
