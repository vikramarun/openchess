"use client";

import { useRef, useState } from "react";

import { removeAvatar, toSquareJpeg, uploadAvatar } from "@/lib/avatar";
import { useAuthToken } from "@/lib/useAuthToken";

/** Add / replace / remove the signed-in wallet's profile photo.
 *
 *  Rendered by `ProfileStats` only on your own profile (`editable`), never on
 *  the public `/player/[ident]` page — the server would reject a write for
 *  someone else's wallet anyway, since it takes the wallet from the session. */
export function AvatarEditor({
  hasPhoto,
  onChanged,
}: {
  hasPhoto: boolean;
  onChanged: () => void;
}) {
  const token = useAuthToken();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The wallet can be connected without a SIWE session (or with one the server
  // forgot on restart), and the upload needs the session, not the connection.
  if (!token) {
    return (
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        Sign in to add a profile photo.
      </div>
    );
  }

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Clear first: picking the same file twice fires no change event
          // otherwise, so a failed upload couldn't be retried with that file.
          e.target.value = "";
          if (file) void run(async () => uploadAvatar(await toSquareJpeg(file)));
        }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="ghost"
          style={{ fontSize: 13, padding: "4px 10px" }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Saving…" : hasPhoto ? "Change photo" : "Add photo"}
        </button>
        {hasPhoto && (
          <button
            className="ghost"
            style={{ fontSize: 13, padding: "4px 10px" }}
            disabled={busy}
            onClick={() => void run(removeAvatar)}
          >
            Remove
          </button>
        )}
        {/* "Any image", not the server's PNG/JPEG storage formats: the picker
            accepts image/*, and everything is re-encoded to a JPEG here before
            it is sent, so naming the storage formats only talks people out of
            files that would have worked. */}
        <span className="muted" style={{ fontSize: 12 }}>
          Any image, cropped to a square.
        </span>
      </div>
      {err && (
        <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 6 }}>{err}</div>
      )}
    </div>
  );
}
