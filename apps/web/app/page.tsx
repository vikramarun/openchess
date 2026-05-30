"use client";

import Link from "next/link";
import { useState } from "react";

import { SERVER_HTTP } from "@/lib/config";

type CreateResp = {
  game_id: string;
  white_token: string;
  black_token: string;
  spectate_path: string;
};

export default function Home() {
  const [initial, setInitial] = useState(60);
  const [increment, setIncrement] = useState(1);
  const [resp, setResp] = useState<CreateResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function createGame() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`${SERVER_HTTP}/games`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initial_secs: initial, increment_secs: increment }),
      });
      if (!r.ok) throw new Error(`server returned ${r.status}`);
      setResp(await r.json());
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Machines play. You wager.</h1>
        <p className="muted">
          Engine-vs-engine chess with non-custodial USDC wagers on Base. Create a
          game, point two bring-your-own-engine clients at the seats, and watch
          them play live. The server is the sole authority on legality, clock,
          and result.
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Create a game</h2>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label>
            <div className="muted">Initial (sec)</div>
            <input
              type="number"
              value={initial}
              min={1}
              onChange={(e) => setInitial(Number(e.target.value))}
            />
          </label>
          <label>
            <div className="muted">Increment (sec)</div>
            <input
              type="number"
              value={increment}
              min={0}
              onChange={(e) => setIncrement(Number(e.target.value))}
            />
          </label>
          <button className="primary" onClick={createGame} disabled={loading}>
            {loading ? "Creating…" : "Create game"}
          </button>
        </div>
        {err && (
          <p style={{ color: "#e06c6c" }}>
            {err} — is the server running on {SERVER_HTTP}?
          </p>
        )}
      </div>

      {resp && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Game created</h2>
          <p>
            Game id: <code>{resp.game_id}</code>
          </p>
          <p className="muted">Launch each engine client (in two terminals):</p>
          <pre>
{`# White
cargo run -p byo-client -- play \\
  --game ${resp.game_id} --token ${resp.white_token}

# Black
cargo run -p byo-client -- play \\
  --game ${resp.game_id} --token ${resp.black_token}`}
          </pre>
          <p>
            <Link href={`/game/${resp.game_id}`} className="primary" style={{
              display: "inline-block", padding: "10px 18px", borderRadius: 6,
              textDecoration: "none", color: "white",
            }}>
              ▶ Watch live
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
