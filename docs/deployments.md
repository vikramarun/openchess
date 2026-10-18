# Deployments

## Base mainnet (chain 8453): `ChessEscrow` v2, live

**Address:** [`0x7a536bEF5cd9694ACaED7Bc5fE65e463Db5d4D68`](https://basescan.org/address/0x7a536bef5cd9694acaed7bc5fe65e463db5d4d68).
The source is verified on Basescan ("Exact Match").

| Parameter | Value |
|---|---|
| Token (USDC) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (canonical Base USDC) |
| Oracle (result signer) | `0xE41Aa20B37a93DA94B22b0c9c2B5CC0691077B53` |
| Owner | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` (a hardware wallet; `Ownable2Step` transfer accepted) |
| Fee recipient | `0x4392d34Cc747160f8F749d1e249e2595f191DF6A` |
| Fee (rake) | 100 bps (1%) |
| Settle timeout | 86400 s (24h) |

**This is the contract in the repo.** `contracts/src/ChessEscrow.sol` compiles
byte-for-byte to the vendored artifact `crates/ledger/abi/ChessEscrow.json`. The
deployed runtime code matches that artifact everywhere except its immutable
slots: the token, plus the chain id and EIP-712 domain separator cached at
construction. The production server's `GET /config` reports this address as
`escrow`. To check it yourself:

```bash
python3 .claude/skills/test-openchess/scripts/verify-deployed.py \
  0x7a536bEF5cd9694ACaED7Bc5fE65e463Db5d4D68 --ref HEAD
```

**What v2 has.**
- Pooled balances and per-game escrow, with EIP-712 settlement.
- Tournament pools, settled directly or by Merkle root.
- Sponsorship (`sponsorTournament`, `refundSponsorship`), and free entry
  (`buyIn = 0`).
- Timeouts that let players reclaim funds if the oracle goes silent.

**Its limits.**
- **One settle clock per tournament, starting at creation.** The server works
  around this; see [tournaments.md](tournaments.md#the-settle-deadline).
- **No third-party audit.**
- **The owner is a single hardware wallet,** not a multisig, and `setOracle` has
  no timelock.

The server caps stakes at 25 USDC to compensate
([operations.md](operations.md#production-status)).

**A redesign that was never deployed.** A later two-clock version of the
contract was written, with an entry window and a `startTournament` transition
that starts the settle clock when play begins. It was reverted before it was
ever deployed. If it's revived, it's a constructor change, so it needs a
redeploy. It also adds a field to the `Tournament` struct, so the server and web
app would have to read both layouts until the cutover. The code is in git
history at `9f4f6e0`.

## Superseded and dead deployments

Don't send funds to any of these.

| Address | What it is |
|---|---|
| [`0x7Cc1dD4F12BBfb40fCA6eC2334a27c646FCf923D`](https://basescan.org/address/0x7cc1dd4f12bbfb40fca6ec2334a27c646fcf923d) | v1 (2026-07-10). Replaced by v2, with no sponsorship or free entry. It held 0 USDC at the cutover. Its verified source is the revision before PR #34, which only changed comments |
| `0x3fb1c2b89236c9a59c017901dad76f795a2fdbeb` | v1 bytecode, deployed by mistake by a throwaway key that was later exposed. Treat it as hostile |

The original deployer address, `0xd476AC2C6F0377FD489584899cDBbb64B569C66B`, is
**burned**: its key was exposed. It controls nothing now that ownership has
moved to the hardware wallet. Never reuse it.
