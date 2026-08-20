# Deployments

> **⚠️ `contracts/src/ChessEscrow.sol` is AHEAD of the live v2 deployment.**
> A pre-launch review found that `enterTournament` had no deadline of its own
> while both settle paths close at `openedAt + settleTimeout`, so a player could
> be admitted (and charged) into a tournament that was already impossible to
> settle. The fix adds an immutable **`entryWindow`** and a matching
> `EntryWindowClosed` revert — a **constructor signature change**, so it needs a
> fresh deployment and a bankroll migration, not an upgrade. Until that happens:
> - The vendored ABI (`crates/ledger/abi/ChessEscrow.json`) is built from the
>   NEW source, so it advertises `entryWindow()`. The live v2 has no such
>   function.
> - That is handled, not ignored: `OnchainSettlement::tournament_deadlines`
>   treats a reverting `entryWindow()` as "no separate entry window" and falls
>   back to the settle deadline, which is exactly what v2 enforces.
> - So the **server-side** half of the fix (refusing to start a schedule that
>   cannot finish inside the settle window, and refusing joins past the entry
>   deadline) is live-safe against v2 today and should be deployed now. The
>   contract half lands with the next deployment.
>
> When redeploying, set `ENTRY_WINDOW` (default 4h against a 24h
> `SETTLE_TIMEOUT`; it must be strictly less) and update the table below.

## Base mainnet (chain 8453) — **v2, live**

**`ChessEscrow` v2**: [`0x7a536bEF5cd9694ACaED7Bc5fE65e463Db5d4D68`](https://basescan.org/address/0x7a536bef5cd9694acaed7bc5fe65e463db5d4d68)
(source **verified** on Basescan — "Exact Match", checked 2026-08-10)

Adds tournament sponsorship (`sponsorTournament`, `refundSponsorship`,
`sponsorship`), a buy-in that may be zero so entry can be free, and a
`claimRefund` guard for that case. This is what `ESCROW_ADDR` points at and what
`crates/ledger/abi/ChessEscrow.json` is vendored from.

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
