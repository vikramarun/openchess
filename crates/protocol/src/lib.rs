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
    /// The game is beginning. `opponent` describes the other seat when known
    /// (absent on older servers and in spectator streams).
    GameStart {
        game_id: GameId,
        start_fen: String,
        your_color: Color,
        clock: Clock,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opponent: Option<OpponentInfo>,
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
// Agent (bot) control channel
// ---------------------------------------------------------------------------
//
// A user's engine connects ONCE as an "agent" bound to their wallet and stays
// online; the web app is the remote control. When the user starts or joins a
// game with their bot, the server pushes the seat to the agent — the user
// never shuttles tokens or re-runs commands per game.

/// A UCI option an engine advertised in its handshake (so the web app can
/// render a settings panel for the bot).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UciOptionInfo {
    pub name: String,
    /// UCI option type: check | spin | combo | button | string.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
}

/// Messages an agent (native BYO client in `connect` mode) sends the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToServer {
    /// Register this agent: what engine it runs and which options it exposes.
    Hello {
        /// SIWE session token (auth travels in this frame, NOT the URL — the
        /// token is a long-lived wallet credential and URLs get logged).
        token: String,
        /// Display name shown to opponents (defaults to the engine name).
        name: Option<String>,
        /// Engine `id name` from the UCI handshake.
        engine: String,
        /// Options the engine advertised (for the web settings panel).
        options: Vec<UciOptionInfo>,
        client_version: String,
    },
    /// Availability report: `idle` (ready for a seat) or `playing`.
    Status {
        state: String,
        game_id: Option<GameId>,
    },
}

/// Messages the server pushes to a connected agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerToAgent {
    /// Registration accepted; the agent is now controllable from the web.
    Registered {
        wallet: String,
    },
    /// Play this seat now (the user started/joined a game from the web).
    AssignSeat {
        game_id: GameId,
        /// Launch token for the seat — the agent connects to /ws/game with it.
        token: String,
        color: Color,
        time_control: TimeControl,
        stake: Option<String>,
        /// UCI options to apply for this game (user-configured on the web).
        #[serde(default)]
        uci_options: Vec<(String, String)>,
    },
    Error {
        code: String,
        message: String,
    },
}

pub type AgentEnvelope = Envelope<AgentToServer>;
pub type AgentServerEnvelope = Envelope<ServerToAgent>;

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
    fn game_start_without_opponent_still_deserializes() {
        // v1 clients/servers that predate `opponent` must keep interoperating.
        let old = r#"{"type":"game_start","game_id":"00000000-0000-0000-0000-000000000000",
                      "start_fen":"startpos","your_color":"white",
                      "clock":{"white_ms":1,"black_ms":1,"increment_ms":0}}"#;
        let msg: ServerMessage = serde_json::from_str(old).unwrap();
        match msg {
            ServerMessage::GameStart { opponent, .. } => assert!(opponent.is_none()),
            other => panic!("wrong variant: {other:?}"),
        }

        let with = ServerMessage::GameStart {
            game_id: Uuid::nil(),
            start_fen: "startpos".into(),
            your_color: Color::Black,
            clock: Clock {
                white_ms: 1,
                black_ms: 1,
                increment_ms: 0,
            },
            opponent: Some(OpponentInfo {
                name: "0x1234…abcd".into(),
                declared_engine: Some("Stockfish 17".into()),
            }),
        };
        let json = serde_json::to_string(&with).unwrap();
        let back: ServerMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(with, back);
    }

    #[test]
    fn agent_messages_roundtrip() {
        let hello = AgentToServer::Hello {
            token: "sess".into(),
            name: Some("TalBot".into()),
            engine: "Stockfish 17".into(),
            options: vec![UciOptionInfo {
                name: "Threads".into(),
                kind: "spin".into(),
                default: Some("1".into()),
                min: Some("1".into()),
                max: Some("512".into()),
            }],
            client_version: "0.1.0".into(),
        };
        let json = serde_json::to_string(&hello).unwrap();
        assert!(json.contains("\"type\":\"hello\""));
        assert_eq!(hello, serde_json::from_str(&json).unwrap());

        let assign = ServerToAgent::AssignSeat {
            game_id: Uuid::nil(),
            token: "tok".into(),
            color: Color::Black,
            time_control: TimeControl {
                initial_ms: 60_000,
                increment_ms: 0,
            },
            stake: None,
            uci_options: vec![("Skill Level".into(), "5".into())],
        };
        let json = serde_json::to_string(&assign).unwrap();
        assert!(json.contains("\"type\":\"assign_seat\""));
        assert_eq!(
            assign,
            serde_json::from_str::<ServerToAgent>(&json).unwrap()
        );
        // An assign without uci_options (older server) still parses.
        let bare = r#"{"type":"assign_seat","game_id":"00000000-0000-0000-0000-000000000000",
                       "token":"t","color":"white",
                       "time_control":{"initial_ms":1,"increment_ms":0},"stake":null}"#;
        assert!(serde_json::from_str::<ServerToAgent>(bare).is_ok());
    }

    #[test]
    fn color_opposite() {
        assert_eq!(Color::White.opposite(), Color::Black);
        assert_eq!(Color::Black.opposite(), Color::White);
    }
}
