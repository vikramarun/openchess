# Piece set credits

The chess piece artwork in this directory was made by other people and is used
under the licenses below. OpenChess itself is MIT; none of these sets place
copyleft obligations on this repository's code.

Every set is 12 SVGs named `wP wN wB wR wQ wK bP bN bB bR bQ bK`.

| Set | Author | License | Source |
| --- | --- | --- | --- |
| `cburnett` | Colin M.L. Burnett | Multi-licensed **GPLv2+ / BSD / CC-BY-SA 3.0** — used here under the **BSD** option | [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces) |
| `chessnut` | Alexis Luengas | **Apache-2.0** | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/chessnut) |
| `fantasy` | Maurizio Monge | **MIT** | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/fantasy) |
| `spatial` | Maurizio Monge | **MIT** | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/spatial) |
| `celtic` | Maurizio Monge | **MIT** | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/celtic) |
| `rhosgfx` | RhosGFX | **CC0-1.0** (public domain) | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/rhosgfx) |

`cburnett` is deliberately sourced from Wikimedia Commons rather than from lila.
It is the same artwork by the same author, but Commons documents the original
multi-license, which lets us take it under BSD. lila redistributes it as GPLv2+
only, and this repo is MIT.

## Sets we deliberately do not ship

lila's `COPYING.md` classifies its ~41 piece sets, and a large share cannot be
used in a commercial product:

- **Non-free**: `alpha` (personal non-commercial use only), `chess7`,
  `companion`, `leipzig` (freeware, no redistribution grant), `reillycraig`,
  `riohacha` (no license stated), `shahi-ivory-brown` (no-derivatives),
  `totoy`, `papercut`.
- **CC BY-NC-SA (NonCommercial)**: `horsey`, `california`, `caliente`,
  `maestro`, `fresca`, `cardinal`, `icpieces`, `gioco`, `tatiana`, `staunty`,
  `dubrovny`, `anarcandy`, `disguised`, `cooke`, `monarchy`, `xkcd`.
- **GPLv2+ only**: `merida`. Fine for artwork in a web app, but it would put
  copyleft-licensed files in an MIT repo for no strong reason.

OpenChess settles real USDC wagers, so the NonCommercial sets are out on their
face, and we stayed clear of the ambiguous ones too.

The board itself ships no artwork at all — `lib/boardThemes.ts` generates each
board as a two-color SVG checker, which also avoids lila's board textures
(AGPLv3+).

## Adding a set

Drop 12 SVGs into `public/piece/<name>/` and add one entry to `PIECE_SETS` in
`apps/web/lib/pieceSets.ts`. No other code changes. Record the license here, and
only add sets that permit commercial use and redistribution.
