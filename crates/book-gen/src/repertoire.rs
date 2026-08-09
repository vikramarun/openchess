//! The house bot's opening repertoire, as SAN mainlines.
//!
//! Why hand-written rather than a downloaded GM book: a third-party `.bin` is
//! an opaque blob with unclear provenance and licensing, and nothing in review
//! can tell you what it plays. This is source — you can read the repertoire,
//! diff a change to it, and the generator rejects an illegal move at build
//! time. Opening moves themselves aren't anyone's property.
//!
//! Polyglot books are keyed by POSITION, not by move sequence, so transpositions
//! fall out for free: any move order reaching a position below finds the entry.
//! Both colours are covered by the same lines, because every position along a
//! line gets an entry — the bot plays from the book whichever side it has.
//!
//! A move's weight is the number of lines running through it, so the pick is
//! weighted toward the mainline while still varying. Add lines to make a
//! variation more likely; the weights re-derive themselves.

/// `(name, SAN mainline)`. The name is only for generator output and errors.
pub const LINES: &[(&str, &str)] = &[
    // ---------------------------------------------------------------- 1.e4 e5
    ("Ruy Lopez, Closed", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3"),
    ("Ruy Lopez, Marshall", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5 exd5 Nxd5"),
    ("Ruy Lopez, Berlin", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8"),
    ("Ruy Lopez, Exchange", "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 exd4 Nxd4 c5"),
    ("Italian, Giuoco Pianissimo", "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O"),
    ("Two Knights", "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6"),
    ("Scotch, Classical", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7"),
    ("Scotch, Mieses", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5"),
    ("Petroff", "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6 O-O Be7"),
    ("Four Knights", "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6"),
    ("Philidor", "e4 e5 Nf3 d6 d4 Nf6 Nc3 Nbd7 Bc4 Be7 O-O O-O"),
    ("Vienna", "e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7"),
    ("King's Gambit, Kieseritzky", "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6"),
    // ------------------------------------------------------- 1.e4 c5 Sicilian
    ("Sicilian, Najdorf 6.Be3", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7"),
    ("Sicilian, Najdorf 6.Bg5", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Be7 Qf3 Qc7"),
    ("Sicilian, Dragon", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6"),
    ("Sicilian, Classical", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2 Be7 O-O-O O-O"),
    ("Sicilian, Scheveningen", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6 Be2 Be7 O-O O-O"),
    ("Sicilian, Sveshnikov", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5"),
    ("Sicilian, Taimanov", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6 Bd3 Nf6"),
    ("Sicilian, Kan", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Bc5 Nb3 Ba7 Qe2 Nc6"),
    ("Sicilian, Rossolimo", "e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7 Re1 Nf6 c3 O-O"),
    ("Sicilian, Moscow", "e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 O-O Nc6 c3 Nf6 Re1 e6"),
    ("Sicilian, Alapin", "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6"),
    ("Sicilian, Closed", "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 f4 Nf6"),
    ("Sicilian, Grand Prix", "e4 c5 Nc3 Nc6 f4 g6 Nf3 Bg7 Bc4 e6"),
    // ---------------------------------------------------------- 1.e4 e6 French
    ("French, Winawer", "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 O-O"),
    ("French, Steinitz", "e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6"),
    ("French, Tarrasch 3...Nf6", "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2"),
    ("French, Tarrasch 3...c5", "e4 e6 d4 d5 Nd2 c5 exd5 Qxd5 Ngf3 cxd4 Bc4 Qd6"),
    ("French, Advance", "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 Nh6"),
    ("French, Exchange", "e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6 O-O O-O"),
    // ------------------------------------------------------- 1.e4 c6 Caro-Kann
    ("Caro-Kann, Classical", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7"),
    ("Caro-Kann, Advance", "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 Qb6"),
    ("Caro-Kann, Panov", "e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Be7"),
    ("Caro-Kann, Exchange", "e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4 Bg4"),
    ("Caro-Kann, Two Knights", "e4 c6 Nc3 d5 Nf3 Bg4 h3 Bxf3 Qxf3 e6"),
    // --------------------------------------------------------------- other 1.e4
    ("Scandinavian, 3...Qa5", "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5"),
    ("Scandinavian, 2...Nf6", "e4 d5 exd5 Nf6 d4 Nxd5 Nf3 g6 Be2 Bg7 O-O O-O"),
    ("Pirc", "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O c6"),
    ("Modern, Austrian", "e4 g6 d4 Bg7 Nc3 d6 f4 Nf6 Nf3 O-O"),
    ("Alekhine", "e4 Nf6 e5 Nd5 d4 d6 Nf3 g6 Bc4 Nb6 Bb3 Bg7"),
    // ---------------------------------------------------------------- 1.d4 d5
    ("QGD, Orthodox", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6"),
    ("QGD, Exchange", "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5 Be7 e3 c6 Bd3 O-O"),
    ("Tarrasch Defence", "d4 d5 c4 e6 Nc3 c5 cxd5 exd5 Nf3 Nc6 g3 Nf6 Bg2 Be7"),
    ("Slav", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4"),
    ("Semi-Slav, Meran", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5"),
    ("QGA", "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6"),
    ("Chigorin", "d4 d5 c4 Nc6 Nf3 Bg4 cxd5 Bxf3 gxf3 Qxd5"),
    ("London", "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6 Bg3 O-O Bd3 c5"),
    // --------------------------------------------------------------- 1.d4 Nf6
    ("Nimzo-Indian, Rubinstein", "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O"),
    ("Nimzo-Indian, Classical", "d4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6"),
    ("Queen's Indian", "d4 Nf6 c4 e6 Nf3 b6 g3 Ba6 b3 Bb4+ Bd2 Be7 Bg2 c6 O-O d5"),
    ("Bogo-Indian", "d4 Nf6 c4 e6 Nf3 Bb4+ Bd2 Qe7 g3 O-O Bg2 d6"),
    ("Catalan", "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6"),
    ("King's Indian, Classical", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7"),
    ("King's Indian, Saemisch", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 Nh5"),
    ("Gruenfeld, Exchange", "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5 Rb1 O-O"),
    ("Gruenfeld, Russian", "d4 Nf6 c4 g6 Nc3 d5 Nf3 Bg7 Qb3 dxc4 Qxc4 O-O e4 Bg4"),
    ("Benoni, Modern", "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7"),
    ("Benko Gambit", "d4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 Bxa6 Nc3 d6 e4 Bxf1 Kxf1 g6"),
    ("Old Indian", "d4 Nf6 c4 d6 Nc3 e5 Nf3 Nbd7 e4 Be7 Be2 O-O"),
    // --------------------------------------------------------------- 1.d4 f5
    ("Dutch, Leningrad", "d4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O c4 d6"),
    ("Dutch, Stonewall", "d4 f5 g3 Nf6 Bg2 e6 Nf3 d5 O-O Bd6 c4 c6"),
    // ------------------------------------------------------------ 1.c4 / 1.Nf3
    ("English, Symmetrical", "c4 c5 Nf3 Nf6 Nc3 Nc6 d4 cxd4 Nxd4 e6 g3 Qb6"),
    ("English, Reversed Sicilian", "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6"),
    ("English, Four Knights", "c4 e5 Nc3 Nf6 Nf3 Nc6 e3 Bb4 Qc2 O-O"),
    ("Reti", "Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O"),
];
