//! Dump the polyglot zobrist table (as shakmaty computes it) as a TS module.
use shakmaty::zobrist::{Zobrist64, ZobristValue};
use shakmaty::{CastlingSide, Color, File, Piece, Role, Square};

fn main() {
    println!("// GENERATED — do not edit. Polyglot Zobrist table from shakmaty.");
    println!("// Regenerate: cargo run --manifest-path \\");
    println!("//   apps/web/scripts/gen-polyglot-table/Cargo.toml > apps/web/lib/polyglotTable.ts");
    println!("// Layout: PIECES[colorIdx * 6 * 64 + roleIdx * 64 + square]");
    println!("// colorIdx: 0=white 1=black; roleIdx: 0=pawn..5=king; square: a1=0..h8=63.");
    println!("export const PIECES: bigint[] = [");
    for color in [Color::White, Color::Black] {
        for role in [Role::Pawn, Role::Knight, Role::Bishop, Role::Rook, Role::Queen, Role::King] {
            print!("  ");
            for sq in Square::ALL {
                let z = Zobrist64::zobrist_for_piece(sq, Piece { color, role });
                print!("0x{:016x}n,", z.0);
            }
            println!();
        }
    }
    println!("];");
    let wk = Zobrist64::zobrist_for_castling_right(Color::White, CastlingSide::KingSide);
    let wq = Zobrist64::zobrist_for_castling_right(Color::White, CastlingSide::QueenSide);
    let bk = Zobrist64::zobrist_for_castling_right(Color::Black, CastlingSide::KingSide);
    let bq = Zobrist64::zobrist_for_castling_right(Color::Black, CastlingSide::QueenSide);
    println!("// [white-kingside, white-queenside, black-kingside, black-queenside]");
    println!("export const CASTLING: bigint[] = [0x{:016x}n, 0x{:016x}n, 0x{:016x}n, 0x{:016x}n];", wk.0, wq.0, bk.0, bq.0);
    print!("export const EN_PASSANT: bigint[] = [");
    for f in File::ALL {
        print!("0x{:016x}n, ", Zobrist64::zobrist_for_en_passant_file(f).0);
    }
    println!("];");
    println!("export const WHITE_TURN: bigint = 0x{:016x}n;", Zobrist64::zobrist_for_white_turn().0);
}
