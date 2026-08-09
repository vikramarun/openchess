"use client";

import { authedFetch, SESSION_EXPIRED } from "./authedFetch";
import { SERVER_HTTP } from "./config";

/** Square the photo is normalised to before upload. The profile head renders it
 *  at 72px, so 256 covers retina and a future larger rendering without storing
 *  a camera original. */
export const AVATAR_PX = 256;

/** Must match `AVATAR_MAX_BYTES` in `crates/server/src/players.rs`. The server
 *  is the enforcer; this copy only exists so the browser can say what went
 *  wrong instead of round-tripping a photo to be told it's too big. */
export const AVATAR_MAX_BYTES = 256 * 1024;

/** Ceiling on the file we'll even try to decode. Well above any phone photo,
 *  and it stops a 200MP TIFF from taking the tab down inside `drawImage`. */
const SOURCE_MAX_BYTES = 12 * 1024 * 1024;

/** URL of a wallet's photo, or null when it has none.
 *
 *  `version` is the profile's `avatar_updated_at`: the image response is
 *  cacheable for five minutes, so without it a replaced photo would keep
 *  showing the old one. A new timestamp is a new URL. */
export function avatarUrl(address: string, version: string | null | undefined): string | null {
  if (!version) return null;
  const seg = encodeURIComponent(address.toLowerCase());
  return `${SERVER_HTTP}/players/${seg}/avatar?v=${encodeURIComponent(version)}`;
}

/** Decode `file`, centre-crop it to a square, and re-encode it small.
 *
 *  Everything the server stores is produced here, which is why the server can
 *  cap the body so tightly: what arrives is always a 256px JPEG of tens of KB,
 *  not the 4MB original off a phone. JPEG (not PNG) because it is a photo, and
 *  a 256px PNG of one is ~10x larger for no visible gain; the white fill is
 *  what keeps a transparent PNG source from coming out on a black square. */
export async function toSquareJpeg(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("That file isn’t an image.");
  if (file.size > SOURCE_MAX_BYTES) throw new Error("That image is too large (12 MB max).");

  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("Couldn’t read that image.");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn’t read that image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_PX,
    AVATAR_PX,
  );

  // Step the quality down rather than failing: at 256px even the first pass is
  // far under the cap, so this only ever fires on pathological input.
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await encode(canvas, quality);
    if (blob.size <= AVATAR_MAX_BYTES) return blob;
  }
  throw new Error("Couldn’t shrink that image enough. Try a different one.");
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn’t read that image."));
    };
    // An <img> applies the source's EXIF orientation; `createImageBitmap`
    // defaults to ignoring it, which lands a phone portrait shot on its side.
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn’t encode that image."))),
      "image/jpeg",
      quality,
    );
  });
}

/** Upload the signed-in wallet's photo. The seat is the SIWE session, not an
 *  address in the body — the server picks the wallet from the session. */
export async function uploadAvatar(blob: Blob): Promise<void> {
  const res = await authedFetch(`${SERVER_HTTP}/profile/avatar`, {
    method: "POST",
    headers: { "content-type": blob.type || "image/jpeg" },
    body: blob,
  });
  if (!res.ok) throw new Error(failure(res.status, "save"));
}

/** Remove the signed-in wallet's photo. */
export async function removeAvatar(): Promise<void> {
  const res = await authedFetch(`${SERVER_HTTP}/profile/avatar`, { method: "DELETE" });
  if (!res.ok) throw new Error(failure(res.status, "remove"));
}

function failure(status: number, verb: string): string {
  if (status === 401) return SESSION_EXPIRED;
  // 413 covers both halves of "too large": the byte cap and the pixel one.
  if (status === 413) return "That image is too large.";
  if (status === 415) return "That file isn’t a PNG or JPEG image.";
  if (status === 503) return "The server can’t store photos right now.";
  return `Couldn’t ${verb} the photo (${status}).`;
}
