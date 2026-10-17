# Deployments

> **`contracts/src/ChessEscrow.sol` IS the live v2 contract.** The source, its
> tests, the deploy script and the vendored ABI (`crates/ledger/abi/ChessEscrow.json`)
> all match what is deployed at `0x7a53…4D68`, so reading the repo tells you how
> production behaves.
>
> A two-clock tournament lifecycle was written after v2 (an `entryWindow` that
> closes entry and the right to start, and a `startTournament` that starts the
> settle clock when play begins) and **reverted on 2026-10-17 without ever being
> deployed**, together with the server and web support for it. Nothing about v2
> blocks: staked 1v1 games were never affected, and for tournaments the worst
> v2 outcome is a DELAY, never a loss. The server stops the bad case — a field
> still filling, or a schedule still running, once v2's single settle clock
> (`openedAt + settleTimeout`, running from CREATION) has lapsed — by sizing
> every join and start against the live onchain deadline and refusing one that
> could not finish. If that check ever failed, entrants still get their buy-in
> back through `claimRefund` after `settleTimeout`. What v2 gives up: a field
> that fills slowly gets its start refused instead of played, an event that
> never starts locks buy-ins for the full `settleTimeout`, and the deadline is
> enforced by our server rather than by the contract.
>
> The two-clock version is in git history at `9f4f6e0` (contract, tests, and
> the dual-layout server/web reads). Revisit it before buy-in tournaments are
> promoted as a product. It is a constructor change (⇒ a redeploy, not an
> upgrade) and adds `startedAt` to the `Tournament` struct, which changes the
> WIDTH of what `tournaments()` returns — so the server and web must read both
> layouts until the cutover, and must be deployed first.
>
> Production's `ESCROW_ADDR` is confirmed to be v2: `GET /config` reported
> `escrow` = `0x7a53…4D68` after the 2026-10-17 server deploy (Fly v104). That
> had to be read from the server, because the oracle's only escrow transactions
> ever (two `openTournament` calls, 2026-08-09) went to **v1**, a day before v2
> existed. To check a deployment against a ref, run
> `.claude/skills/test-openchess/scripts/verify-deployed.py <address>`.
> `SETTLE_CONFIRMATIONS` (server-side, default 1) is the dial for how many
> blocks a money-backed write waits before it is treated as real.

## Base mainnet (chain 8453) — **v2, live**

**`ChessEscrow` v2**: [`0x7a536bEF5cd9694ACaED7Bc5fE65e463Db5d4D68`](https://basescan.org/address/0x7a536bef5cd9694acaed7bc5fe65e463db5d4d68)
(source **verified** on Basescan — "Exact Match", checked 2026-08-10)

Adds tournament sponsorship (`sponsorTournament`, `refundSponsorship`,
`sponsorship`), a buy-in that may be zero so entry can be free, and a
`claimRefund` guard for that case. This is what `ESCROW_ADDR` should point at
(confirmed, see the note above). `contracts/src/ChessEscrow.sol` and the
vendored `crates/ledger/abi/ChessEscrow.json` are this contract.

| Parameter | Value |
|---|---|
| Token (USDC) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (canonical Base USDC) |
| Oracle (result signer) | `0xE41Aa20B37a93DA94B22b0c9c2B5CC0691077B53` |
| Owner | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` (hardware wallet; `Ownable2Step` transfer **accepted**) |
| Fee recipient | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` |
| Fee (rake) | 100 bps (1%) |
| Settle timeout | 86400 s (24h) |

Verified against the chain after deploy: every byte of the runtime code matches
the local artifact except 114 bytes, all of which fall inside the six immutable
slots (`token`, cached chain id, cached domain separator) — i.e. same source,
immutables filled in at construction.

> **⚠️ Still unaudited.** v2 was deployed without the independent audit
> [PRODUCTION.md](PRODUCTION.md) asks for. `MAX_STAKE` stays at 25 USDC as the
> guardrail. Owner is a single hardware wallet, not a multisig, and `setOracle`
> is not behind a timelock — both are still open items on that checklist.

> **⚠️ Two dead deployments. Do not use either.**
> - `0x3fb1c2b89236c9a59c017901dad76f795a2fdbeb` — **v1 bytecode**, deployed by
>   mistake from a checkout whose working tree was stale (its `main` ref had
>   been force-moved out from under it). Owned by a throwaway key that was
>   exposed in plaintext, so treat it as hostile, not merely wrong.
> - The v1 below, superseded. It held 0 USDC at cutover, so there was nothing to
>   migrate; balances were never at risk.

## Base mainnet (chain 8453), 2026-07-10 — v1, SUPERSEDED


**`ChessEscrow`**: [`0x7Cc1dD4F12BBfb40fCA6eC2334a27c646FCf923D`](https://basescan.org/address/0x7cc1dd4f12bbfb40fca6ec2334a27c646fcf923d)
(source **verified** on Basescan)

| Parameter | Value |
|---|---|
| Token (USDC) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (canonical Base USDC) |
| Oracle (result signer) | `0xE41Aa20B37a93DA94B22b0c9c2B5CC0691077B53` |
| Owner | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` (hardware wallet; `Ownable2Step` transfer **accepted**) |
| Fee recipient | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` |
| Fee (rake) | 100 bps (1%) |
| Settle timeout | 86400 s (24h) |

**Server wiring** (Fly secrets, not committed): `RPC_URL`, `ESCROW_ADDR` (above),
`ORACLE_KEY` (private key for the oracle address above, held off-chat), and
`REQUIRE_ONCHAIN=1`. `SIWE_CHAIN_ID=8453` is in `fly.toml`.

> **Notes**
> - The Basescan-verified source is the **pre-PR-#34 revision** of
>   `contracts/src/ChessEscrow.sol`: that PR's copy pass edited two doc
>   comments after the mainnet deploy, so recompiling `HEAD` yields identical
>   runtime bytecode but a different solc metadata hash. Anyone taking up the
>   "verify it yourself" invitation should diff against the verified source on
>   Basescan, or check out the pre-#34 revision (`git log -- contracts/src`).
> - The deployer address `0xd476AC2C6F0377FD489584899cDBbb64B569C66B` is **burned**
>   (its key was exposed). Do not reuse it. It controls nothing once ownership
>   is accepted by the hardware wallet.
> - Launch state: **unaudited**, so server `MAX_STAKE` is capped at 25 USDC as a
>   guardrail. Raise it only after an independent contract audit + moving the
>   oracle key into a KMS/HSM (see PRODUCTION.md).
