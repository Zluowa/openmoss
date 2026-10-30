// FILE: htmlRenderFrameAccess.ts
// Purpose: Page-scoped access for the sandboxed frames that show `html_render` pages.
// Layer: Shared runtime utility (Web Crypto; runs in browsers and Node)

/**
 * A framed page can read its own URL, so a frame URL must never carry the
 * server's startup token. A client holding that token signs one attachment
 * path and an expiry with it instead, and the server accepts the signature
 * for that page alone until it expires.
 */
export const HTML_RENDER_FRAME_ACCESS_TTL_MS = 10 * 60_000;
export const HTML_RENDER_FRAME_EXPIRES_PARAM = "expires";
export const HTML_RENDER_FRAME_SIGNATURE_PARAM = "signature";

// Desktop client and server share one clock; this only absorbs a slow sign-to-load.
const MAX_CLOCK_SKEW_MS = 60_000;

const encoder = new TextEncoder();

function frameAccessMessage(relativePath: string, expiresAtMs: number) {
  return encoder.encode(`moss-html-render-frame\n${relativePath}\n${expiresAtMs}`);
}

function importFrameAccessKey(token: string, usage: "sign" | "verify") {
  return globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function signHtmlRenderFrameAccess(input: {
  readonly token: string;
  readonly relativePath: string;
  readonly expiresAtMs: number;
}): Promise<string> {
  const key = await importFrameAccessKey(input.token, "sign");
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    frameAccessMessage(input.relativePath, input.expiresAtMs),
  );
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyHtmlRenderFrameAccess(input: {
  readonly token: string;
  readonly relativePath: string;
  readonly expires: string | null;
  readonly signature: string | null;
  readonly nowMs: number;
}): Promise<boolean> {
  if (input.token.length === 0 || input.expires === null || input.signature === null) {
    return false;
  }
  if (!/^\d{1,16}$/u.test(input.expires)) return false;
  const expiresAtMs = Number(input.expires);
  if (
    expiresAtMs <= input.nowMs ||
    expiresAtMs > input.nowMs + HTML_RENDER_FRAME_ACCESS_TTL_MS + MAX_CLOCK_SKEW_MS
  ) {
    return false;
  }
  const signature = fromBase64Url(input.signature);
  if (signature === null) return false;
  const key = await importFrameAccessKey(input.token, "verify");
  return globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    frameAccessMessage(input.relativePath, expiresAtMs),
  );
}
