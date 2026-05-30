//! Shared wire types for the chess wagering platform.
//!
//! These types are the single source of truth for the WebSocket protocol spoken
//! between the game server, the bring-your-own-engine client, and (mirrored in
//! TypeScript) the web frontend. They are deliberately transport-agnostic: just
//! serde-(de)serializable data with no IO.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Wire protocol version. Bump on breaking changes.
pub const PROTOCOL_VERSION: u8 = 1;

pub type GameId = Uuid;

/// Side to move / player color.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    White,
    Black,
}

impl Color {
    pub fn opposite(self) -> Color {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }
}

/// A time control: base time plus per-move increment (Fischer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeControl {
    pub initial_ms: u64,
    pub increment_ms: u64,
}

/// Authoritative clock snapshot. Always produced by the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Clock {
    pub white_ms: u64,
    pub black_ms: u64,
    pub increment_ms: u64,
}

/// A wager attached to a game. `amount` is in the smallest UI unit (e.g. USDC),
/// kept as a decimal so we never use floats for money.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wager {
    pub amount: Decimal,
    pub currency: String,
    /// Opaque reference to the on-chain / ledger escrow record once locked.
    pub escrow_ref: Option<String>,
}

/// Why a game ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameEndReason {
    Checkmate,
    Resignation,
    Timeout,
    Stalemate,
    InsufficientMaterial,
    FiftyMoveRule,
    Threefold,
    /// Game aborted before it counted (e.g. a player never connected).
    Aborted,
}

/// The authoritative outcome of a game. `winner == None` means a draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameResult {
    pub winner: Option<Color>,
    pub reason: GameEndReason,
}

impl GameResult {
    pub fn is_draw(&self) -> bool {
        self.winner.is_none()
    }
}

/// Lightweight description of an opponent shown to a player/spectator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpponentInfo {
    pub name: String,
    /// Self-declared engine name (informational only — not verified).
    pub declared_engine: Option<String>,
}

// ---------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------

/// Messages sent from the server to a connected client (player or spectator).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent right after a successful `Hello`.
    Welcome {
        session_id: Uuid,
        server_time_ms: u64,
    },
    /// A pairing was made; the player should spawn their engine and send `Ready`.
    MatchFound {
        game_id: GameId,
        color: Color,
        opponent: OpponentInfo,
        time_control: TimeControl,
        start_fen: String,
        wager: Option<Wager>,
    },
    /// The game is beginning.
    GameStart {
        game_id: GameId,
        start_fen: String,
        your_color: Color,
        clock: Clock,
    },
    /// It is this client's turn. Authoritative position + clock + deadline.
    YourTurn {
        game_id: GameId,
        ply: u32,
        position_fen: String,
        /// Full move history in UCI long-algebraic, for engine `position` cmd.
        moves_uci: Vec<String>,
        clock: Clock,
        /// Absolute server time (ms epoch) by which the move must arrive.
        deadline_server_ms: u64,
    },
    /// A submitted move was accepted; carries the authoritative clock after it.
    MoveAccepted {
        game_id: GameId,
        ply: u32,
        clock: Clock,
    },
    /// A submitted move was rejected (illegal / out of turn / late).
    MoveRejected {
        game_id: GameId,
        ply: u32,
        reason: String,
    },
    /// Informational mirror of the opponent's move (also used for spectators).
    OpponentMoved {
        game_id: GameId,
        ply: u32,
        uci: String,
        clock: Clock,
    },
    /// Periodic authoritative clock broadcast.
    ClockSync {
        game_id: GameId,
        clock: Clock,
        server_time_ms: u64,
    },
    /// The game is over. `server_sig` is the oracle signature over the result.
    GameOver {
        game_id: GameId,
        result: GameResult,
        final_pgn: String,
        /// Hash committing to the full game (move log + metadata).
        result_hash: String,
        /// Oracle signature over the canonical result; settlement input.
        server_sig: Option<String>,
    },
    /// A protocol or auth error.
    Error { code: String, message: String },
}

// ---------------------------------------------------------------------------
// Client -> server messages
// ---------------------------------------------------------------------------

/// Capabilities advertised by a client on connect.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientCapabilities {
    /// Whether the client signs each move (non-repudiation, optional).
    pub move_signing: bool,
}

/// Messages sent from a client to the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Authentication + version handshake. The token is a one-time launch token
    /// (for a player) or a spectator/session token.
    Hello {
        token: String,
        client_version: String,
        capabilities: ClientCapabilities,
    },
    /// Client has spawned its engine and is ready to receive the first position.
    Ready { game_id: GameId },
    /// Submit a move for the given ply.
    Move {
        game_id: GameId,
        ply: u32,
        uci_move: String,
        /// Client's own view of its remaining clock (advisory telemetry only).
        client_clock_ms: u64,
        /// Optional signature over (game_id || ply || uci_move) for disputes.
        sig: Option<String>,
    },
    /// Resign the game.
    Resign { game_id: GameId },
    /// Liveness ping.
    Heartbeat { game_id: GameId },
    /// Reconnect / resume an existing session.
    Resume { game_id: GameId, last_seen_seq: u64 },
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/// Wraps a message with protocol version + a per-connection monotonic sequence
/// number + a timestamp, enabling idempotent replay after reconnect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope<M> {
    pub v: u8,
    pub seq: u64,
    pub ts_ms: u64,
    #[serde(flatten)]
    pub msg: M,
}

impl<M> Envelope<M> {
    pub fn new(seq: u64, ts_ms: u64, msg: M) -> Self {
        Envelope {
            v: PROTOCOL_VERSION,
            seq,
            ts_ms,
            msg,
        }
    }
}

pub type ServerEnvelope = Envelope<ServerMessage>;
pub type ClientEnvelope = Envelope<ClientMessage>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_message_roundtrips_with_type_tag() {
        let msg = ServerMessage::YourTurn {
            game_id: Uuid::nil(),
            ply: 3,
            position_fen: "startpos".into(),
            moves_uci: vec!["e2e4".into(), "e7e5".into()],
            clock: Clock {
                white_ms: 60_000,
                black_ms: 59_000,
                increment_ms: 1_000,
            },
            deadline_server_ms: 123_456,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"your_turn\""));
        let back: ServerMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn envelope_flattens_message_fields() {
        let env = Envelope::new(
            7,
            999,
            ClientMessage::Resign {
                game_id: Uuid::nil(),
            },
        );
        let json = serde_json::to_string(&env).unwrap();
        // version + seq + the flattened tagged message all at the top level
        assert!(json.contains("\"v\":1"));
        assert!(json.contains("\"seq\":7"));
        assert!(json.contains("\"type\":\"resign\""));
        let back: ClientEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(env, back);
    }

    #[test]
    fn color_opposite() {
        assert_eq!(Color::White.opposite(), Color::Black);
        assert_eq!(Color::Black.opposite(), Color::White);
    }
}
