# Running more than one server

`chess-server` is **single-node**. Every piece of live state is in one process's
memory, so a second machine doesn't add capacity; it breaks things, silently. A
SIWE nonce issued by one machine fails to verify on the other, offers appear and
vanish depending on which machine answered, and bots can't be dispatched. That
has happened in production once already: Fly re-adds a second machine on any
bare `fly deploy`.

Today that's enforced from two sides:
- `scripts/deploy-server.sh` deploys with `--ha=false`, pins the count to one
  and fails if it isn't.
- The server watches `<app>.internal` DNS and alerts on a sibling
  (`crates/server/src/singlenode.rs`).

## What lives in memory

| State | Where | To share it |
|---|---|---|
| SIWE nonces, sessions, link codes | `auth.rs` | Redis with TTLs. Straightforward |
| Launch tokens (token → seat) | `main.rs` (`tokens`) | Redis. Straightforward |
| Challenges and the matchmaking queue | `matchmaking.rs` (`Lobby`) | Redis. Pairing needs an atomic pop |
| Gauntlet sessions, running tournaments, `game_to_*` routing | `matchmaking.rs` (`Lobby`) | Redis, with standings updated as results land |
| Bot-agent registry (wallet → socket, busy flag) | `agents.rs` | Redis plus pub/sub. An agent's socket lands on one node, so `AssignSeat` has to be routed to that node |
| **Game rooms** (board, clocks, actor tasks) | `main.rs` (`rooms`), `room.rs` | **The hard part.** See below |
| Live-game list | `main.rs` (`live_games`) | Derivable from a shared room registry |
| Rate-limit buckets and connection counts | `ratelimit.rs` | Shared counters (Redis), or accept per-node limits |
| Shutdown state (`shutting_down`, `starts_in_flight`) | `main.rs` | Per-node by nature: each node drains its own rooms |

Already durable, so no change is needed:
- Open tournaments: organizer, entrants, payout, admission, invites, approvals
  and unconfirmed paid entries are persisted and reloaded on boot.
- Maintenance mode (`server_settings`).
- Everything that's settled: games, moves, outboxes.

## A plan

1. **Shared store.** Add a Redis client to `AppState`, and move sessions, launch
   tokens and lobby state behind it. That alone makes REST and the lobby safe
   on several nodes.
2. **Room affinity.** Keep each game's room on exactly one node, with a registry
   mapping `game_id → node`. Route each player's WebSocket (and their moves) to
   the owning node, and use pub/sub so any node can fan out spectator updates.
   The protocol has a `Resume` message, but the server ignores it today, so
   reconnecting to a moved room needs real server support.
3. **Room rehydration (optional).** Rebuild a room from the `moves` table and
   the clocks after a node dies, so a game survives a crash. Today a restart
   ends live games as refunded draws, which is acceptable at current scale.
   Rehydration is what would let a game outlive its node.
4. **Scale up.** Drop `--ha=false` and the single-machine checks.

The game logic (`crates/game-engine`) and the money layer (`contracts/`,
`crates/ledger`) don't change for any of this. It's all `crates/server` plus a
Redis dependency.
