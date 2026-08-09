//! Build the house bot's Polyglot opening book from `repertoire.rs`.
//!
//!   cargo run -p book-gen -- assets/house-book.bin
//!
//! A Polyglot `.bin` is a key-sorted array of 16-byte big-endian entries:
//! `key(u64) move(u16) weight(u16) learn(u32)`. The key is the position's
//! Polyglot Zobrist hash, which shakmaty computes natively — the same call the
//! reader makes (`crates/byo-client/src/book.rs`), so the two agree by
//! construction. `byo-client`'s `shipped_book_*` tests probe the committed file
//! through the real reader, which is what actually pins that agreement down.
//!
//! Every move in every line is validated; an illegal or misspelled SAN move
//! fails the build rather than silently dropping out of the book.

mod repertoire;

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use shakmaty::san::San;
use shakmaty::zobrist::{Zobrist64, ZobristHash};
use shakmaty::{Chess, EnPassantMode, Move, Position, Role};

fn main() -> Result<()> {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "assets/house-book.bin".to_string());

    // (position key, encoded move) -> weight. BTreeMap so the output is sorted
    // by key, which is what the format requires and what lets the reader
    // binary-search. Byte-identical across runs, so a regenerated book with an
    // unchanged repertoire produces an empty diff.
    let mut weights: BTreeMap<(u64, u16), u32> = BTreeMap::new();
    let mut deepest = 0usize;

    for (name, line) in repertoire::LINES {
        let mut pos = Chess::default();
        for (i, token) in line.split_whitespace().enumerate() {
            let san = San::from_ascii(token.as_bytes())
                .with_context(|| format!("{name}: move {} ('{token}') is not valid SAN", i + 1))?;
            let mv = san
                .to_move(&pos)
                .with_context(|| format!("{name}: move {} ('{token}') is not legal here", i + 1))?;
            let key = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0;
            // A move's weight is the number of lines running through it, so the
            // weighted pick favours whatever the repertoire repeats.
            *weights.entry((key, encode_move(&mv))).or_default() += 1;
            pos = pos
                .play(&mv)
                .map_err(|_| anyhow::anyhow!("{name}: move {} ('{token}') is not legal here", i + 1))?;
            deepest = deepest.max(i + 1);
        }
    }

    let mut bytes = Vec::with_capacity(weights.len() * 16);
    for ((key, mv), weight) in &weights {
        // u16 ceiling: a move would need 65k lines through it to reach this,
        // but clamp rather than wrap — a silent overflow would invert the
        // weighting and make the rarest move the most likely.
        let weight = u16::try_from(*weight).unwrap_or(u16::MAX);
        bytes.extend_from_slice(&key.to_be_bytes());
        bytes.extend_from_slice(&mv.to_be_bytes());
        bytes.extend_from_slice(&weight.to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes()); // learn: unused
    }

    if bytes.is_empty() {
        bail!("refusing to write an empty book");
    }
    if let Some(dir) = std::path::Path::new(&out).parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(&out, &bytes).with_context(|| format!("writing {out}"))?;

    let positions = weights.keys().map(|(k, _)| *k).collect::<std::collections::BTreeSet<_>>();
    println!(
        "{out}: {} lines, {} positions, {} entries, {} bytes (deepest line {} plies)",
        repertoire::LINES.len(),
        positions.len(),
        weights.len(),
        bytes.len(),
        deepest,
    );
    Ok(())
}

/// Polyglot's 16-bit move encoding. Mirrors `byo-client`'s reader-side
/// `encode_move`; castling is king-square -> ROOK-square, not the king's
/// destination, which is the classic way to get a book that never hits.
fn encode_move(m: &Move) -> u16 {
    let (from, to, promo) = match m {
        Move::Normal { from, to, promotion, .. } => (*from, *to, promo_code(*promotion)),
        Move::EnPassant { from, to } => (*from, *to, 0),
        Move::Castle { king, rook } => (*king, *rook, 0),
        Move::Put { .. } => unreachable!("no drops in standard chess"),
    };
    let (from, to) = (u8::from(from) as u16, u8::from(to) as u16);
    (to % 8) | ((to / 8) << 3) | ((from % 8) << 6) | ((from / 8) << 9) | (promo << 12)
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
