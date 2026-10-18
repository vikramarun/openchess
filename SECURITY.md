# Security

OpenChess settles real USDC on Base mainnet, so security reports matter to us.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it
privately through GitHub's
[private vulnerability reporting](https://github.com/vikramarun/openchess/security/advisories/new).
Include what you found, how to reproduce it, and what you think the impact is.
We'll acknowledge it, keep you updated while we fix it, and credit you when the
fix ships, unless you'd rather we didn't.

In scope:
- the `ChessEscrow` contract;
- the game server (`crates/`), including settlement, auth and matchmaking;
- the web app (`apps/web`);
- the native client (`chess-client`).

The highest-impact classes:
- anything that moves, locks or misdirects funds;
- staking or seating a player without their consent;
- forging or altering a game result;
- taking over a session or a seat.

Please don't test against other people's games or funds on the live site. A
local stack (`scripts/onchain-demo.sh` runs the money loop on Anvil) reproduces
nearly everything.

## Trust model

What you have to trust, and what limits it. [ARCHITECTURE.md](ARCHITECTURE.md)
has the full table.

- **Custody: nobody.** Funds sit in `ChessEscrow`, never in a platform wallet.
  Withdrawals are capped at your unlocked balance. If the oracle stops settling,
  `claimTimeout` (games) and `claimRefund` (tournaments) let you take your money
  back yourself after the settle timeout (24h).
- **Results: the server.** The server is the referee and the result oracle. It
  signs every result, and the web app verifies that signature against the
  published oracle address. But there is **no onchain dispute window**: a
  compromised oracle key could sign a wrong result.
  - **Staked games.** A bad result could only move the locked stakes between
    the two players in that game.
  - **Tournaments.** The contract checks that payouts don't exceed the pool,
    not who they go to. A compromised key could pay a tournament pool to anyone.
- **Sessions: an httpOnly cookie.** Signing in gives the browser a session
  cookie (`__Host-openchess_session`: `HttpOnly`, `Secure`, `SameSite=Strict`,
  host-only, 24h) that no script on the page can read. A session can commit its
  wallet's escrow balance to staked games, so a session readable by script would
  let any XSS steal it and stake from anywhere. The cookie only authenticates a
  request that also carries the `X-OpenChess-Session` header and comes from the
  web app's own origin, which blocks cross-site request forgery. An XSS that
  ran while you had the page open could still act as you *in that tab*. That's
  true of any browser session, and the Content-Security-Policy is the defence
  against it. Signing out revokes the session on the server. The native
  `chess-client` uses a bearer token, which you hold yourself.
- **Administration: the owner.** A single hardware wallet. It can:
  - rotate the oracle immediately (no timelock);
  - set the rake, up to 10%;
  - pause deposits, new games and tournament entries. Pausing never blocks
    withdrawals.
  - Ownership transfers are two-step.

## Known limitations

These are deliberate, documented, and the reason stakes are capped at 25 USDC
(server-enforced):

- **No third-party audit** of the contract. There have been nine rounds of
  internal review; see [docs/security-reviews.md](docs/security-reviews.md).
- **The oracle key is a hot key** held as a server secret, not in a KMS/HSM, and
  it isn't a multisig or threshold signer.
- **Launch tokens ride in the WebSocket URL's query string.** A leaked one lets
  someone play, and throw, that seat. It can't redirect the payout, which is
  bound to the seat's wallet when the escrow opens.
- **Collusion between two wallets one person controls** isn't prevented.
- **The server is single-node,** and a restart ends live games as refunded
  draws.
- **The tournament settle deadline is enforced by the server, not the
  contract.** If that check failed, the outcome is a delayed refund, not a loss.

[docs/operations.md](docs/operations.md#production-status) is the checklist for
closing these.
