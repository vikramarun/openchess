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

/// Optional on-chain wager attached to a game.
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

#[derive(Debug, sqlx::FromRow)]
pub struct PlayerStatsRow {
    pub games: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    pub net: Decimal,
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
}

#[derive(Debug, sqlx::FromRow)]
pub struct TournamentRow {
    pub id: Uuid,
    pub buy_in: Option<String>,
    pub players: serde_json::Value,
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
    pub result: Option<String>,
    pub result_reason: Option<String>,
    pub result_hash: Option<String>,
    pub settlement_status: String,
    pub time_initial_ms: i64,
    pub time_increment_ms: i64,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
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
        white_wallet: Option<&str>,
        black_wallet: Option<&str>,
        tc: Tc,
        wager: Option<&Wager>,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO games
               (id, mode, status, white_wallet, black_wallet,
                time_initial_ms, time_increment_ms, white_addr, black_addr, stake,
                settlement_status)
               VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10)"#,
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
                   result_hash=$4, pgn=$5, finished_at=now()
               WHERE id=$1 AND status NOT IN ('finished','aborted')"#,
        )
        .bind(game_id)
        .bind(result)
        .bind(reason)
        .bind(result_hash)
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

    /// Enqueue a completed tournament's payout for durable on-chain settlement.
    pub async fn enqueue_tournament_settlement(
        &self,
        tid: Uuid,
        mode: &str,
        payload: serde_json::Value,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO tournament_outbox (id, tid, mode, payload) VALUES ($1,$2,$3,$4)",
        )
        .bind(Uuid::new_v4())
        .bind(tid)
        .bind(mode)
        .bind(payload)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn claim_tournament_settlements(&self, limit: i64) -> Result<Vec<TournamentOutboxRow>> {
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
    pub async fn upsert_tournament(
        &self,
        id: Uuid,
        name: &str,
        buy_in: Option<&str>,
        initial_secs: i64,
        increment_secs: i64,
        status: &str,
        players: &serde_json::Value,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO tournaments (id, name, buy_in, initial_secs, increment_secs, status, players)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, players=EXCLUDED.players"#,
        )
        .bind(id)
        .bind(name)
        .bind(buy_in)
        .bind(initial_secs)
        .bind(increment_secs)
        .bind(status)
        .bind(players)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Buy-in tournaments the wallet entered that have reached a finished state
    /// (a payout or refund may be collectable on-chain). DB-sourced so it
    /// survives the restart that wipes the in-memory tournaments map. `address`
    /// must be lowercased (entrants are stored lowercased).
    pub async fn claimable_tournaments(&self, address: &str) -> Result<Vec<ClaimableTournamentRow>> {
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
        let rows = sqlx::query_as::<_, TournamentRow>(
            "SELECT id, buy_in, players FROM tournaments WHERE status='running'",
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
            r#"SELECT id, mode, status, white_wallet, black_wallet, stake, result,
                      result_reason, result_hash, settlement_status,
                      time_initial_ms, time_increment_ms, finished_at
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

    /// Aggregate W/L/D + net winnings (USDC base units) for an address over
    /// finished games. `address` is matched case-insensitively.
    pub async fn player_stats(&self, address: &str) -> Result<PlayerStatsRow> {
        let addr = address.to_lowercase();
        let row = sqlx::query_as::<_, PlayerStatsRow>(
            r#"SELECT
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
               WHERE status='finished' AND (lower(white_wallet)=$1 OR lower(black_wallet)=$1)"#,
        )
        .bind(&addr)
        .fetch_one(&self.pool)
        .await?;
        Ok(row)
    }

    /// Current rating for an address (1500 if unseen).
    pub async fn player_rating(&self, address: &str) -> Result<f32> {
        let r: Option<f32> =
            sqlx::query_scalar("SELECT rating FROM users WHERE lower(wallet)=$1")
                .bind(address.to_lowercase())
                .fetch_optional(&self.pool)
                .await?;
        Ok(r.unwrap_or(1500.0))
    }

    /// Top-rated players, best first. Only players with at least one finished
    /// rated game (two known wallets) are included, so freshly-signed-in wallets
    /// sitting at the default 1500 don't pad the board. Powers the lobby
    /// leaderboard.
    pub async fn leaderboard(&self, limit: i64) -> Result<Vec<LeaderboardRow>> {
        // Count finished rated games per wallet in a single GROUP BY pass over
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
                     WHERE status='finished' AND result IS NOT NULL
                       AND white_wallet IS NOT NULL AND black_wallet IS NOT NULL
                   UNION ALL
                   SELECT id AS game_id, lower(black_wallet) AS wallet FROM games
                     WHERE status='finished' AND result IS NOT NULL
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
    pub async fn player_games(&self, address: &str, limit: i64) -> Result<Vec<PlayerGameRow>> {
        let rows = sqlx::query_as::<_, PlayerGameRow>(
            r#"SELECT g.id, g.mode, g.white_wallet, g.black_wallet, g.result,
                      g.stake, g.result_reason, g.finished_at,
                      (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) AS moves
               FROM games g
               WHERE g.status='finished'
                 AND (lower(g.white_wallet)=$1 OR lower(g.black_wallet)=$1)
               ORDER BY g.finished_at DESC NULLS LAST LIMIT $2"#,
        )
        .bind(address.to_lowercase())
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Update Elo ratings for a finished game with two known wallets (no-op for
    /// casual/anonymous games). K=24.
    pub async fn update_ratings(&self, game_id: Uuid) -> Result<()> {
        let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT white_wallet, black_wallet, result FROM games WHERE id=$1",
        )
        .bind(game_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some((Some(white), Some(black), Some(result))) = row else {
            return Ok(()); // anonymous/casual game — nothing to rate
        };
        let score_white = match result.as_str() {
            "white" => 1.0_f64,
            "black" => 0.0,
            "draw" => 0.5,
            _ => return Ok(()),
        };
        self.upsert_user(&white).await?;
        self.upsert_user(&black).await?;
        let ra = self.player_rating(&white).await? as f64;
        let rb = self.player_rating(&black).await? as f64;
        let expected_white = 1.0 / (1.0 + 10f64.powf((rb - ra) / 400.0));
        const K: f64 = 24.0;
        let new_a = ra + K * (score_white - expected_white);
        let new_b = rb + K * ((1.0 - score_white) - (1.0 - expected_white));
        sqlx::query("UPDATE users SET rating=$2 WHERE lower(wallet)=lower($1)")
            .bind(&white)
            .bind(new_a as f32)
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE users SET rating=$2 WHERE lower(wallet)=lower($1)")
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
            Some("0xwhite"),
            Some("0xblack"),
            Tc { initial_ms: 60000, increment_ms: 1000 },
            None,
        )
        .await?;
        db.set_game_active(id).await?;
        db.append_move(id, 1, "e2e4", "e4", 60000, 60000).await?;
        db.append_move(id, 2, "e7e5", "e5", 60000, 60000).await?;
        db.finish_and_enqueue(id, "white", "checkmate", "deadbeef", "1. e4 e5", None, false)
            .await?;

        let g = db.get_game(id).await?.expect("game exists");
        assert_eq!(g.status, "finished");
        assert_eq!(g.result.as_deref(), Some("white"));
        assert_eq!(g.pgn.as_deref(), Some("1. e4 e5"));
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

        db.upsert_user(&alice).await?;
        db.upsert_user(&bob).await?;
        db.upsert_user(&carol).await?;

        // Two finished games between alice and bob, alice winning both (so her
        // Elo ends above bob's — deterministic ordering, no test-only setter).
        // The second game stores alice's wallet lowercased, so the case-insensitive
        // count must fold the two together.
        let finish = |white: String, black: String, result: &'static str| {
            let db = db.clone();
            async move {
                let id = Uuid::new_v4();
                db.create_game(
                    id,
                    "park",
                    Some(&white),
                    Some(&black),
                    Tc { initial_ms: 60000, increment_ms: 1000 },
                    None,
                )
                .await?;
                db.set_game_active(id).await?;
                db.finish_and_enqueue(id, result, "checkmate", "hash", "1. e4 e5", None, false)
                    .await?;
                db.update_ratings(id).await?;
                Ok::<_, anyhow::Error>(())
            }
        };
        finish(alice.clone(), bob.clone(), "white").await?; // alice (white) wins
        finish(bob.clone(), alice.to_lowercase(), "black").await?; // alice (black) wins

        // A pending (unfinished) game must not count.
        let pending = Uuid::new_v4();
        db.create_game(
            pending,
            "park",
            Some(&alice),
            Some(&bob),
            Tc { initial_ms: 60000, increment_ms: 1000 },
            None,
        )
        .await?;

        let board = db.leaderboard(100).await?;
        let get = |addr: &str| {
            let addr = addr.to_lowercase();
            board.iter().find(move |r| r.wallet.to_lowercase() == addr)
        };

        let a = get(&alice).expect("alice on the board");
        let b = get(&bob).expect("bob on the board");
        assert_eq!(a.games, 2, "both finished games count for alice (case-folded)");
        assert_eq!(b.games, 2, "both finished games count for bob");
        assert!(get(&carol).is_none(), "no finished games => not on the board");

        // Ordered by rating desc: alice (won both -> higher Elo) before bob.
        let ai = board.iter().position(|r| r.wallet.to_lowercase() == alice.to_lowercase());
        let bi = board.iter().position(|r| r.wallet.to_lowercase() == bob.to_lowercase());
        assert!(ai < bi, "higher rating ranks first");
        Ok(())
    }
}
