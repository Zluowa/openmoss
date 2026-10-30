// FILE: inlineVisualizationFrameAccess.ts
// Purpose: Short-lived, content-locked access signatures for Codex inline visualization frames.
// Layer: Shared runtime utility (Web Crypto; runs in browsers and Node)

export const INLINE_VISUALIZATION_FRAME_ACCESS_TTL_MS = 10 * 60_000;
export const INLINE_VISUALIZATION_FRAME_EXPIRES_PARAM = "expires";
export const INLINE_VISUALIZATION_FRAME_SIGNATURE_PARAM = "signature";

const MAX_CLOCK_SKEW_MS = 60_000;
const encoder = new TextEncoder();

function message(input: {
  readonly threadId: string;
  readonly path: string;
  readonly sha256: string;
  readonly expiresAtMs: number;
}) {
  return encoder.encode(
    [
      "moss-inline-visualization-frame",
      input.threadId,
      input.path,
      input.sha256,
      String(input.expiresAtMs),
    ].join("\n"),
  );
}

async function key(token: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
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
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function signInlineVisualizationFrameAccess(input: {
  readonly token: string;
  readonly threadId: string;
  readonly path: string;
  readonly sha256: string;
  readonly expiresAtMs: number;
}) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(input.token, "sign"),
    message(input),
  );
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyInlineVisualizationFrameAccess(input: {
  readonly token: string;
  readonly threadId: string;
  readonly path: string;
  readonly sha256: string;
  readonly expires: string | null;
  readonly signature: string | null;
  readonly nowMs: number;
}) {
  const expiresAtMs = Number(input.expires);
  const signature = input.signature === null ? null : fromBase64Url(input.signature);
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= input.nowMs ||
    expiresAtMs > input.nowMs + INLINE_VISUALIZATION_FRAME_ACCESS_TTL_MS + MAX_CLOCK_SKEW_MS ||
    signature === null
  ) {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await key(input.token, "verify"),
    signature,
    message({ ...input, expiresAtMs }),
  );
}
