/** The coin toss that opens the homepage reel.
 *
 *  Colour in this app is genuinely drawn per game (`coin_flip` in the server's
 *  matchmaking), so this is the one part of the demo that dramatises something
 *  real rather than illustrating it.
 *
 *  Two faces on one 3D disc: no asset to load, no library, and it inherits the
 *  page's colours. The landing is DETERMINISTIC — which face ends up up is a
 *  keyframe constant, not a random number — so this renders identically on the
 *  server and the client. See `.coin` in globals.css for the two keyframe sets
 *  and why they aren't one parameterised set.
 *
 *  Not a client component: it has no state, no effects and no handlers. */
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
        <span className="coin-face white" aria-hidden>
          ♔
        </span>
        <span className="coin-face black" aria-hidden>
          ♚
        </span>
      </div>
      <div className={`coin-call${called ? " on" : ""}`}>
        {lands === "white" ? "White · your bot" : "Black · your bot"}
      </div>
    </div>
  );
}
