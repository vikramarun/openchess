# OpenChess — Architecture

Engine-vs-engine chess with non-custodial USDC wagers on Base. The server is the
sole authority on legality, clock, and result; engines run on the *players'*
machines (native client) or in their *browser* (WASM) — never on our servers.

## System overview

```mermaid
flowchart TB
  subgraph Clients
    WEB["Web app (Next.js)\nin-browser Stockfish (WASM)\n= BYO client + spectator"]
    NAT["Native client (Rust)\nany UCI engine + books/tablebases"]
  end

  subgraph Server["chess-server (Rust / axum / tokio)"]
    API["HTTP API\n/games, /park, /queue,\n/gauntlet, /tournaments, /auth"]
    WS["WebSocket hub\n/ws/game/:id"]
    ROOM["per-game room actor\n(game-engine: shakmaty\nauthority: legality + clock + result)"]
    MM["matchmaking (in-memory lobby)\npark / gauntlet / tournament"]
    SW["settlement workers\n(per-game + tournament outboxes)"]
    AUTH["SIWE auth\nnonce/verify/session"]
  end

  PG[("Postgres\ngames, moves, outboxes")]
  CHAIN["Base (EVM)\nChessEscrow.sol + USDC"]

  WEB <-->|WS protocol| WS
  NAT <-->|WS protocol| WS
  WEB -->|REST| API
  NAT -->|REST| API
  API --> MM
  WS --> ROOM
  ROOM --> MM
  ROOM -->|persist moves/result| PG
  ROOM -->|enqueue settlement| PG
  SW -->|drain outbox| PG
  SW -->|signed EIP-712 settle| CHAIN
  API -->|open escrow / tournament| CHAIN
  AUTH -. wallet sign-in .- WEB
  WEB -->|deposit / withdraw / claim| CHAIN
```

Redis pub/sub + game-node sharding are the documented path to multi-node; today
the server is **single-node** (lobby, tokens, sessions, and rooms are in-process).

## Authoritative move loop

The server never trusts a client move — it re-validates legality + clock with
`shakmaty`. The browser and native clients speak the identical protocol.

```mermaid
sequenceDiagram
  participant C as Player client (engine)
  participant H as WS hub
  participant R as Room actor (authority)
  participant S as Spectators
  C->>H: Hello(token)
  H->>R: AttachPlayer(color)  %% occupancy-guarded
  R-->>C: Welcome
  C->>R: Ready
  R-->>C: GameStart(clock)
  loop each ply
    R-->>C: YourTurn(position, moves, clock, deadline)
    C->>R: Move(uci)
    R->>R: validate turn + legality + clock (shakmaty)
    R-->>C: MoveAccepted / MoveRejected
    R-->>S: OpponentMoved (broadcast)
    R->>PG: append move
  end
  R-->>C: GameOver(result, result_hash)
  R->>PG: finish + enqueue settlement (1 tx)
```

## Money flow (per-game)

Non-custodial: funds live in `ChessEscrow`, never a platform wallet. A user
deposits once; each game locks a stake; the server (oracle) signs the result and
a worker settles it. Settlement is durable (transactional outbox + retry).

```mermaid
sequenceDiagram
  participant U as Players (wallets)
  participant API as Server API
  participant E as ChessEscrow (Base)
  participant W as Settlement worker
  U->>E: deposit(USDC)  %% once
  API->>E: openGame(gameId, white, black, stake)  %% locks both stakes
  Note over API,E: seats are the SIWE-authenticated wallets (fail-closed)
  API-->>U: launch tokens (play the game)
  Note over W: on finish, result enqueued to settlement_outbox (durable)
  W->>E: settleGame(gameId, winner, deadline, sig)  %% EIP-712, retrying
  E->>E: winner += stake - rake, loser -= stake, fee += rake
  U->>E: withdraw(unlocked balance)
```

Withdrawals are capped at `bankroll - locked`, so staked funds can't be pulled.
If the oracle never settles, `claimTimeout` refunds both stakes.

## Tournament settlement (format-agnostic pool)

A tournament collects equal buy-ins into a pool and distributes a signed payout
vector — so Swiss / knockout / round-robin / arena all share one contract.

```mermaid
flowchart TB
  OPEN["openTournament(tid, buyIn)"] --> ENTER["enterTournament(tid, player)\nbuy-in moved bankroll -> pool"]
  ENTER --> RUN["round-robin games\n(server scores standings)"]
  RUN --> DONE{field size?}
  DONE -->|small| DIRECT["settleTournament(winners, payouts)\ndirect credit, rake = remainder"]
  DONE -->|large| ROOT["settleTournamentRoot(root, totalPayout)\nrake taken at settle"]
  ROOT --> CLAIM["claimTournament(account, amount, proof)\nO(1) per winner, Merkle-verified"]
  OPEN -.->|never settled, after timeout| REFUND["claimRefund(account)\npermissionless per-entrant"]
```

## Data model (Postgres — durable truth)

```mermaid
erDiagram
  users ||--o{ games : "wallet"
  games ||--o{ moves : "game_id"
  games ||--o| settlement_outbox : "game_id"
  tournament_outbox }o--|| games : "tid (logical)"
  users { uuid id PK; text wallet UK; real rating }
  games { uuid id PK; text mode; text status; text white_wallet; text black_wallet;
          numeric stake; text result; text result_hash; text pgn; text settlement_status }
  moves { uuid game_id FK; int ply; text uci; text san; bigint white_ms; bigint black_ms }
  settlement_outbox { uuid id PK; uuid game_id; text winner_addr; text status; int attempts }
  tournament_outbox { uuid id PK; uuid tid; text mode; jsonb payload; text status; int attempts }
```

Lobby/matchmaking state (park offers, queues, gauntlet sessions, live tournament
standings) is **in-memory** — the Redis layer in production.

## Trust model

| Concern | Who is trusted | Mitigation |
|---|---|---|
| Move legality / clock / result | **server (authority)** | re-validated server-side; result committed by SHA-256 over the move log |
| Result correctness for settlement | **oracle key** (server) | oracle EIP-191-signs `result_hash`; clients verify the signer vs `/oracle` ("✓ Verified"). Same trust as any result oracle; an on-chain dispute window is a documented TODO |
| Custody of funds | **no one** (escrow contract) | funds in `ChessEscrow`; platform can only move *locked* stake between the two committed players per a signed result; `claimTimeout`/`claimRefund` recover funds if the oracle vanishes |
| Engine fairness | not a concern | engines are allowed; a human override just plays worse and loses their own stake |

Residual: collusion/wash-trading between two wallets one operator controls
(rake-only cost) is unaddressed (no rating/Sybil controls yet).
