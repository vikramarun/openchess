# Deployments

## Base mainnet (chain 8453) — 2026-07-10

**`ChessEscrow`** — [`0x7Cc1dD4F12BBfb40fCA6eC2334a27c646FCf923D`](https://basescan.org/address/0x7cc1dd4f12bbfb40fca6ec2334a27c646fcf923d)
(source **verified** on Basescan)

| Parameter | Value |
|---|---|
| Token (USDC) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (canonical Base USDC) |
| Oracle (result signer) | `0xE41Aa20B37a93DA94B22b0c9c2B5CC0691077B53` |
| Owner | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` (hardware wallet, via `Ownable2Step` — accept to finalize) |
| Fee recipient | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` |
| Fee (rake) | 100 bps (1%) |
| Settle timeout | 86400 s (24h) |

**Server wiring** (Fly secrets — not committed): `RPC_URL`, `ESCROW_ADDR` (above),
`ORACLE_KEY` (private key for the oracle address above — held off-chat), and
`REQUIRE_ONCHAIN=1`. `SIWE_CHAIN_ID=8453` is in `fly.toml`.

> **Notes**
> - The deployer address `0xd476AC2C6F0377FD489584899cDBbb64B569C66B` is **burned**
>   (its key was exposed) — do not reuse it. It controls nothing once ownership
>   is accepted by the hardware wallet.
> - Launch state: **unaudited** — server `MAX_STAKE` is capped at 25 USDC as a
>   guardrail. Raise it only after an independent contract audit + moving the
>   oracle key into a KMS/HSM (see PRODUCTION.md).
