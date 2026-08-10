# Built-in repertoire books

`*.bin` here are Polyglot opening books the in-browser bot plays from
(`lib/books.ts` → `lib/polyglot.ts`). They are **composed by us**, not
redistributed — see Licensing below for why that matters.

## Organized by style × slot, not by first move

24 books: six styles (`classical`, `sharp`, `solid`, `hypermodern`, `gambit`,
`offbeat`) across four slots (as White; as Black vs 1.e4 / vs 1.d4 / vs
anything else). A repertoire picks one book per slot, and the slots are
independent — Sharp as White with Solid as Black is a first-class choice.

**A style is a weighted mix, not one opening.** "Sharp" is not "the Sicilian";
it is the Open Sicilian *and* the King's Gambit *and* the Vienna *and* the
Advance variations, each with a designed share. Measured at the branches that
matter:

| Given | Sharp answers | Solid answers | Gambiteer answers |
|---|---|---|---|
| 1.e4 c5 | Nf3 95.5% (Open Sicilian) | Nf3 62.5% (Rossolimo) · c3 35.2% (Alapin) | d4 60.4% (Smith-Morra) · b4 20.2% (Wing) |
| 1.e4 e5 | f4 37.1% (King's Gambit) · Nc3 21.4% (Vienna) | — | f4 36.1% · d4 13.9% (Danish) |

## Two things that are easy to get wrong

**Weights are designed, not corpus frequency.** The English outnumbers Larsen
23:1 in the source, so raw counts would make a "hypermodern" bot play 1.Nf3
forever. Each opening is rescaled onto a target share. That rescaling must
happen with **fractional** weights — flooring at 1 before the merge silently
multiplies every large opening (the English gets factor ≈ 0.2, so an early
floor was inflating it 5× and swamping the small openings).

**Coverage tails.** A style names only the defences it has an opinion about, so
on its own a White book leaves book the moment Black plays something else
(1.e4 d5 and a Sharp bot is calculating from move two). Each White book adds a
thin `any-e4` / `any-d4` mainline tail — always drawn from the **balanced**
corpus and capped at 10 plies. Average book depth is 8–10 plies whatever Black
plays; `pnpm test:books` asserts every White book answers every reply to 1.e4.

## Sources

Both from [official-stockfish/books](https://github.com/official-stockfish/books),
**CC0-1.0 (public domain)**:

| File | Lines | Used for |
|---|---|---|
| `8moves_v3.pgn` | 34.7k **balanced** | everything except gambits, plus all coverage tails |
| `UHO_XXL_+1.00_+1.29.pgn` | 186k **unbalanced** | the gambit books only |

Why two: `8moves_v3` is filtered for engine-testing *balance*, and a gambit is
unbalanced by definition, so it contains almost none — Smith-Morra 5 lines,
Latvian 3, Blackmar-Diemer 0. UHO is selected for the opposite property and has
673 / 209 / 135. But UHO's lines are deliberately lopsided by ply 16, so gambit
books stop at ply 10: long enough to reach the gambit, short enough to hand off
to the engine before UHO's skew matters.

```sh
curl -sL -o /tmp/b.zip https://github.com/official-stockfish/books/raw/master/8moves_v3.pgn.zip
curl -sL -o /tmp/u.zip "https://github.com/official-stockfish/books/raw/master/UHO_XXL_%2B1.00_%2B1.29.pgn.zip"
unzip -o /tmp/b.zip -d /tmp && unzip -o /tmp/u.zip -d /tmp
pnpm -C apps/web build:books        # VERBOSE=1 to print each mix
```

The composer is `apps/web/scripts/build-books.ts`. It is a `.ts` script (run
through `tsx`, like the test suites) specifically so it can import
`polyglotKey`/`encodeMove` from `lib/` — those are pinned to the Polyglot spec's
reference vectors by `pnpm test:book`, and a second hand-rolled Zobrist
implementation here would be free to drift from the one that probes at runtime.

## The one structural rule

**A book only ever stores the moves of the side that owns it.** `w-*` books hold
White's moves, `b-*` books hold Black's. Polyglot is keyed by position, so a
White entry can never match a Black-to-move position — which is what lets a
repertoire be assembled by simply *concatenating* the four selected books.
`pnpm test:books` pins this.

(One caveat that is load-bearing: the concatenation must be **re-sorted by key**.
`entriesFor` binary-searches, so joining two individually-sorted books without
re-sorting makes most positions un-findable. `concatBooks` does it.)

## Licensing — why we compose rather than vendor

Checked against the GitHub API before choosing a source:

| Repo | License | Formats | Verdict |
|---|---|---|---|
| `official-stockfish/books` | **CC0-1.0** | PGN, EPD | ✅ Used. Public domain, so no attribution burden on a money app. |
| `likeawizard/polyglot-composer` | GPL-3.0 (Go) | tool | ⚠️ Same idea, but its filtering is self-described "hardcoded / WIP" and its weight normalization can silently drop low-frequency moves. Not used. |
| `gmcheems-org/free-opening-books` | **no LICENSE file** | real `.bin` | ❌ Not vendored. The only convenient source of ready-made `.bin`s, but it aggregates Komodo / Titans / Cerebellum / Perfect 2021 / Hiarcs books whose own terms are unclear. |
| `fairy-stockfish/books` | GPL-3.0 | **EPD only** | ❌ Contains no Polyglot books at all, and is variant-focused. |

Users who want one of those third-party books can still point the **downloadable
client** at it (`chess-client --book <file>`), and telling someone a link is not
redistribution. The browser used to accept an uploaded `.bin` too; that control
is gone — it was the most advanced setting on the most beginner-facing surface,
and the native client covers it with a real engine behind it.

## Adding a style or opening

Add an `O(...)` entry to `OPENINGS` in `scripts/build-books.ts` (id + the UCI
prefix every one of its games shares), reference it from a book's `mix` with a
designed share, rerun `pnpm build:books`, paste the printed manifest into
`BOOKS` in `lib/books.ts`, and commit the `.bin`.
