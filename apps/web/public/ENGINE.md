# In-browser engine

`stockfish-18-lite-single.{js,wasm}` is the in-browser bot (`lib/engine.ts`):
**Stockfish 18** (NNUE), the single-threaded "lite" WASM build.

- **Source:** the [`stockfish`](https://www.npmjs.com/package/stockfish) npm
  package (versioned to the engine — v18.0.x), file
  `bin/stockfish-18-lite-single.{js,wasm}` (by nmrugg / Chess.com, GPLv3).
- **Why lite-single:** single-threaded needs no `SharedArrayBuffer` (so no
  COOP/COEP headers, which would complicate the app and other cross-origin
  assets). Lite is a 7 MB NNUE net vs 108 MB for the full net — the right
  trade for an instant-play browser on-ramp; still vastly stronger than a
  human. The downloadable native `chess-client` is the power tier for full
  nets / GPU engines / multi-threading.

## Updating

```sh
npm pack stockfish@latest            # e.g. stockfish-18.0.x.tgz
tar xzf stockfish-*.tgz
cp package/bin/stockfish-18-lite-single.js   apps/web/public/
cp package/bin/stockfish-18-lite-single.wasm apps/web/public/
# bump ENGINE_URL in apps/web/lib/engine.ts if the filename changes
```

The worker speaks plain UCI: `new Worker(url)`, `postMessage("uci")`, read
lines back — so `BrowserEngine` needs no protocol change across versions.
