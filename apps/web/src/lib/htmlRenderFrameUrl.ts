// FILE: htmlRenderFrameUrl.ts
// Purpose: The URL a sandboxed frame loads an `html_render` page from.
// Layer: Web lib

import {
  HTML_RENDER_FRAME_ACCESS_TTL_MS,
  HTML_RENDER_FRAME_EXPIRES_PARAM,
  HTML_RENDER_FRAME_SIGNATURE_PARAM,
  signHtmlRenderFrameAccess,
} from "@synara/shared/htmlRenderFrameAccess";

import { resolveWsHttpUrl } from "./wsHttpUrl";

const ATTACHMENT_ID_PATTERN = /^[a-z0-9_-]{1,256}$/iu;
// A frame can load slightly after mounting. Match T3's asset behavior: reuse
// a healthy signed URL, but mint a new one before it gets close to expiry.
const MIN_URL_LIFE_MS = 5 * 60_000;

const signedUrlCache = new Map<string, { readonly url: string; readonly expiresAtMs: number }>();

function cacheKey(input: {
  readonly origin: string;
  readonly relativePath: string;
  readonly token: string;
}) {
  return `${input.origin}\n${input.relativePath}\n${input.token}`;
}

/** Test-only cache reset so expiry cases remain independent. */
export function resetHtmlRenderFrameUrlCacheForTests() {
  signedUrlCache.clear();
}

/**
 * The page's attachment URL for its sandboxed frame. The page can read this
 * URL, so the startup token desktop attachment URLs carry is replaced by a
 * signature that opens this one page for a few minutes. Null when the page
 * cannot be addressed or signed.
 */
export async function resolveHtmlRenderFrameUrl(
  attachmentId: string,
  nowMs = Date.now(),
  options: { readonly forceRefresh?: boolean } = {},
): Promise<string | null> {
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return null;
  const relativePath = `${attachmentId}.html`;
  let url: URL;
  try {
    url = new URL(resolveWsHttpUrl(`/attachments/${relativePath}`));
  } catch {
    return null;
  }
  const token = url.searchParams.get("token");
  if (token === null) return url.toString();
  url.searchParams.delete("token");
  const key = cacheKey({ origin: url.origin, relativePath, token });
  const cached = signedUrlCache.get(key);
  if (
    !options.forceRefresh &&
    cached !== undefined &&
    cached.expiresAtMs - nowMs > MIN_URL_LIFE_MS
  ) {
    return cached.url;
  }
  const expiresAtMs = nowMs + HTML_RENDER_FRAME_ACCESS_TTL_MS;
  try {
    const signature = await signHtmlRenderFrameAccess({ token, relativePath, expiresAtMs });
    url.searchParams.set(HTML_RENDER_FRAME_EXPIRES_PARAM, String(expiresAtMs));
    url.searchParams.set(HTML_RENDER_FRAME_SIGNATURE_PARAM, signature);
  } catch {
    return null;
  }
  const signedUrl = url.toString();
  signedUrlCache.set(key, { url: signedUrl, expiresAtMs });
  return signedUrl;
}
