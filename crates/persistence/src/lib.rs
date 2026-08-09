//! Durable persistence (Postgres via sqlx): users, games, the move log, and
//! wager/settlement bookkeeping. Runtime queries (no compile-time DB needed).

use anyhow::Result;
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Clone)]
pub struct Db {
    pub pool: PgPool,
}

/// Time control in milliseconds.
#[derive(Clone, Copy)]
pub struct Tc {
    pub initial_ms: i64,
    pub increment_ms: i64,
}

/// Optional onchain wager attached to a game.
#[derive(Clone)]
pub struct Wager {
    pub white_addr: String,
    pub black_addr: String,
    pub stake: Decimal,
}

/// Max settlement attempts before a row is marked permanently `failed`.
pub const MAX_SETTLE_ATTEMPTS: i32 = 10;

#[derive(Debug, sqlx::FromRow)]
pub struct OutboxRow {
    pub id: Uuid,
    pub game_id: Uuid,
    pub winner_addr: Option<String>,
    pub attempts: i32,
}

/// One player's record over some set of games. Used three times per profile —
/// once per ladder and once for the two together.
#[derive(Debug, Default, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct PlayerStatsRow {
    pub games: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    pub net: Decimal,
}

impl PlayerStatsRow {
    /// The two ladders summed. A player who has never played one of them gets
    /// no row back for it at all, which is why every field here starts at zero
    /// rather than at NULL — the profile must render `0`, not blank.
    fn plus(&self, other: &Self) -> Self {
        Self {
            games: self.games + other.games,
            wins: self.wins + other.wins,
            losses: self.losses + other.losses,
            draws: self.draws + other.draws,
            net: self.net + other.net,
        }
    }
}

/// One `GROUP BY rated` bucket of the record query.
#[derive(Debug, sqlx::FromRow)]
struct PlayerStatsBucketRow {
    rated: bool,
    games: i64,
    wins: i64,
    losses: i64,
    draws: i64,
    net: Decimal,
}

/// A player's record split by ladder, plus the two combined. `all` is carried
/// rather than re-derived so the HTTP layer's flat (pre-split) fields and the
/// profile's "All" view can never drift from the buckets under them.
#[derive(Debug, Default)]
pub struct PlayerStats {
    pub all: PlayerStatsRow,
    pub casual: PlayerStatsRow,
    pub ranked: PlayerStatsRow,
}

/// The `users`-row half of a profile: both ladders and the photo version.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerCard {
    /// Ranked Elo — staked games and buy-in tournaments only.
    pub rating: f32,
    /// Casual Elo — everything else. A separate ladder, never mixed in.
    pub casual_rating: f32,
    pub avatar_updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// A stored profile photo. Only read on the image route — the profile JSON
/// carries the timestamp alone, never the bytes.
#[derive(Debug, sqlx::FromRow)]
pub struct AvatarRow {
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct LeaderboardRow {
    pub wallet: String,
    pub rating: f32,
    pub games: i64,
}

#[derive(Debug, sqlx::FromRow)]
pub struct PlayerGameRow {
    pub id: Uuid,
    pub mode: String,
    pub white_wallet: Option<String>,
    pub black_wallet: Option<String>,
    pub result: Option<String>,
    pub stake: Option<Decimal>,
    pub result_reason: Option<String>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub moves: i64,
    /// Which ladder this game counted for. Not derivable from `stake`: a
    /// buy-in tournament game is ranked with no stake of its own.
    pub rated: bool,
}

#[derive(Debug, sqlx::FromRow)]
pub struct TournamentRow {
    pub id: Uuid,
    pub buy_in: Option<String>,
    pub players: serde_json::Value,
}

/// Everything needed to rebuild an `open` tournament in memory after a restart.
#[derive(Debug, sqlx::FromRow)]
pub struct OpenTournamentRow {
    pub id: Uuid,
    pub name: String,
    pub buy_in: Option<String>,
    pub organizer: Option<String>,
    pub initial_secs: i64,
    pub increment_secs: i64,
    pub players: serde_json::Value,
    pub bots: serde_json::Value,
    /// Signed-in wallet per casual entrant (name -> wallet), so games
    /// dispatched after a restart stay attributed (migration 0016).
    pub entrant_wallets: serde_json::Value,
    /// Self-declared engine per entrant (migration 0017), display only.
    pub entrant_engines: serde_json::Value,
    /// Creator-defined prize structure, `{"bps":[…]}` (migration 0019). Must be
    /// restored, or a rehydrated tournament silently pays a different table.
    pub payout: serde_json::Value,
    /// Admission policy + its state (migration 0020). Must be restored, or a
    /// gated tournament comes back with its door open.
    pub admission: String,
    pub invites: serde_json::Value,
    pub approvals: serde_json::Value,
    /// How long ago the tournament was created, so the caller can restore its
    /// TTL clock instead of restarting it on every deploy. Computed by the
    /// database — the server has no chrono of its own.
    pub age_secs: i64,
}

#[derive(Debug, sqlx::FromRow)]
pub struct TournamentGameRow {
    pub white: String,
    pub black: String,
    pub game_status: Option<String>,
    pub game_result: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
pub struct ClaimableTournamentRow {
    pub id: Uuid,
    pub name: String,
    pub status: String,
}

/// A wagered game whose escrow this server never settled. Id only: the amount
/// shown to the player comes from the chain, which is the authority on what is
/// actually refundable.
#[derive(Debug, sqlx::FromRow)]
pub struct UnsettledGameRow {
    pub id: Uuid,
}

#[derive(Debug, sqlx::FromRow)]
pub struct TournamentOutboxRow {
    pub id: Uuid,
    pub tid: Uuid,
    pub mode: String,
    pub payload: serde_json::Value,
    pub attempts: i32,
}

#[derive(Debug, sqlx::FromRow)]
pub struct GameRow {
    pub id: Uuid,
    pub mode: String,
    pub status: String,
    pub result: Option<String>,
    pub result_reason: Option<String>,
    pub pgn: Option<String>,
}

/// Full detail for a single game — powers the public game view (replay of a
/// finished game + settlement status for a wagered one).
#[derive(Debug, sqlx::FromRow)]
pub struct GameDetailRow {
    pub id: Uuid,
    pub mode: String,
    pub status: String,
    pub white_wallet: Option<String>,
    pub black_wallet: Option<String>,
    pub stake: Option<Decimal>,
    /// Which ladder it counted for. A buy-in tournament game is `true` with a
    /// null stake, so a viewer that reads `stake` alone calls it casual.
    pub rated: bool,
    pub result: Option<String>,
    pub result_reason: Option<String>,
    pub result_hash: Option<String>,
    pub result_sig: Option<String>,
    pub settlement_status: String,
    pub time_initial_ms: i64,
    pub time_increment_ms: i64,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Self-declared engines, [white, black]. Null for games recorded before
    /// migration 0013, and for seats that declared none.
    pub white_engine: Option<String>,
    pub black_engine: Option<String>,
}

/// One played move (for replaying a finished game move-by-move).
#[derive(Debug, sqlx::FromRow)]
pub struct MoveRow {
    pub ply: i32,
    pub uci: String,
    pub san: String,
    pub white_ms: i64,
    pub black_ms: i64,
}

impl Db {
    pub async fn connect(url: &str) -> Result<Db> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(url)
            .await?;
        Ok(Db { pool })
    }

    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("./migrations").run(&self.pool).await?;
        Ok(())
    }

    /// Liveness check for the `/ready` endpoint.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    /// Read a durable server-wide setting (see `server_settings`). `None` if the
    /// key was never set.
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT value FROM server_settings WHERE key=$1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(value)
    }

    /// Upsert a durable server-wide setting.
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO server_settings (key, value, updated_at)
               VALUES ($1, $2, now())
               ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()"#,
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Create or fetch a user keyed by wallet address, returning its id.
    pub async fn upsert_user(&self, wallet: &str) -> Result<Uuid> {
        let id: Uuid = sqlx::query_scalar(
            r#"INSERT INTO users (id, wallet) VALUES ($1, $2)
               ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet
               RETURNING id"#,
        )
        .bind(Uuid::new_v4())
        .bind(wallet)
        .fetch_one(&self.pool)
        .await?;
        Ok(id)
    }

    /// Insert a new game row (status = pending).
    #[allow(clippy::too_many_arguments)]
    pub async fn create_game(
        &self,
        id: Uuid,
        mode: &str,
        // Which ladder this game counts for (migration 0015). Decided by the
        // caller because it is not derivable here: a buy-in tournament game is
        // ranked while carrying no stake of its own.
        rated: bool,
        white_wallet: Option<&str>,
        black_wallet: Option<&str>,
        tc: Tc,
        wager: Option<&Wager>,
        // Self-declared engine per seat, [white, black]. Informational only —
        // never verified, so nothing may branch on it (ARCHITECTURE.md).
        engines: [Option<&str>; 2],
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO games
               (id, mode, status, white_wallet, black_wallet,
                time_initial_ms, time_increment_ms, white_addr, black_addr, stake,
                settlement_status, white_engine, black_engine, rated)
               VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)"#,
        )
        .bind(id)
        .bind(mode)
        .bind(white_wallet)
        .bind(black_wallet)
        .bind(tc.initial_ms)
        .bind(tc.increment_ms)
        .bind(wager.map(|w| w.white_addr.clone()))
        .bind(wager.map(|w| w.black_addr.clone()))
        .bind(wager.map(|w| w.stake))
        .bind(if wager.is_some() { "pending" } else { "none" })
        .bind(engines[0])
        .bind(engines[1])
        .bind(rated)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_game_active(&self, id: Uuid) -> Result<()> {
        sqlx::query("UPDATE games SET status='active' WHERE id=$1 AND status='pending'")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Append one ply to the durable move log.
    pub async fn append_move(
        &self,
        game_id: Uuid,
        ply: i32,
        uci: &str,
        san: &str,
        white_ms: i64,
        black_ms: i64,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO moves (game_id, ply, uci, san, white_ms, black_ms)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (game_id, ply) DO NOTHING"#,
        )
        .bind(game_id)
        .bind(ply)
        .bind(uci)
        .bind(san)
        .bind(white_ms)
        .bind(black_ms)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Finish a game and (if wagered) enqueue its settlement in **one
    /// transaction** — the canonical transactional-outbox pattern, so a crash
    /// can't leave a finished wagered game that never settles.
    #[allow(clippy::too_many_arguments)]
    pub async fn finish_and_enqueue(
        &self,
        game_id: Uuid,
        result: &str,
        reason: &str,
        result_hash: &str,
        result_sig: Option<&str>,
        pgn: &str,
        winner_addr: Option<&str>,
        wagered: bool,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        // Idempotent on already-terminal games. A game aborted at dispatch
        // (status='aborted') can be resurrected by a late-connecting agent whose
        // WebSocket keeps the room alive long enough to reap; without this guard
        // that reap would overwrite the aborted row and enqueue a second,
        // conflicting settlement — a phantom result, or a stake confiscation if
        // the abort's refund had failed. Skip both if the game is already
        // 'finished' or 'aborted'.
        let res = sqlx::query(
            r#"UPDATE games
               SET status='finished', result=$2, result_reason=$3,
                   result_hash=$4, result_sig=$5, pgn=$6, finished_at=now()
               WHERE id=$1 AND status NOT IN ('finished','aborted')"#,
        )
        .bind(game_id)
        .bind(result)
        .bind(reason)
        .bind(result_hash)
        .bind(result_sig)
        .bind(pgn)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(());
        }

        if wagered {
            sqlx::query(
                "INSERT INTO settlement_outbox (id, game_id, winner_addr) VALUES ($1,$2,$3)",
            )
            .bind(Uuid::new_v4())
            .bind(game_id)
            .bind(winner_addr)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    // -- tournament settlement outbox -------------------------------------

    /// Enqueue a completed tournament's payout for durable onchain settlement.
    pub async fn enqueue_tournament_settlement(
        &self,
        tid: Uuid,
        mode: &str,
        payload: serde_json::Value,
    ) -> Result<()> {
        sqlx::query("INSERT INTO tournament_outbox (id, tid, mode, payload) VALUES ($1,$2,$3,$4)")
            .bind(Uuid::new_v4())
            .bind(tid)
            .bind(mode)
            .bind(payload)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn claim_tournament_settlements(
        &self,
        limit: i64,
    ) -> Result<Vec<TournamentOutboxRow>> {
        let rows = sqlx::query_as::<_, TournamentOutboxRow>(
            r#"UPDATE tournament_outbox
               SET status='processing', attempts=attempts+1, claimed_at=now()
               WHERE id IN (
                   SELECT id FROM tournament_outbox
                   WHERE status='pending' AND attempts < $2
                   ORDER BY created_at LIMIT $1
                   FOR UPDATE SKIP LOCKED
               )
               RETURNING id, tid, mode, payload, attempts"#,
        )
        .bind(limit)
        .bind(MAX_SETTLE_ATTEMPTS)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn requeue_stale_tournaments(&self, lease_secs: i64) -> Result<u64> {
        let res = sqlx::query(
            r#"UPDATE tournament_outbox SET status='pending'
               WHERE status='processing' AND claimed_at IS NOT NULL
                 AND claimed_at < now() - make_interval(secs => $1)"#,
        )
        .bind(lease_secs as f64)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    pub async fn set_tournament_settlement_status(
        &self,
        id: Uuid,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        sqlx::query("UPDATE tournament_outbox SET status=$2, last_error=$3 WHERE id=$1")
            .bind(id)
            .bind(status)
            .bind(error)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // -- tournament durable state -----------------------------------------

    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_tournament(
        &self,
        id: Uuid,
        name: &str,
        buy_in: Option<&str>,
        organizer: Option<&str>,
        initial_secs: i64,
        increment_secs: i64,
        status: &str,
        players: &serde_json::Value,
        bots: &serde_json::Value,
        entrant_wallets: &serde_json::Value,
        entrant_engines: &serde_json::Value,
        payout: &serde_json::Value,
        admission: &str,
        invites: &serde_json::Value,
        approvals: &serde_json::Value,
    ) -> Result<()> {
        // `payout` is deliberately absent from the DO UPDATE set: the prize
        // structure is decided once, at creation, and entrants join on the
        // strength of it. Re-writing it on every join would let a later bug (or
        // a lost in-memory value) rewrite the terms a field already accepted.
        sqlx::query(
            r#"INSERT INTO tournaments
                 (id, name, buy_in, organizer, initial_secs, increment_secs, status, players, bots,
                  entrant_wallets, entrant_engines, payout, admission, invites, approvals)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status,
                 players=EXCLUDED.players, bots=EXCLUDED.bots,
                 entrant_wallets=EXCLUDED.entrant_wallets,
                 entrant_engines=EXCLUDED.entrant_engines,
                 -- These DO change after creation (codes get minted and spent,
                 -- requests get decided), unlike `payout` and `admission`, which
                 -- are the terms a field joined on and stay as first written.
                 invites=EXCLUDED.invites, approvals=EXCLUDED.approvals"#,
        )
        .bind(id)
        .bind(name)
        .bind(buy_in)
        .bind(organizer)
        .bind(initial_secs)
        .bind(increment_secs)
        .bind(status)
        .bind(players)
        .bind(bots)
        .bind(entrant_wallets)
        .bind(entrant_engines)
        .bind(payout)
        .bind(admission)
        .bind(invites)
        .bind(approvals)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Tournaments still taking entrants when the process died. Unlike a
    /// `running` one, an `open` tournament has no in-flight rooms, so every
    /// field that defines it is on the row and it can be rebuilt exactly —
    /// which is what keeps a restart from stranding entrants whose buy-in is
    /// already locked in the onchain pool. Bounded and newest-first so a very
    /// old backlog can't blow up boot.
    pub async fn open_tournaments(&self, limit: i64) -> Result<Vec<OpenTournamentRow>> {
        let rows = sqlx::query_as::<_, OpenTournamentRow>(
            r#"SELECT id, name, buy_in, organizer, initial_secs, increment_secs,
                      players, bots, entrant_wallets, entrant_engines,
                      payout, admission, invites, approvals,
                      GREATEST(0, EXTRACT(EPOCH FROM (now() - created_at))::BIGINT) AS age_secs
               FROM tournaments WHERE status='open'
               ORDER BY created_at DESC LIMIT $1"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Buy-in tournaments the wallet entered that have reached a finished state
    /// (a payout or refund may be collectable onchain). DB-sourced so it
    /// survives the restart that wipes the in-memory tournaments map. `address`
    /// must be lowercased (entrants are stored lowercased).
    pub async fn claimable_tournaments(
        &self,
        address: &str,
    ) -> Result<Vec<ClaimableTournamentRow>> {
        let rows = sqlx::query_as::<_, ClaimableTournamentRow>(
            r#"SELECT id, name, status FROM tournaments
               WHERE status IN ('complete','settled','abandoned')
                 AND buy_in IS NOT NULL
                 AND players @> to_jsonb($1::text)"#,
        )
        .bind(address)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Wagered games this wallet held a seat in whose escrow was never settled.
    ///
    /// The contract's `claimTimeout` refunds both stakes once `settleTimeout`
    /// has passed with no settlement, but nothing ever surfaced *which* games
    /// qualified — recovery meant hand-writing a contract call. This is only a
    /// candidate list: the chain is the authority on whether the window is
    /// open (and on whether someone already claimed), so the UI checks each one.
    ///
    /// Matches on the onchain seat columns (`*_addr`), not the auth wallet
    /// columns — those are the addresses the escrow actually pays.
    pub async fn unsettled_wagered_games(&self, address: &str) -> Result<Vec<UnsettledGameRow>> {
        let rows = sqlx::query_as::<_, UnsettledGameRow>(
            // A game still in progress is not "unsettled" — its stake is
            // locked because it is being played. Surfacing those told a player
            // mid-game that their live stake was pending a refund. Finished and
            // aborted games qualify immediately; an `active` one only once it
            // is far past any real game (MAX_INITIAL_SECS is 3h), which is how
            // a game whose room died is still caught.
            r#"SELECT id FROM games
               WHERE stake IS NOT NULL
                 AND settlement_status <> 'settled'
                 AND (lower(white_addr) = $1 OR lower(black_addr) = $1)
                 AND (status IN ('finished','aborted')
                      OR created_at < now() - interval '6 hours')
               ORDER BY created_at DESC
               LIMIT 50"#,
        )
        .bind(address)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn set_tournament_status(&self, id: Uuid, status: &str) -> Result<()> {
        sqlx::query("UPDATE tournaments SET status=$2 WHERE id=$1")
            .bind(id)
            .bind(status)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn add_tournament_game(
        &self,
        tid: Uuid,
        game_id: Uuid,
        white: &str,
        black: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO tournament_games (tournament_id, game_id, white, black)
               VALUES ($1,$2,$3,$4) ON CONFLICT (game_id) DO NOTHING"#,
        )
        .bind(tid)
        .bind(game_id)
        .bind(white)
        .bind(black)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Tournaments that may need recovery after a restart (status='running').
    pub async fn recoverable_tournaments(&self) -> Result<Vec<TournamentRow>> {
        // `paused` counts too: a tournament the server parked mid-round (a
        // maintenance drain, the room ceiling) still has in-flight rooms that a
        // restart destroys, so it is recoverable in exactly the same sense —
        // i.e. it is not, and its entrants refund.
        let rows = sqlx::query_as::<_, TournamentRow>(
            "SELECT id, buy_in, players FROM tournaments WHERE status IN ('running','paused')",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Each tournament game with its (possibly null) result/status from `games`.
    pub async fn tournament_game_results(&self, tid: Uuid) -> Result<Vec<TournamentGameRow>> {
        let rows = sqlx::query_as::<_, TournamentGameRow>(
            r#"SELECT tg.white, tg.black, g.status AS game_status, g.result AS game_result
               FROM tournament_games tg LEFT JOIN games g ON g.id = tg.game_id
               WHERE tg.tournament_id = $1"#,
        )
        .bind(tid)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Latest root-mode payload for a tournament (so claim proofs survive a
    /// server restart — the leaves are recoverable from the durable row).
    pub async fn tournament_payload(&self, tid: Uuid) -> Result<Option<serde_json::Value>> {
        let row: Option<(serde_json::Value,)> = sqlx::query_as(
            "SELECT payload FROM tournament_outbox WHERE tid=$1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(tid)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(p,)| p))
    }

    pub async fn get_game(&self, game_id: Uuid) -> Result<Option<GameRow>> {
        let row = sqlx::query_as::<_, GameRow>(
            "SELECT id, mode, status, result, result_reason, pgn FROM games WHERE id=$1",
        )
        .bind(game_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// Full detail for one game (public game view: replay + settlement status).
    pub async fn game_detail(&self, game_id: Uuid) -> Result<Option<GameDetailRow>> {
        let row = sqlx::query_as::<_, GameDetailRow>(
            r#"SELECT id, mode, status, white_wallet, black_wallet, stake, rated, result,
                      result_reason, result_hash, result_sig, settlement_status,
                      time_initial_ms, time_increment_ms, finished_at,
                      white_engine, black_engine
               FROM games WHERE id=$1"#,
        )
        .bind(game_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// A game's moves in play order, for move-by-move replay.
    pub async fn game_moves(&self, game_id: Uuid) -> Result<Vec<MoveRow>> {
        let rows = sqlx::query_as::<_, MoveRow>(
            "SELECT ply, uci, san, white_ms, black_ms FROM moves WHERE game_id=$1 ORDER BY ply",
        )
        .bind(game_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Mark a game aborted (e.g. escrow failed to open — it never really started).
    pub async fn abort_game(&self, game_id: Uuid, reason: &str) -> Result<()> {
        sqlx::query(
            "UPDATE games SET status='aborted', result_reason=$2, finished_at=now() WHERE id=$1",
        )
        .bind(game_id)
        .bind(reason)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // -- settlement outbox -------------------------------------------------

    /// Atomically claim up to `limit` pending outbox rows under the attempt cap
    /// (marks them `processing` + stamps `claimed_at` so a second worker tick
    /// won't double-submit and a crash can be detected by the reaper).
    pub async fn claim_settlements(&self, limit: i64) -> Result<Vec<OutboxRow>> {
        let rows = sqlx::query_as::<_, OutboxRow>(
            r#"UPDATE settlement_outbox
               SET status='processing', attempts=attempts+1, claimed_at=now()
               WHERE id IN (
                   SELECT id FROM settlement_outbox
                   WHERE status='pending' AND attempts < $2
                   ORDER BY created_at LIMIT $1
                   FOR UPDATE SKIP LOCKED
               )
               RETURNING id, game_id, winner_addr, attempts"#,
        )
        .bind(limit)
        .bind(MAX_SETTLE_ATTEMPTS)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Return `processing` rows whose lease expired (worker likely crashed)
    /// back to `pending` so they are retried. Returns how many were requeued.
    pub async fn requeue_stale(&self, lease_secs: i64) -> Result<u64> {
        let res = sqlx::query(
            r#"UPDATE settlement_outbox SET status='pending'
               WHERE status='processing'
                 AND claimed_at IS NOT NULL
                 AND claimed_at < now() - make_interval(secs => $1)"#,
        )
        .bind(lease_secs as f64)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Requeue a row for retry (transient failure) — outbox only.
    pub async fn requeue_settlement(&self, id: Uuid, error: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE settlement_outbox SET status='pending', last_error=$2 WHERE id=$1")
            .bind(id)
            .bind(error)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Terminally finalize a settlement: update the outbox row AND the game's
    /// mirrored `settlement_status` in a **single transaction**, so the two can
    /// never disagree (a finished game can't be left stuck `pending`).
    pub async fn finalize_settlement(
        &self,
        outbox_id: Uuid,
        game_id: Uuid,
        status: &str, // "settled" | "failed"
        error: Option<&str>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE settlement_outbox SET status=$2, last_error=$3 WHERE id=$1")
            .bind(outbox_id)
            .bind(status)
            .bind(error)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE games SET settlement_status=$2 WHERE id=$1")
            .bind(game_id)
            .bind(status)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // -- player profile / stats -------------------------------------------

    /// Store (or replace) a wallet's profile photo. Upserts the user row: a
    /// wallet can sign in and set a photo before it has ever played a game, so
    /// there may be no `users` row yet.
    ///
    /// `wallet` is lowercased here so the unique key and the `lower(wallet)`
    /// read path can't disagree about which row an address owns.
    pub async fn set_avatar(&self, wallet: &str, mime: &str, data: &[u8]) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO users (id, wallet, avatar_mime, avatar_data, avatar_updated_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (wallet) DO UPDATE
                 SET avatar_mime=EXCLUDED.avatar_mime,
                     avatar_data=EXCLUDED.avatar_data,
                     avatar_updated_at=now()"#,
        )
        .bind(Uuid::new_v4())
        .bind(wallet.to_lowercase())
        .bind(mime)
        .bind(data)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drop a wallet's profile photo. A no-op when it never had one.
    pub async fn clear_avatar(&self, wallet: &str) -> Result<()> {
        sqlx::query(
            r#"UPDATE users
                 SET avatar_mime=NULL, avatar_data=NULL, avatar_updated_at=NULL
               WHERE lower(wallet)=$1"#,
        )
        .bind(wallet.to_lowercase())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A wallet's profile photo bytes, or `None` when it has none.
    pub async fn avatar(&self, wallet: &str) -> Result<Option<AvatarRow>> {
        let row = sqlx::query_as::<_, AvatarRow>(
            r#"SELECT avatar_mime AS mime, avatar_data AS data
                 FROM users
                WHERE lower(wallet)=$1
                  AND avatar_data IS NOT NULL AND avatar_mime IS NOT NULL"#,
        )
        .bind(wallet.to_lowercase())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// Everything the profile head needs off the `users` row: the rating, and
    /// when the photo last changed (the version tag the API hands out, so
    /// clients can cache the image and still see a replacement).
    ///
    /// One lookup rather than three — all of it lives on the same row, and this
    /// is the most-hit public read on the server. Never selects the bytes.
    /// Defaults to 1500/1500 with no photo for a wallet never seen before.
    pub async fn player_card(&self, wallet: &str) -> Result<PlayerCard> {
        let row: Option<(f32, f32, Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as(
            r#"SELECT rating, casual_rating,
                      CASE WHEN avatar_data IS NOT NULL AND avatar_mime IS NOT NULL
                           THEN avatar_updated_at END
                 FROM users
                WHERE lower(wallet)=$1"#,
        )
        .bind(wallet.to_lowercase())
        .fetch_optional(&self.pool)
        .await?;
        let (rating, casual_rating, avatar_updated_at) = row.unwrap_or((1500.0, 1500.0, None));
        Ok(PlayerCard {
            rating,
            casual_rating,
            avatar_updated_at,
        })
    }

    /// Aggregate W/L/D + net winnings (USDC base units) for an address over
    /// finished games, split by ladder. `address` is matched case-insensitively.
    ///
    /// One round trip: `GROUP BY rated` returns at most two rows and the fold
    /// below fills in the ladder the player hasn't touched. Doing it here rather
    /// than in the handler keeps the fold under the DB-backed tests.
    pub async fn player_stats(&self, address: &str) -> Result<PlayerStats> {
        let addr = address.to_lowercase();
        let rows = sqlx::query_as::<_, PlayerStatsBucketRow>(
            r#"SELECT
                 rated,
                 COUNT(*) AS games,
                 COUNT(*) FILTER (WHERE (lower(white_wallet)=$1 AND result='white')
                                     OR (lower(black_wallet)=$1 AND result='black')) AS wins,
                 COUNT(*) FILTER (WHERE (lower(white_wallet)=$1 AND result='black')
                                     OR (lower(black_wallet)=$1 AND result='white')) AS losses,
                 COUNT(*) FILTER (WHERE result='draw') AS draws,
                 COALESCE(SUM(CASE
                   WHEN (lower(white_wallet)=$1 AND result='white')
                     OR (lower(black_wallet)=$1 AND result='black') THEN stake
                   WHEN (lower(white_wallet)=$1 AND result='black')
                     OR (lower(black_wallet)=$1 AND result='white') THEN -stake
                   ELSE 0 END), 0) AS net
               FROM games
               WHERE status='finished' AND (lower(white_wallet)=$1 OR lower(black_wallet)=$1)
               GROUP BY rated"#,
        )
        .bind(&addr)
        .fetch_all(&self.pool)
        .await?;
        let mut stats = PlayerStats::default();
        for r in rows {
            let bucket = PlayerStatsRow {
                games: r.games,
                wins: r.wins,
                losses: r.losses,
                draws: r.draws,
                net: r.net,
            };
            if r.rated {
                stats.ranked = bucket;
            } else {
                stats.casual = bucket;
            }
        }
        stats.all = stats.casual.plus(&stats.ranked);
        Ok(stats)
    }

    /// Current ranked rating for an address (1500 if unseen).
    pub async fn player_rating(&self, address: &str) -> Result<f32> {
        self.rating_on(address, true).await
    }

    /// Current rating on one ladder (1500 if unseen). The column name comes
    /// from this literal and never from input, so the interpolation below is
    /// not a query-building surface.
    pub async fn rating_on(&self, address: &str, rated: bool) -> Result<f32> {
        let col = if rated { "rating" } else { "casual_rating" };
        let r: Option<f32> =
            sqlx::query_scalar(&format!("SELECT {col} FROM users WHERE lower(wallet)=$1"))
                .bind(address.to_lowercase())
                .fetch_optional(&self.pool)
                .await?;
        Ok(r.unwrap_or(1500.0))
    }

    /// The ranked ladder, best first. Only players with at least one finished
    /// RANKED game (two known wallets) are included, so freshly-signed-in
    /// wallets sitting at the default 1500 don't pad the board. Powers the lobby
    /// leaderboard.
    ///
    /// `rated` is part of that filter, not decoration: this board renders
    /// `users.rating`, which only ranked games move, so counting casual games
    /// beside it would publish a number the rating didn't come from — and would
    /// put a wallet that has only ever played free games onto the ranked ladder
    /// at 1500, which is the padding the filter exists to prevent.
    pub async fn leaderboard(&self, limit: i64) -> Result<Vec<LeaderboardRow>> {
        // Count finished ranked games per wallet in a single GROUP BY pass over
        // `games` (each qualifying game contributes one row per side), then join
        // the counts back to `users`. This is O(users + games) — the old form ran
        // a correlated COUNT(*) per user (O(users × games)). COUNT(DISTINCT id)
        // keeps a hypothetical self-play game (white == black) counted once, and
        // the inner join makes the "at least one game" filter implicit.
        let rows = sqlx::query_as::<_, LeaderboardRow>(
            r#"SELECT u.wallet AS wallet, u.rating AS rating, gc.games AS games
               FROM users u
               JOIN (
                 SELECT wallet, COUNT(DISTINCT game_id) AS games
                 FROM (
                   SELECT id AS game_id, lower(white_wallet) AS wallet FROM games
                     WHERE status='finished' AND result IS NOT NULL AND rated
                       AND white_wallet IS NOT NULL AND black_wallet IS NOT NULL
                   UNION ALL
                   SELECT id AS game_id, lower(black_wallet) AS wallet FROM games
                     WHERE status='finished' AND result IS NOT NULL AND rated
                       AND white_wallet IS NOT NULL AND black_wallet IS NOT NULL
                 ) sides
                 GROUP BY wallet
               ) gc ON gc.wallet = lower(u.wallet)
               ORDER BY u.rating DESC, gc.games DESC
               LIMIT $1"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Recent finished games involving an address (most recent first).
    ///
    /// `rated` filters to one ladder; `None` returns both. The filter belongs
    /// here rather than in the client because `limit` is applied after it:
    /// partitioning one 50-row page in the browser answers "the ranked games
    /// among your last 50", not "your last 50 ranked games", and those differ a
    /// lot for anyone whose recent play is lopsided.
    pub async fn player_games(
        &self,
        address: &str,
        limit: i64,
        rated: Option<bool>,
    ) -> Result<Vec<PlayerGameRow>> {
        let rows = sqlx::query_as::<_, PlayerGameRow>(
            r#"SELECT g.id, g.mode, g.white_wallet, g.black_wallet, g.result,
                      g.stake, g.result_reason, g.finished_at, g.rated,
                      (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) AS moves
               FROM games g
               WHERE g.status='finished'
                 AND (lower(g.white_wallet)=$1 OR lower(g.black_wallet)=$1)
                 AND ($3::BOOLEAN IS NULL OR g.rated = $3)
               ORDER BY g.finished_at DESC NULLS LAST LIMIT $2"#,
        )
        .bind(address.to_lowercase())
        .bind(limit)
        .bind(rated)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Update Elo for a finished game with two known wallets (no-op for
    /// anonymous games). K=24.
    ///
    /// The game's own `rated` flag picks the ladder: a staked game (or a buy-in
    /// tournament pairing) moves `users.rating`, everything else moves
    /// `users.casual_rating`. The two never mix, which is what lets the lobby
    /// keep promising that a free game doesn't touch your ranked Elo.
    pub async fn update_ratings(&self, game_id: Uuid) -> Result<()> {
        /// (white_wallet, black_wallet, result, rated) — everything rating a
        /// game needs, and all of it nullable except the ladder.
        type RatedGame = (Option<String>, Option<String>, Option<String>, bool);
        let row: Option<RatedGame> = sqlx::query_as(
            "SELECT white_wallet, black_wallet, result, rated FROM games WHERE id=$1",
        )
        .bind(game_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((Some(white), Some(black), Some(result), rated)) = row else {
            return Ok(()); // anonymous seat — nothing to rate
        };
        // Never rate a wallet against itself. A stake makes this impossible
        // (identical seats are rejected before escrow), but a casual game
        // carries no such check, and one wallet on both seats would otherwise
        // farm rating: the two updates apply in order and the second wins.
        if white.eq_ignore_ascii_case(&black) {
            return Ok(());
        }
        let score_white = match result.as_str() {
            "white" => 1.0_f64,
            "black" => 0.0,
            "draw" => 0.5,
            _ => return Ok(()),
        };
        self.upsert_user(&white).await?;
        self.upsert_user(&black).await?;
        let ra = self.rating_on(&white, rated).await? as f64;
        let rb = self.rating_on(&black, rated).await? as f64;
        let expected_white = 1.0 / (1.0 + 10f64.powf((rb - ra) / 400.0));
        const K: f64 = 24.0;
        let new_a = ra + K * (score_white - expected_white);
        let new_b = rb + K * ((1.0 - score_white) - (1.0 - expected_white));
        // Literal, never input — see `rating_on`.
        let col = if rated { "rating" } else { "casual_rating" };
        let update = format!("UPDATE users SET {col}=$2 WHERE lower(wallet)=lower($1)");
        sqlx::query(&update)
            .bind(&white)
            .bind(new_a as f32)
            .execute(&self.pool)
            .await?;
        sqlx::query(&update)
            .bind(&black)
            .bind(new_b as f32)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Recent finished games for a simple history view.
    pub async fn recent_games(&self, limit: i64) -> Result<Vec<GameRow>> {
        let rows = sqlx::query_as::<_, GameRow>(
            "SELECT id, mode, status, result, result_reason, pgn FROM games
             ORDER BY created_at DESC LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn game_lifecycle_roundtrip() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        let id = Uuid::new_v4();
        db.create_game(
            id,
            "park",
            false,
            Some("0xwhite"),
            Some("0xblack"),
            Tc {
                initial_ms: 60000,
                increment_ms: 1000,
            },
            None,
            [Some("Stockfish 18 · Sharp"), None],
        )
        .await?;
        db.set_game_active(id).await?;
        db.append_move(id, 1, "e2e4", "e4", 60000, 60000).await?;
        db.append_move(id, 2, "e7e5", "e5", 60000, 60000).await?;
        db.finish_and_enqueue(
            id,
            "white",
            "checkmate",
            "deadbeef",
            None,
            "1. e4 e5",
            None,
            false,
        )
        .await?;

        // Engines must survive to the public detail view — the whole point of
        // migration 0013 is that a finished game can say what played it.
        let detail = db.game_detail(id).await?.expect("detail exists");
        assert_eq!(detail.white_engine.as_deref(), Some("Stockfish 18 · Sharp"));
        assert_eq!(detail.black_engine, None);

        let g = db.get_game(id).await?.expect("game exists");
        assert_eq!(g.status, "finished");
        assert_eq!(g.result.as_deref(), Some("white"));
        assert_eq!(g.pgn.as_deref(), Some("1. e4 e5"));
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn avatar_roundtrip() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // Mixed case on purpose: every read path folds through lower(wallet),
        // so a photo set from a checksummed address must be found by the
        // lowercased one the API serves and vice versa.
        let tag = Uuid::new_v4().simple().to_string();
        let wallet = format!("0xAbC_{tag}");

        assert!(
            db.avatar(&wallet).await?.is_none(),
            "no photo to begin with"
        );
        // Unseen wallet: the default rating, and nothing for the client to
        // build an image URL out of.
        let card = db.player_card(&wallet).await?;
        assert_eq!(
            (card.rating, card.casual_rating, card.avatar_updated_at),
            (1500.0, 1500.0, None)
        );

        // Sets a photo for a wallet that has never played — no users row yet.
        db.set_avatar(&wallet, "image/jpeg", b"\xff\xd8\xffbytes")
            .await?;
        let got = db.avatar(&wallet.to_lowercase()).await?.expect("photo");
        assert_eq!(got.mime, "image/jpeg");
        assert_eq!(got.data, b"\xff\xd8\xffbytes");
        let first = db
            .player_card(&wallet)
            .await?
            .avatar_updated_at
            .expect("timestamp");

        // Replacing keeps one row and moves the version forward, which is what
        // busts the cached image URL.
        db.set_avatar(&wallet, "image/png", b"\x89PNGnew").await?;
        let got = db.avatar(&wallet).await?.expect("photo");
        assert_eq!(got.mime, "image/png");
        assert_eq!(got.data, b"\x89PNGnew");
        assert!(
            db.player_card(&wallet)
                .await?
                .avatar_updated_at
                .expect("timestamp")
                >= first
        );

        db.clear_avatar(&wallet).await?;
        assert!(db.avatar(&wallet).await?.is_none(), "cleared");
        assert!(
            db.player_card(&wallet).await?.avatar_updated_at.is_none(),
            "and no version left"
        );
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn leaderboard_counts_and_ordering() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // Unique wallets per run so the assertions don't collide with other data.
        let tag = Uuid::new_v4().simple().to_string();
        let alice = format!("0xA_{tag}"); // mixed case on purpose (see below)
        let bob = format!("0xb_{tag}");
        let carol = format!("0xc_{tag}"); // signs in but never finishes a game
        let dave = format!("0xd_{tag}"); // plays, but only free games

        db.upsert_user(&alice).await?;
        db.upsert_user(&bob).await?;
        db.upsert_user(&carol).await?;
        db.upsert_user(&dave).await?;

        // Two finished RANKED games between alice and bob, alice winning both
        // (so her Elo ends above bob's — deterministic ordering, no test-only
        // setter). The second game stores alice's wallet lowercased, so the
        // case-insensitive count must fold the two together.
        let finish = |white: String, black: String, result: &'static str, rated: bool| {
            let db = db.clone();
            async move {
                let id = Uuid::new_v4();
                db.create_game(
                    id,
                    "park",
                    rated,
                    Some(&white),
                    Some(&black),
                    Tc {
                        initial_ms: 60000,
                        increment_ms: 1000,
                    },
                    None,
                    [None, None],
                )
                .await?;
                db.set_game_active(id).await?;
                db.finish_and_enqueue(
                    id,
                    result,
                    "checkmate",
                    "hash",
                    None,
                    "1. e4 e5",
                    None,
                    false,
                )
                .await?;
                db.update_ratings(id).await?;
                Ok::<_, anyhow::Error>(())
            }
        };
        finish(alice.clone(), bob.clone(), "white", true).await?; // alice (white) wins
        finish(bob.clone(), alice.to_lowercase(), "black", true).await?; // alice (black) wins
                                                                         // Casual games: they exist, they're finished, they have two known
                                                                         // wallets — and none of that puts anyone on the ranked ladder.
        finish(dave.clone(), alice.clone(), "white", false).await?;
        finish(alice.clone(), dave.clone(), "white", false).await?;

        // A pending (unfinished) game must not count.
        let pending = Uuid::new_v4();
        db.create_game(
            pending,
            "park",
            true,
            Some(&alice),
            Some(&bob),
            Tc {
                initial_ms: 60000,
                increment_ms: 1000,
            },
            None,
            [None, None],
        )
        .await?;

        let board = db.leaderboard(100).await?;
        let get = |addr: &str| {
            let addr = addr.to_lowercase();
            board.iter().find(move |r| r.wallet.to_lowercase() == addr)
        };

        let a = get(&alice).expect("alice on the board");
        let b = get(&bob).expect("bob on the board");
        assert_eq!(
            a.games, 2,
            "her two ranked games count (case-folded), her two casual ones don't"
        );
        assert_eq!(b.games, 2, "both finished games count for bob");
        assert!(
            get(&carol).is_none(),
            "no finished games => not on the board"
        );
        assert!(
            get(&dave).is_none(),
            "only casual games => no ranked ladder entry, not a free 1500"
        );

        // Ordered by rating desc: alice (won both -> higher Elo) before bob.
        let ai = board
            .iter()
            .position(|r| r.wallet.to_lowercase() == alice.to_lowercase());
        let bi = board
            .iter()
            .position(|r| r.wallet.to_lowercase() == bob.to_lowercase());
        assert!(ai < bi, "higher rating ranks first");
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn an_unstaked_game_shows_up_in_both_players_history() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // A casual game: no wager, no escrow addresses — only the two wallets
        // that sat down. That is exactly the row the server used to write with
        // NULL wallets, which made a played game invisible everywhere below.
        let tag = Uuid::new_v4().simple().to_string();
        let alice = format!("0xA_{tag}"); // mixed case: every read folds to lower()
        let bob = format!("0xb_{tag}");
        let id = Uuid::new_v4();
        db.create_game(
            id,
            "park",
            false, // <- casual
            Some(&alice),
            Some(&bob),
            Tc {
                initial_ms: 60000,
                increment_ms: 1000,
            },
            None, // <- the point: no wager
            [None, None],
        )
        .await?;
        db.set_game_active(id).await?;
        db.append_move(id, 1, "e2e4", "e4", 60000, 60000).await?;
        db.append_move(id, 2, "e7e5", "e5", 60000, 60000).await?;
        db.finish_and_enqueue(
            id,
            "white",
            "checkmate",
            "hash",
            None,
            "1. e4 e5",
            None,
            false,
        )
        .await?;
        db.update_ratings(id).await?;

        let mine = db.player_games(&alice.to_lowercase(), 50, None).await?;
        let row = mine
            .iter()
            .find(|g| g.id == id)
            .expect("in alice's history");
        assert_eq!(row.result.as_deref(), Some("white"));
        assert_eq!(row.stake, None, "casual game, no stake");
        assert!(!row.rated, "and it counted for the casual ladder");
        assert_eq!(row.moves, 2);
        assert!(
            db.player_games(&bob, 50, None)
                .await?
                .iter()
                .any(|g| g.id == id),
            "and in bob's"
        );

        // The same row is what the record reads — under the casual bucket, and
        // in the combined view, but never under ranked.
        let stats = db.player_stats(&alice).await?;
        assert_eq!(
            (stats.casual.games, stats.casual.wins, stats.casual.losses),
            (1, 1, 0)
        );
        assert_eq!((stats.all.games, stats.all.wins), (1, 1));
        assert_eq!(
            stats.ranked,
            PlayerStatsRow::default(),
            "nothing ranked here"
        );
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn one_wallet_on_both_seats_is_not_rated() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // Nothing stops one signed-in wallet from taking both casual seats (a
        // stake would be rejected before escrow, but there is no stake here).
        // Rating it would let anyone farm Elo: the two updates apply in order
        // and the winner's write lands last.
        let wallet = format!("0xS_{}", Uuid::new_v4().simple());
        let id = Uuid::new_v4();
        db.create_game(
            id,
            "park",
            false,
            Some(&wallet),
            Some(&wallet),
            Tc {
                initial_ms: 60000,
                increment_ms: 1000,
            },
            None,
            [None, None],
        )
        .await?;
        db.set_game_active(id).await?;
        db.finish_and_enqueue(
            id,
            "white",
            "checkmate",
            "hash",
            None,
            "1. e4 e5",
            None,
            false,
        )
        .await?;
        db.update_ratings(id).await?;

        assert_eq!(
            db.player_rating(&wallet).await?,
            1500.0,
            "unrated self-play"
        );
        assert_eq!(
            db.rating_on(&wallet, false).await?,
            1500.0,
            "and the casual ladder is not the loophole either"
        );
        Ok(())
    }

    /// Play one finished game on a ladder and hand back both wallets' ratings.
    #[cfg(test)]
    async fn played(db: &Db, white: &str, black: &str, rated: bool, result: &str) -> Result<Uuid> {
        let id = Uuid::new_v4();
        db.create_game(
            id,
            "park",
            rated,
            Some(white),
            Some(black),
            Tc {
                initial_ms: 60000,
                increment_ms: 1000,
            },
            None,
            [None, None],
        )
        .await?;
        db.set_game_active(id).await?;
        db.finish_and_enqueue(
            id,
            result,
            "checkmate",
            "hash",
            None,
            "1. e4 e5",
            None,
            false,
        )
        .await?;
        db.update_ratings(id).await?;
        Ok(id)
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn casual_and_ranked_elo_are_independent() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // The promise the lobby has always made and could not keep: a free game
        // does not touch your ranked Elo. Two ladders, one flag, no crossover.
        let tag = Uuid::new_v4().simple().to_string();
        let alice = format!("0xA_{tag}");
        let bob = format!("0xb_{tag}");

        played(&db, &alice, &bob, false, "white").await?;
        assert!(
            db.rating_on(&alice, false).await? > 1500.0,
            "casual win moves casual Elo"
        );
        assert!(db.rating_on(&bob, false).await? < 1500.0);
        assert_eq!(
            db.player_rating(&alice).await?,
            1500.0,
            "and NOT the ranked one"
        );
        assert_eq!(db.player_rating(&bob).await?, 1500.0);

        // The mirror: a ranked game leaves the casual ladder where it was.
        let casual_before = db.rating_on(&alice, false).await?;
        played(&db, &alice, &bob, true, "white").await?;
        assert!(
            db.player_rating(&alice).await? > 1500.0,
            "ranked win moves ranked Elo"
        );
        assert!(db.player_rating(&bob).await? < 1500.0);
        assert_eq!(
            db.rating_on(&alice, false).await?,
            casual_before,
            "casual untouched"
        );
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn a_buy_in_tournament_game_is_ranked_without_a_stake() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // Why `rated` is a column and not `stake IS NOT NULL`: a tournament
        // pairing carries no stake of its own (the buy-in pool settles
        // separately), and deriving rankedness from the stake would file every
        // paid tournament under casual.
        let tag = Uuid::new_v4().simple().to_string();
        let alice = format!("0xA_{tag}");
        let bob = format!("0xb_{tag}");
        let id = Uuid::new_v4();
        db.create_game(
            id,
            "tournament",
            true, // ranked...
            Some(&alice),
            Some(&bob),
            Tc {
                initial_ms: 60000,
                increment_ms: 1000,
            },
            None, // ...with no wager on the game itself
            [None, None],
        )
        .await?;
        db.set_game_active(id).await?;
        db.finish_and_enqueue(
            id,
            "white",
            "checkmate",
            "hash",
            None,
            "1. e4 e5",
            None,
            false,
        )
        .await?;
        db.update_ratings(id).await?;

        assert!(
            db.player_rating(&alice).await? > 1500.0,
            "moves the ranked ladder"
        );
        assert_eq!(
            db.rating_on(&alice, false).await?,
            1500.0,
            "not the casual one"
        );
        let stats = db.player_stats(&alice).await?;
        assert_eq!(stats.ranked.games, 1);
        assert_eq!(stats.casual.games, 0);
        assert_eq!(
            stats.ranked.net,
            Decimal::ZERO,
            "ranked, but nothing was staked"
        );
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn player_stats_buckets_split_and_sum() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        let tag = Uuid::new_v4().simple().to_string();
        let me = format!("0xA_{tag}");
        let opp = format!("0xb_{tag}");
        played(&db, &me, &opp, true, "white").await?; // ranked win
        played(&db, &me, &opp, true, "black").await?; // ranked loss
        played(&db, &me, &opp, false, "white").await?; // casual win
        played(&db, &me, &opp, false, "white").await?; // casual win
        played(&db, &me, &opp, false, "draw").await?; // casual draw

        let s = db.player_stats(&me).await?;
        assert_eq!((s.ranked.games, s.ranked.wins, s.ranked.losses), (2, 1, 1));
        assert_eq!((s.casual.games, s.casual.wins, s.casual.draws), (3, 2, 1));
        assert_eq!(s.all.games, 5, "the All view is the two summed");
        assert_eq!(s.all.wins, s.ranked.wins + s.casual.wins);
        assert_eq!(s.casual.net, Decimal::ZERO, "free games stake nothing");
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn player_stats_is_all_zeroes_for_a_wallet_with_no_games() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        // `GROUP BY` returns NO row for a ladder the player has never touched,
        // so the fold has to invent the zeroes. The profile must render `0`,
        // not a blank tile.
        let s = db
            .player_stats(&format!("0xZ_{}", Uuid::new_v4().simple()))
            .await?;
        assert_eq!(s.all, PlayerStatsRow::default());
        assert_eq!(s.casual, PlayerStatsRow::default());
        assert_eq!(s.ranked, PlayerStatsRow::default());
        Ok(())
    }

    // Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn player_games_filter_selects_one_ladder() -> Result<()> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return Ok(());
        };
        let db = Db::connect(&url).await?;
        db.migrate().await?;

        let tag = Uuid::new_v4().simple().to_string();
        let me = format!("0xA_{tag}");
        let opp = format!("0xb_{tag}");
        let ranked = played(&db, &me, &opp, true, "white").await?;
        played(&db, &me, &opp, false, "white").await?;
        played(&db, &me, &opp, false, "black").await?;

        let mine = |f| {
            let db = db.clone();
            let me = me.clone();
            async move { db.player_games(&me, 50, f).await }
        };
        assert_eq!(mine(None).await?.len(), 3, "no filter: both ladders");
        let only_ranked = mine(Some(true)).await?;
        assert_eq!(only_ranked.len(), 1);
        assert_eq!(only_ranked[0].id, ranked);
        assert!(only_ranked.iter().all(|g| g.rated));
        let only_casual = mine(Some(false)).await?;
        assert_eq!(only_casual.len(), 2);
        assert!(only_casual.iter().all(|g| !g.rated));
        Ok(())
    }
}
