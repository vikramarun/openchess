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
#[derive(Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum BookPolicy {
    /// Weight-proportional random pick — what Polyglot books are weighted FOR,
    /// and the only sane default for a bot that plays continuously. `Best`
    /// would march the house bot down one identical line every single game.
    #[default]
    Weighted,
    /// Highest-weight move (deterministic). For reproducible runs.
    Best,
}

pub struct OpeningBook {
    entries: Vec<Entry>, // sorted by key
    pub max_ply: u32,
    pub policy: BookPolicy,
}

impl OpeningBook {
    /// Load and validate a Polyglot `.bin` file.
    pub fn open(path: &Path, max_ply: u32, policy: BookPolicy) -> Result<OpeningBook> {
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
            policy,
        })
    }

    /// How many positions this book knows (distinct keys), for a startup log.
    pub fn positions(&self) -> usize {
        let mut n = 0;
        let mut last: Option<u64> = None;
        for e in &self.entries {
            if last != Some(e.key) {
                n += 1;
                last = Some(e.key);
            }
        }
        n
    }

    /// Pick a book move for the position, or `None` if out of book / past the
    /// configured ply limit. Returns a UCI long-algebraic move string.
    pub fn pick(&self, pos: &Chess, ply: u32) -> Option<String> {
        if ply >= self.max_ply {
            return None;
        }
        let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;

        // All entries for this key sit contiguously (the file is key-sorted).
        let lo = self.entries.partition_point(|e| e.key < key);
        let n = self.entries[lo..]
            .iter()
            .take_while(|e| e.key == key)
            .count();
        let entry = self.choose(&self.entries[lo..lo + n])?;

        // Match the encoded Polyglot move against a legal move and emit UCI.
        for m in pos.legal_moves() {
            if encode_move(&m) == entry.mv {
                return Some(UciMove::from_move(&m, CastlingMode::Standard).to_string());
            }
        }
        None
    }

    /// Pick one of a position's book entries under the configured policy.
    fn choose(&self, candidates: &[Entry]) -> Option<Entry> {
        match self.policy {
            BookPolicy::Best => candidates.iter().copied().max_by_key(|e| e.weight),
            BookPolicy::Weighted => {
                // Sum as u64: a popular position in a big book can carry more
                // total weight than a u16 holds.
                let total: u64 = candidates.iter().map(|e| e.weight as u64).sum();
                // An all-zero-weight position is legal in the format; treat the
                // entries as equally likely rather than returning nothing.
                if total == 0 {
                    let i = fastrand_below(candidates.len() as u64)? as usize;
                    return candidates.get(i).copied();
                }
                let mut roll = fastrand_below(total)?;
                for e in candidates {
                    let w = e.weight as u64;
                    if roll < w {
                        return Some(*e);
                    }
                    roll -= w;
                }
                candidates.last().copied()
            }
        }
    }
}

/// Uniform random in `0..n`, or `None` when `n == 0` (empty candidate list).
fn fastrand_below(n: u64) -> Option<u64> {
    (n > 0).then(|| rand::Rng::random_range(&mut rand::rng(), 0..n))
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

    fn entry(mv: &str, weight: u16, pos: &Chess) -> Entry {
        let m = pos
            .legal_moves()
            .into_iter()
            .find(|m| UciMove::from_move(m, CastlingMode::Standard).to_string() == mv)
            .unwrap();
        Entry {
            key: pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0,
            mv: encode_move(&m),
            weight,
        }
    }

    #[test]
    fn weighted_varies_the_opening_where_best_repeats_it() {
        // The reason `Weighted` had to exist: a house bot playing continuously
        // under `Best` marches down one identical line forever.
        let pos = Chess::default();
        let entries = vec![entry("e2e4", 3, &pos), entry("d2d4", 2, &pos)];
        let best = OpeningBook {
            entries: entries.clone(),
            max_ply: 16,
            policy: BookPolicy::Best,
        };
        for _ in 0..20 {
            assert_eq!(best.pick(&pos, 0).as_deref(), Some("e2e4"));
        }

        let weighted = OpeningBook {
            entries,
            max_ply: 16,
            policy: BookPolicy::Weighted,
        };
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..200 {
            seen.insert(weighted.pick(&pos, 0).unwrap());
        }
        // P(missing one) < (3/5)^200 — not a flaky assertion.
        assert_eq!(
            seen,
            ["d2d4".to_string(), "e2e4".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn weighted_never_picks_a_zero_weight_move_when_others_have_weight() {
        // Walking the roll must skip zero-weight entries, not fence-post onto
        // them — a book can legitimately carry "known but don't play" moves.
        let pos = Chess::default();
        let book = OpeningBook {
            entries: vec![entry("e2e4", 5, &pos), entry("a2a4", 0, &pos)],
            max_ply: 16,
            policy: BookPolicy::Weighted,
        };
        for _ in 0..200 {
            assert_eq!(book.pick(&pos, 0).as_deref(), Some("e2e4"));
        }
    }
}

/// The book shipped in the image. These run the REAL reader against the file
/// `book-gen` wrote, which is what stops the generator's Polyglot encoding and
/// the reader's from drifting apart: a mismatch there produces a book that
/// parses fine and never hits, and nothing else would catch it.
#[cfg(test)]
mod shipped_book {
    use super::*;
    use shakmaty::san::San;

    fn book() -> OpeningBook {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/house-book.bin");
        OpeningBook::open(&path, 16, BookPolicy::Weighted).expect("shipped book must load")
    }

    /// Play SAN moves and return the position they reach.
    fn after(moves: &str) -> Chess {
        let mut pos = Chess::default();
        for tok in moves.split_whitespace() {
            let m = San::from_ascii(tok.as_bytes())
                .unwrap()
                .to_move(&pos)
                .unwrap();
            pos = pos.play(&m).unwrap();
        }
        pos
    }

    #[test]
    fn shipped_book_answers_the_start_position() {
        let b = book();
        assert!(
            b.positions() > 400,
            "book looks truncated: {}",
            b.positions()
        );
        let mv = b
            .pick(&Chess::default(), 0)
            .expect("no book move for startpos");
        assert!(
            ["e2e4", "d2d4", "c2c4", "g1f3"].contains(&mv.as_str()),
            "unexpected first move {mv}"
        );
    }

    #[test]
    fn shipped_book_answers_as_black_too() {
        // Both colours come from the same lines, so a reply must be in there.
        let b = book();
        assert!(b.pick(&after("e4"), 1).is_some(), "no reply to 1.e4");
        assert!(b.pick(&after("d4"), 1).is_some(), "no reply to 1.d4");
    }

    #[test]
    fn shipped_book_follows_a_line_into_the_middlegame() {
        // Six plies deep in the Najdorf — proves entries exist past the first
        // couple of moves, which is where the clock was actually going.
        let b = book();
        assert!(
            b.pick(&after("e4 c5 Nf3 d6 d4 cxd4"), 6).is_some(),
            "book runs dry at ply 6"
        );
    }

    #[test]
    fn shipped_book_handles_transpositions() {
        // Polyglot keys POSITIONS, not move orders, so a line reached a
        // different way still hits. Najdorf with ...a6 played before ...Nf6
        // is the same position as the repertoire's move order, and the book
        // has to answer it — otherwise the bot drops out of book the first
        // time an opponent shuffles two moves.
        let b = book();
        let shuffled = after("e4 c5 Nf3 d6 d4 cxd4 Nxd4 a6 Nc3 Nf6");
        let repertoire_order = after("e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6");
        assert_eq!(
            shuffled.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0,
            repertoire_order
                .zobrist_hash::<Zobrist64>(EnPassantMode::Legal)
                .0,
            "these move orders should reach one position"
        );
        assert!(
            b.pick(&shuffled, 10).is_some(),
            "no entry after a transposition"
        );
    }

    #[test]
    fn shipped_book_stops_at_the_ply_limit() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/house-book.bin");
        let b = OpeningBook::open(&path, 4, BookPolicy::Weighted).unwrap();
        assert!(b.pick(&Chess::default(), 0).is_some());
        assert!(b.pick(&after("e4 c5 Nf3 d6"), 4).is_none());
    }
}
