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

    /// Mark a game finished with its result + final PGN.
    pub async fn finish_game(
        &self,
        game_id: Uuid,
        result: &str,
        reason: &str,
        result_hash: &str,
        pgn: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"UPDATE games
               SET status='finished', result=$2, result_reason=$3,
                   result_hash=$4, pgn=$5, finished_at=now()
               WHERE id=$1"#,
        )
        .bind(game_id)
        .bind(result)
        .bind(reason)
        .bind(result_hash)
        .bind(pgn)
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
        sqlx::query(
            r#"UPDATE games
               SET status='finished', result=$2, result_reason=$3,
                   result_hash=$4, pgn=$5, finished_at=now()
               WHERE id=$1"#,
        )
        .bind(game_id)
        .bind(result)
        .bind(reason)
        .bind(result_hash)
        .bind(pgn)
        .execute(&mut *tx)
        .await?;

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
        db.finish_game(id, "white", "checkmate", "deadbeef", "1. e4 e5").await?;

        let g = db.get_game(id).await?.expect("game exists");
        assert_eq!(g.status, "finished");
        assert_eq!(g.result.as_deref(), Some("white"));
        assert_eq!(g.pgn.as_deref(), Some("1. e4 e5"));
        Ok(())
    }
}
