// Verify what the browser does to a profile photo before it reaches the server.
//
// The server's body cap is tight (256 KiB) precisely because everything it
// stores is produced here, so the two halves have to agree: if the crop or the
// re-encode silently stopped happening, a phone photo would start arriving at
// full size and every upload would 413. The crop is also the part that is wrong
// in a way nobody notices in code review — an off-centre square reads as "the
// site cropped my head off", not as a bug.
//
// Browser globals must exist before the module under test is imported (it
// touches document/Image/URL at call time), hence the dynamic import below.

// Nothing here can be imported at the top level (the globals below must exist
// first), and a file with no top-level import/export is a *script*, not a
// module — its `const`s would then share one global scope with the other
// import-less test script and collide under `tsc`. This makes it a module.
export {};

type Draw = number[];
const draws: Draw[] = [];
let encodedAt: number[] = [];

// Canvas stub: records the drawImage source rect and the quality of each encode
// attempt, and returns a blob whose size is dictated by the test.
let blobSizeFor: (quality: number) => number = () => 20_000;

(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => {},
        drawImage: (_img: unknown, ...rest: number[]) => draws.push(rest),
      }),
      toBlob: (cb: (b: unknown) => void, type: string, quality: number) => {
        encodedAt.push(quality);
        cb({ size: blobSizeFor(quality), type });
      },
    };
    return canvas;
  },
};

(globalThis as unknown as { URL: unknown }).URL = {
  createObjectURL: () => "blob:stub",
  revokeObjectURL: () => {},
};

// Image stub: `src = …` resolves onload with the dimensions the test asked for,
// or fails like a format this browser can't decode.
let sourceSize = { w: 800, h: 400 };
let decodeFails = false;
(globalThis as unknown as { Image: unknown }).Image = class {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_v: string) {
    if (decodeFails) {
      queueMicrotask(() => this.onerror?.());
      return;
    }
    this.naturalWidth = sourceSize.w;
    this.naturalHeight = sourceSize.h;
    queueMicrotask(() => this.onload?.());
  }
};

const store = new Map<string, string>([["chess_token", "tok-123"]]);
const dispatched: string[] = [];
(globalThis as unknown as { window: unknown }).window = {
  dispatchEvent: (e: { type: string }) => {
    dispatched.push(e.type);
    return true;
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as unknown as { Event: unknown }).Event = class {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
}

const fakeFile = (type = "image/png", size = 1000, name = "photo.png") =>
  ({ type, size, name }) as File;

async function main() {
  const { AVATAR_EVENT, AVATAR_PX, avatarUrl, removeAvatar, toSquareJpeg, uploadAvatar } =
    await import("../lib/avatar");
  const { SERVER_HTTP } = await import("../lib/config");

  // --- the URL is the cache key -------------------------------------------
  // No photo → no URL, so the head falls back to the ♟ glyph.
  check("no version means no photo", avatarUrl("0xABC", null), null);
  const url = avatarUrl("0xABC", "2026-08-09T06:23:43.912542+00:00");
  check(
    "address is lowercased and the version is escaped",
    url,
    `${SERVER_HTTP}/players/0xabc/avatar?v=2026-08-09T06%3A23%3A43.912542%2B00%3A00`,
  );
  // The `+` in the timestamp MUST survive as %2B: raw, it decodes to a space
  // server-side, so every profile would request one stable wrong URL and a
  // replaced photo would stay replaced-but-invisible behind the cache.
  check("the timezone + is escaped, not left to decode as a space", url?.includes("%2B"), true);

  // --- the crop ------------------------------------------------------------
  draws.length = 0;
  sourceSize = { w: 800, h: 400 };
  await toSquareJpeg(fakeFile());
  // Landscape: take the middle 400x400, i.e. skip 200px on the left.
  check("wide source is centre-cropped", draws[0], [200, 0, 400, 400, 0, 0, AVATAR_PX, AVATAR_PX]);

  draws.length = 0;
  sourceSize = { w: 300, h: 900 };
  await toSquareJpeg(fakeFile());
  check("tall source is centre-cropped", draws[0], [0, 300, 300, 300, 0, 0, AVATAR_PX, AVATAR_PX]);

  draws.length = 0;
  sourceSize = { w: 64, h: 64 };
  await toSquareJpeg(fakeFile());
  // Already square and smaller than the target: upscaled, never letterboxed.
  check("square source is used whole", draws[0], [0, 0, 64, 64, 0, 0, AVATAR_PX, AVATAR_PX]);

  // --- the size cap --------------------------------------------------------
  encodedAt = [];
  sourceSize = { w: 800, h: 400 };
  blobSizeFor = () => 20_000;
  await toSquareJpeg(fakeFile());
  check("a small result encodes once", encodedAt, [0.85]);

  encodedAt = [];
  blobSizeFor = (q) => (q > 0.7 ? 500_000 : 100_000);
  const stepped = await toSquareJpeg(fakeFile());
  check("an oversized result steps the quality down", encodedAt, [0.85, 0.7]);
  check("and returns the one that fits", stepped.size, 100_000);

  encodedAt = [];
  blobSizeFor = () => 500_000;
  let tooBig = "";
  try {
    await toSquareJpeg(fakeFile());
  } catch (e) {
    tooBig = (e as Error).message;
  }
  // Better a refusal here than a 413 after the round trip.
  check("nothing over the cap is uploaded", tooBig.startsWith("Couldn’t shrink"), true);
  check("every quality step was tried first", encodedAt, [0.85, 0.7, 0.55]);

  // A non-image never reaches the canvas.
  let rejected = "";
  try {
    await toSquareJpeg(fakeFile("application/pdf", 1000, "notes.pdf"));
  } catch (e) {
    rejected = (e as Error).message;
  }
  check("a non-image is refused", rejected, "That file isn’t an image.");

  // --- the HEIC dead end ---------------------------------------------------
  // An iPhone photo decodes in Safari and not in desktop Chrome, so the same
  // file works on someone's phone and fails on their laptop. A bare "couldn't
  // read that image" sounds like the file is broken; this one says what to do.
  decodeFails = true;
  const heicMsg = async (file: File) => {
    try {
      await toSquareJpeg(file);
      return "(no error)";
    } catch (e) {
      return (e as Error).message;
    }
  };
  check(
    "a HEIC that won't decode says so",
    (await heicMsg(fakeFile("image/heic", 1000, "IMG_1.HEIC"))).startsWith("This browser can’t"),
    true,
  );
  // Dragged out of Photos, one can arrive with no MIME type at all — the name
  // is then the only clue, and the generic "isn't an image" would have won.
  check(
    "…even with an empty MIME type",
    (await heicMsg(fakeFile("", 1000, "IMG_2.heic"))).startsWith("This browser can’t"),
    true,
  );
  check(
    "any other undecodable image stays generic",
    await heicMsg(fakeFile("image/png", 1000, "broken.png")),
    "Couldn’t read that image.",
  );
  decodeFails = false;

  // --- what goes on the wire ----------------------------------------------
  const calls: { url: string; method?: string; type: string | null; auth: string | null }[] = [];
  let status = 204;
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    u: string,
    init: RequestInit = {},
  ) => {
    const h = new Headers(init.headers);
    calls.push({
      url: u,
      method: init.method,
      type: h.get("content-type"),
      auth: h.get("authorization"),
    });
    return { status, ok: status >= 200 && status < 300 } as Response;
  };

  blobSizeFor = () => 20_000;
  await uploadAvatar(await toSquareJpeg(fakeFile()));
  check("upload posts the image itself", calls[0]?.method, "POST");
  check("to the session-bound route (no address in it)", calls[0]?.url, `${SERVER_HTTP}/profile/avatar`);
  check("typed as jpeg, which is what the server sniffs", calls[0]?.type, "image/jpeg");
  check("carrying the SIWE session", calls[0]?.auth, "Bearer tok-123");

  // The header chip lives in a different branch of the React tree, so without
  // this event it keeps showing the old picture (or the pawn) until a reload.
  check("a successful upload announces itself", dispatched, [AVATAR_EVENT]);

  await removeAvatar();
  check("remove deletes the same route", [calls[1]?.method, calls[1]?.url], [
    "DELETE",
    `${SERVER_HTTP}/profile/avatar`,
  ]);
  check("and removing announces itself too", dispatched, [AVATAR_EVENT, AVATAR_EVENT]);

  // A dead session says so, rather than surfacing a bare status code.
  const { SESSION_EXPIRED } = await import("../lib/authedFetch");
  status = 401;
  let expired = "";
  try {
    await uploadAvatar({ size: 10, type: "image/jpeg" } as Blob);
  } catch (e) {
    expired = (e as Error).message;
  }
  check("a stale session is named", expired, SESSION_EXPIRED);

  status = 415;
  let unsupported = "";
  try {
    await uploadAvatar({ size: 10, type: "image/jpeg" } as Blob);
  } catch (e) {
    unsupported = (e as Error).message;
  }
  check("so is a format the server won't store", unsupported.includes("PNG or JPEG"), true);
  // A failed write must not tell the header to go and refetch a photo that
  // didn't change — the pawn would flash back for no reason. Counted by type,
  // not by total: the 401 above legitimately fires AUTH_EVENT as it drops the
  // dead session.
  check(
    "a rejected write announces no photo change",
    dispatched.filter((e) => e === AVATAR_EVENT).length,
    2,
  );

  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
