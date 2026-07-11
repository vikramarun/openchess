//! Polyglot opening book (`.bin`) reader.
//!
//! Polyglot books are a sorted array of 16-byte entries
//! `key(u64) move(u16) weight(u16) learn(u32)`, all big-endian, ordered by key.
//! The key is the position's Polyglot Zobrist hash — which `shakmaty` computes
//! natively, so we can probe the book directly. We consult the book *before*
//! the engine: in-book moves are instant and deterministic, and time spent is
//! ~0 so the server clock barely moves.

use std::path::Path;

use anyhow::{Context, Result};
use shakmaty::uci::UciMove;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{CastlingMode, Chess, EnPassantMode, Move, Position, Role};

#[derive(Clone, Copy)]
struct Entry {
    key: u64,
    mv: u16,
    weight: u16,
}

/// How to choose among multiple book moves for a position.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BookPolicy {
    /// Highest-weight move (deterministic).
    Best,
}

pub struct OpeningBook {
    entries: Vec<Entry>, // sorted by key
    pub max_ply: u32,
    pub policy: BookPolicy,
}

impl OpeningBook {
    /// Load and validate a Polyglot `.bin` file.
    pub fn open(path: &Path, max_ply: u32) -> Result<OpeningBook> {
        let bytes = std::fs::read(path).with_context(|| format!("reading book {path:?}"))?;
        if bytes.len() % 16 != 0 {
            anyhow::bail!("book size {} is not a multiple of 16 bytes", bytes.len());
        }
        let mut entries = Vec::with_capacity(bytes.len() / 16);
        for chunk in bytes.chunks_exact(16) {
            entries.push(Entry {
                key: u64::from_be_bytes(chunk[0..8].try_into().unwrap()),
                mv: u16::from_be_bytes(chunk[8..10].try_into().unwrap()),
                weight: u16::from_be_bytes(chunk[10..12].try_into().unwrap()),
            });
        }
        // Files are supposed to be sorted; ensure it so binary search is valid.
        entries.sort_by_key(|e| e.key);
        Ok(OpeningBook {
            entries,
            max_ply,
            policy: BookPolicy::Best,
        })
    }

    /// Pick a book move for the position, or `None` if out of book / past the
    /// configured ply limit. Returns a UCI long-algebraic move string.
    pub fn pick(&self, pos: &Chess, ply: u32) -> Option<String> {
        if ply >= self.max_ply {
            return None;
        }
        let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;

        // Collect all entries for this key (binary search to the range).
        let lo = self.entries.partition_point(|e| e.key < key);
        let mut best: Option<Entry> = None;
        for e in &self.entries[lo..] {
            if e.key != key {
                break;
            }
            match self.policy {
                BookPolicy::Best => {
                    if best.map(|b| e.weight > b.weight).unwrap_or(true) {
                        best = Some(*e);
                    }
                }
            }
        }
        let entry = best?;

        // Match the encoded Polyglot move against a legal move and emit UCI.
        for m in pos.legal_moves() {
            if encode_move(&m) == entry.mv {
                return Some(UciMove::from_move(&m, CastlingMode::Standard).to_string());
            }
        }
        None
    }
}

/// Encode a legal move into the Polyglot 16-bit move representation so it can be
/// compared against book entries. Castling is encoded as king-square -> rook-
/// square (the Polyglot convention).
fn encode_move(m: &Move) -> u16 {
    let (from, to, promo) = match m {
        Move::Normal {
            from,
            to,
            promotion,
            ..
        } => (*from, *to, promo_code(*promotion)),
        Move::EnPassant { from, to } => (*from, *to, 0),
        Move::Castle { king, rook } => (*king, *rook, 0),
        Move::Put { .. } => return u16::MAX, // not used in standard chess
    };
    let from = u8::from(from) as u16;
    let to = u8::from(to) as u16;
    let (ff, fr) = (from % 8, from / 8);
    let (tf, tr) = (to % 8, to / 8);
    tf | (tr << 3) | (ff << 6) | (fr << 9) | (promo << 12)
}

fn promo_code(role: Option<Role>) -> u16 {
    match role {
        Some(Role::Knight) => 1,
        Some(Role::Bishop) => 2,
        Some(Role::Rook) => 3,
        Some(Role::Queen) => 4,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startpos_has_polyglot_key() {
        // The well-known Polyglot Zobrist hash of the initial position.
        let pos = Chess::default();
        let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;
        assert_eq!(key, 0x463b96181691fc9c);
    }

    #[test]
    fn encodes_e2e4() {
        // e2 = square 12 (file 4, rank 1); e4 = square 28 (file 4, rank 3).
        // expected = tf | tr<<3 | ff<<6 | fr<<9 = 4 | (3<<3) | (4<<6) | (1<<9)
        let pos = Chess::default();
        let e2e4 = pos
            .legal_moves()
            .into_iter()
            .find(|m| UciMove::from_move(m, CastlingMode::Standard).to_string() == "e2e4")
            .unwrap();
        let expected = 4u16 | (3 << 3) | (4 << 6) | (1 << 9);
        assert_eq!(encode_move(&e2e4), expected);
    }

    #[test]
    fn probes_a_one_entry_book() {
        // Build an in-memory book with one entry: startpos -> e2e4, weight 10.
        let pos = Chess::default();
        let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;
        let e2e4 = pos
            .legal_moves()
            .into_iter()
            .find(|m| UciMove::from_move(m, CastlingMode::Standard).to_string() == "e2e4")
            .unwrap();
        let book = OpeningBook {
            entries: vec![Entry {
                key,
                mv: encode_move(&e2e4),
                weight: 10,
            }],
            max_ply: 16,
            policy: BookPolicy::Best,
        };
        assert_eq!(book.pick(&pos, 0).as_deref(), Some("e2e4"));
        // past the ply limit -> no book move
        assert_eq!(book.pick(&pos, 16), None);
    }
}
