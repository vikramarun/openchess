import { Logo } from "./Logo";

/** The toss that opens the homepage reel.
 *
 *  Color in this app is genuinely drawn per game (`coin_flip` in the server's
 *  matchmaking), so this is the one part of the demo that dramatises something
 *  real rather than illustrating it.
 *
 *  A struck casino chip rather than a disc with a glyph on it: notched rim,
 *  raised inner face, and the OpenChess rook stamped in the middle in one tone
 *  (see `Logo`'s `tone` — the two-tone mark disappears into gold). Built from
 *  gradients rather than an image so it inherits the page's colors, costs no
 *  request, and stays crisp at any size.
 *
 *  The landing is DETERMINISTIC — which face ends up up is a keyframe constant,
 *  not a random number — so this renders identically on the server and the
 *  client. See `.coin` in globals.css for the two keyframe sets and why they
 *  aren't one parameterised set.
 *
 *  Not a client component: no state, no effects, no handlers. */
export function CoinFlip({
  lands,
  called,
}: {
  lands: "white" | "black";
  /** Reveal the call-out under the coin (the reel's "call" phase). */
  called: boolean;
}) {
  return (
    <div className="demo-scrim">
      <div className={`coin lands-${lands}`}>
        <span className="coin-face light">
          <span className="coin-rim" aria-hidden />
          <Logo size={38} className="coin-mark" tone="#7a5410" decorative />
        </span>
        <span className="coin-face dark">
          <span className="coin-rim" aria-hidden />
          <Logo size={38} className="coin-mark" tone="#f2d489" decorative />
        </span>
      </div>
      <div className={`coin-call${called ? " on" : ""}`}>
        {lands === "white" ? "White · your bot" : "Black · your bot"}
      </div>
    </div>
  );
}
