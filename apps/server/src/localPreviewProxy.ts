import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { Cause, Effect, FileSystem, Layer, Stream } from "effect";
import { Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import { ServerAuth } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { isLoopbackStartupBearer, requestPeer } from "./startupAccess";
import { isTrustedAppOrigin, normalizeCorsOrigin } from "./trustedOrigins";

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

export const LOCAL_PREVIEW_SESSION_ROUTE_PATH = "/api/local-preview/session" as const;
export const LOCAL_PREVIEW_PROXY_ROUTE_PREFIX = "/api/local-preview/" as const;
export const LOCAL_PREVIEW_COOKIE_NAME = "moss_preview_token" as const;

export const MAX_LOCAL_PREVIEW_SESSIONS = 32;
export const LOCAL_PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_HTML_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_JSON_BYTES = 16 * 1024;
const UPSTREAM_REQUEST_TIMEOUT_MS = 30_000;

const TOKEN_HEX_PATTERN = /^[a-f0-9]{64}$/u;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// Dedicated agent with keepAlive disabled ensures node:http connects straight
// to loopback and never picks up HTTP_PROXY / HTTPS_PROXY environment agents.
const loopbackHttpAgent = new http.Agent({ keepAlive: false });

export interface LocalPreviewProxySession {
  readonly token: string;
  readonly port: number;
  readonly connectHost: "127.0.0.1" | "::1";
  readonly allowIpv6Fallback: boolean;
  readonly originLabel: string;
  expiresAtMs: number;
}

const sessionsByToken = new Map<string, LocalPreviewProxySession>();

function pruneExpiredSessions(nowMs = Date.now()): void {
  for (const [token, session] of sessionsByToken) {
    if (session.expiresAtMs <= nowMs) {
      sessionsByToken.delete(token);
    }
  }
}

export function clearLocalPreviewProxySessions(): void {
  sessionsByToken.clear();
}

export function getLocalPreviewProxySession(
  token: string | null | undefined,
): LocalPreviewProxySession | null {
  if (!token || !TOKEN_HEX_PATTERN.test(token)) return null;
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);
  const session = sessionsByToken.get(token);
  if (!session || session.expiresAtMs <= nowMs) return null;
  session.expiresAtMs = nowMs + LOCAL_PREVIEW_SESSION_TTL_MS;
  // Refresh LRU order.
  sessionsByToken.delete(token);
  sessionsByToken.set(token, session);
  return session;
}

export interface ValidatedLocalPreviewTarget {
  readonly url: URL;
  readonly port: number;
  readonly connectHost: "127.0.0.1" | "::1";
  readonly allowIpv6Fallback: boolean;
  readonly originLabel: string;
}

export function validateLocalPreviewTargetUrl(
  rawUrl: string,
  forbiddenPorts: readonly number[] = [],
): ValidatedLocalPreviewTarget | null {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\r\n\0]/u.test(trimmed) || !/^http:\/\//iu.test(trimmed)) {
    return null;
  }

  const afterScheme = trimmed.slice("http://".length);
  const boundaryIdx = afterScheme.search(/[/?#]/u);
  const rawAuthority = boundaryIdx >= 0 ? afterScheme.slice(0, boundaryIdx) : afterScheme;
  if (!rawAuthority || rawAuthority.includes("@") || rawAuthority.includes("\\")) {
    return null;
  }

  let connectHost: "127.0.0.1" | "::1";
  let allowIpv6Fallback = false;
  let portStr: string;

  const ipv6Match = /^\[::1\]:([1-9]\d{3,4})$/u.exec(rawAuthority);
  if (ipv6Match) {
    connectHost = "::1";
    portStr = ipv6Match[1]!;
  } else {
    const ipv4OrLocalMatch = /^(127\.0\.0\.1|localhost):([1-9]\d{3,4})$/iu.exec(rawAuthority);
    if (!ipv4OrLocalMatch) return null;
    const hostLower = ipv4OrLocalMatch[1]!.toLowerCase();
    connectHost = "127.0.0.1";
    allowIpv6Fallback = hostLower === "localhost";
    portStr = ipv4OrLocalMatch[2]!;
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    return null;
  }
  if (forbiddenPorts.some((forbidden) => forbidden > 0 && forbidden === port)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    Number(parsed.port) !== port
  ) {
    return null;
  }
  const normalizedHost = parsed.hostname.toLowerCase();
  if (
    normalizedHost !== "127.0.0.1" &&
    normalizedHost !== "localhost" &&
    normalizedHost !== "[::1]"
  ) {
    return null;
  }

  return {
    url: parsed,
    port,
    connectHost,
    allowIpv6Fallback,
    originLabel: parsed.host,
  };
}

export function createLocalPreviewProxySession(target: ValidatedLocalPreviewTarget): {
  readonly session: LocalPreviewProxySession;
  readonly token: string;
  readonly previewPath: string;
  readonly originLabel: string;
  readonly expiresAt: string;
} {
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);
  while (sessionsByToken.size >= MAX_LOCAL_PREVIEW_SESSIONS) {
    const oldest = sessionsByToken.keys().next().value;
    if (oldest === undefined) break;
    sessionsByToken.delete(oldest);
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAtMs = nowMs + LOCAL_PREVIEW_SESSION_TTL_MS;
  const session: LocalPreviewProxySession = {
    token,
    port: target.port,
    connectHost: target.connectHost,
    allowIpv6Fallback: target.allowIpv6Fallback,
    originLabel: target.originLabel,
    expiresAtMs,
  };
  sessionsByToken.set(token, session);

  return {
    session,
    token,
    previewPath: `${LOCAL_PREVIEW_PROXY_ROUTE_PREFIX}${token}${target.url.pathname}${target.url.search}`,
    originLabel: target.originLabel,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function proxyCorsHeaders(input: {
  readonly config: ServerConfigShape;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}): Record<string, string> {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (
    !origin ||
    !isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config })
  ) {
    return { Vary: "Origin" };
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

const requireAuthenticatedSessionCreateRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  if (
    isLoopbackStartupBearer({
      ...config,
      authorization: request.headers.authorization,
      peer: requestPeer(request),
    })
  ) {
    return;
  }
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

function parseCookiePairs(cookieHeader: string | undefined): Array<[string, string]> {
  if (!cookieHeader) return [];
  const pairs: Array<[string, string]> = [];
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (name) pairs.push([name, value]);
  }
  return pairs;
}

function readCookieValue(cookieHeader: string | undefined, targetName: string): string | null {
  for (const [name, value] of parseCookiePairs(cookieHeader)) {
    if (name === targetName) return value;
  }
  return null;
}

function isMossInternalCookieName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === LOCAL_PREVIEW_COOKIE_NAME ||
    lower === "moss_session" ||
    lower.startsWith("moss_session_")
  );
}

export function filterForwardCookieHeader(cookieHeader: string | undefined): string | undefined {
  const filtered = parseCookiePairs(cookieHeader)
    .filter(([name]) => !isMossInternalCookieName(name))
    .map(([name, value]) => `${name}=${value}`);
  return filtered.length > 0 ? filtered.join("; ") : undefined;
}

export function stripFrameAncestorsFromCsp(csp: string): string | null {
  const kept = csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0 && !/^frame-ancestors(?:\s|$)/iu.test(directive));
  return kept.length > 0 ? kept.join("; ") : null;
}

export function rewriteUpstreamLocation(location: string, token: string, port: number): string {
  const prefix = `${LOCAL_PREVIEW_PROXY_ROUTE_PREFIX}${token}`;
  for (const origin of [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]) {
    if (location.toLowerCase().startsWith(origin.toLowerCase())) {
      const rest = location.slice(origin.length);
      if (rest === "") return `${prefix}/`;
      if (rest.startsWith("/")) return `${prefix}${rest}`;
      if (rest.startsWith("?") || rest.startsWith("#")) return `${prefix}/${rest}`;
    }
  }
  if (location.startsWith("/") && !location.startsWith("//")) {
    if (location.startsWith(`${prefix}/`) || location === prefix) {
      return location;
    }
    return `${prefix}${location}`;
  }
  return location;
}

export function rewriteUpstreamSetCookie(
  setCookie: string,
  token: string,
  isPlainHttp: boolean,
): string {
  const parts = setCookie.split(";").map((part) => part.trim());
  if (parts.length === 0) return setCookie;
  const prefix = `${LOCAL_PREVIEW_PROXY_ROUTE_PREFIX}${token}`;
  const out: string[] = [parts[0]!];
  let hasPath = false;

  for (let i = 1; i < parts.length; i += 1) {
    const attr = parts[i]!;
    if (!attr) continue;
    const eqIdx = attr.indexOf("=");
    const attrName = (eqIdx >= 0 ? attr.slice(0, eqIdx) : attr).trim().toLowerCase();
    const attrValue = eqIdx >= 0 ? attr.slice(eqIdx + 1).trim() : "";
    if (attrName === "domain") continue;
    if (attrName === "secure" && isPlainHttp) continue;
    if (attrName === "path") {
      hasPath = true;
      const normalizedPath = attrValue.startsWith("/") ? attrValue : `/${attrValue}`;
      const rewrittenPath = normalizedPath.startsWith(`${prefix}/`)
        ? normalizedPath
        : `${prefix}${normalizedPath}`;
      out.push(`Path=${rewrittenPath}`);
      continue;
    }
    out.push(attr);
  }

  if (!hasPath) {
    out.push(`Path=${prefix}/`);
  }
  return out.join("; ");
}

export function rewritePreviewHtml(html: string, token: string): string {
  const baseHref = `${LOCAL_PREVIEW_PROXY_ROUTE_PREFIX}${token}/`;
  let rewritten = html
    .replace(
      /(^|[\s<])(src|href|action)\s*=\s*(["'])\/(?!\/|api\/local-preview\/)/giu,
      `$1$2=$3${baseHref}`,
    )
    .replace(/\b(from\s*)(["'])\/(?!\/|api\/local-preview\/)/giu, `$1$2${baseHref}`)
    .replace(
      /\b(import\s*\(\s*|import\s+)(["'])\/(?!\/|api\/local-preview\/)/giu,
      `$1$2${baseHref}`,
    );

  if (/<base\b[^>]*\bhref\s*=/iu.test(rewritten)) {
    rewritten = rewritten.replace(
      /<base\b([^>]*?)\bhref\s*=\s*(["'])\/\2([^>]*)>/iu,
      `<base$1href=$2${baseHref}$2$3>`,
    );
  } else if (/<head(?:\s[^>]*)?>/iu.test(rewritten)) {
    rewritten = rewritten.replace(
      /<head(?:\s[^>]*)?>/iu,
      (match) => `${match}<base href="${baseHref}">`,
    );
  } else {
    rewritten = `<base href="${baseHref}">${rewritten}`;
  }

  return rewritten;
}

function isSameOriginHeader(
  originHeader: string,
  requestOrigin: string | undefined,
  requestHost: string | undefined,
): boolean {
  if (requestOrigin && originHeader === requestOrigin) return true;
  if (!requestHost) return false;
  try {
    return new URL(originHeader).host === requestHost;
  } catch {
    return false;
  }
}

function buildUpstreamRequestHeaders(input: {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly port: number;
  readonly requestOrigin?: string | undefined;
  readonly preserveUpgradeHeaders?: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const rawRequestHost = typeof input.headers.host === "string" ? input.headers.host : undefined;
  for (const [rawKey, rawValue] of Object.entries(input.headers)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    if (key === "authorization" || key === "host" || key === "content-length") continue;
    if (!input.preserveUpgradeHeaders && HOP_BY_HOP_HEADERS.has(key)) continue;
    if (
      input.preserveUpgradeHeaders &&
      (key === "keep-alive" ||
        key === "proxy-authenticate" ||
        key === "proxy-authorization" ||
        key === "te" ||
        key === "trailers" ||
        key === "transfer-encoding")
    ) {
      continue;
    }
    const value = typeof rawValue === "string" ? rawValue : rawValue.join(", ");
    if (key === "cookie") {
      const cleaned = filterForwardCookieHeader(value);
      if (cleaned) out.cookie = cleaned;
      continue;
    }
    if (key === "accept-encoding" && !input.preserveUpgradeHeaders) {
      continue;
    }
    if (key === "origin" && isSameOriginHeader(value, input.requestOrigin, rawRequestHost)) {
      out.origin = `http://127.0.0.1:${input.port}`;
      continue;
    }
    out[key] = value;
  }
  out.host = `127.0.0.1:${input.port}`;
  if (!input.preserveUpgradeHeaders) {
    out["accept-encoding"] = "identity";
  }
  return out;
}

function extractTokenFromProxyPath(pathname: string): {
  readonly tokenInPath: string | null;
  readonly remainderPath: string;
} {
  if (!pathname.startsWith(LOCAL_PREVIEW_PROXY_ROUTE_PREFIX)) {
    return { tokenInPath: null, remainderPath: pathname || "/" };
  }
  const afterPrefix = pathname.slice(LOCAL_PREVIEW_PROXY_ROUTE_PREFIX.length);
  const slashIdx = afterPrefix.indexOf("/");
  const candidate = slashIdx >= 0 ? afterPrefix.slice(0, slashIdx) : afterPrefix;
  if (TOKEN_HEX_PATTERN.test(candidate)) {
    const rest = slashIdx >= 0 ? afterPrefix.slice(slashIdx) : "/";
    return { tokenInPath: candidate, remainderPath: rest || "/" };
  }
  return { tokenInPath: null, remainderPath: `/${afterPrefix}` };
}

function tokenFromReferer(referer: string | undefined, expectedOrigin?: string): string | null {
  if (!referer) return null;
  try {
    const parsed = new URL(referer, expectedOrigin ?? "http://127.0.0.1");
    if (expectedOrigin && parsed.origin !== expectedOrigin) return null;
    const { tokenInPath } = extractTokenFromProxyPath(parsed.pathname);
    return tokenInPath;
  } catch {
    return null;
  }
}

function resolveProxySessionForRequest(input: {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly allowRootFallback: boolean;
}): {
  readonly session: LocalPreviewProxySession;
  readonly targetPathAndQuery: string;
} | null {
  const cookieHeader = typeof input.headers.cookie === "string" ? input.headers.cookie : undefined;
  const refererHeader =
    typeof input.headers.referer === "string" ? input.headers.referer : undefined;
  const { tokenInPath, remainderPath } = extractTokenFromProxyPath(input.url.pathname);

  if (tokenInPath) {
    const session = getLocalPreviewProxySession(tokenInPath);
    if (!session) return null;
    return {
      session,
      targetPathAndQuery: `${remainderPath}${input.url.search}`,
    };
  }

  if (
    !input.allowRootFallback &&
    !input.url.pathname.startsWith(LOCAL_PREVIEW_PROXY_ROUTE_PREFIX)
  ) {
    return null;
  }

  const queryToken = input.url.searchParams.get("token");
  const cookieToken = readCookieValue(cookieHeader, LOCAL_PREVIEW_COOKIE_NAME);
  const refToken = tokenFromReferer(refererHeader, input.url.origin);

  const fallbackToken =
    (queryToken && TOKEN_HEX_PATTERN.test(queryToken) ? queryToken : null) ??
    (cookieToken && TOKEN_HEX_PATTERN.test(cookieToken) ? cookieToken : null) ??
    refToken;

  const session = getLocalPreviewProxySession(fallbackToken);
  if (!session) return null;

  const targetUrl = new URL(remainderPath + input.url.search, "http://127.0.0.1");
  if (queryToken && queryToken === session.token) {
    targetUrl.searchParams.delete("token");
  }
  return {
    session,
    targetPathAndQuery: `${targetUrl.pathname}${targetUrl.search}`,
  };
}

function requestUpstreamHttp(input: {
  readonly session: LocalPreviewProxySession;
  readonly method: string;
  readonly targetPathAndQuery: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}): Promise<http.IncomingMessage> {
  const attempt = (host: "127.0.0.1" | "::1") =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const upstreamReq = http.request(
        {
          host,
          port: input.session.port,
          family: host === "::1" ? 6 : 4,
          path: input.targetPathAndQuery,
          method: input.method,
          headers:
            input.body !== null && input.body.byteLength > 0
              ? { ...input.headers, "content-length": String(input.body.byteLength) }
              : input.headers,
          agent: loopbackHttpAgent,
          timeout: UPSTREAM_REQUEST_TIMEOUT_MS,
        },
        (res) => resolve(res),
      );
      upstreamReq.on("timeout", () => {
        upstreamReq.destroy(new Error("Upstream local preview request timed out."));
      });
      upstreamReq.on("error", reject);
      if (input.body !== null && input.body.byteLength > 0) {
        upstreamReq.end(input.body);
      } else {
        upstreamReq.end();
      }
    });

  return attempt(input.session.connectHost).catch((error: NodeJS.ErrnoException) => {
    if (
      input.session.allowIpv6Fallback &&
      input.session.connectHost === "127.0.0.1" &&
      error?.code === "ECONNREFUSED"
    ) {
      return attempt("::1");
    }
    throw error;
  });
}

async function readIncomingMessageUpTo(
  res: http.IncomingMessage,
  maxBytes: number,
): Promise<{ readonly buffer: Buffer; readonly overflowed: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      res.destroy();
      return { buffer: Buffer.concat(chunks), overflowed: true };
    }
    chunks.push(buf);
  }
  return { buffer: Buffer.concat(chunks), overflowed: false };
}

async function decompressBodyIfNeeded(
  buffer: Buffer,
  contentEncoding: string | undefined,
): Promise<{ readonly buffer: Buffer; readonly decompressed: boolean }> {
  const enc = contentEncoding?.split(",")[0]?.trim().toLowerCase();
  if (!enc || enc === "identity") return { buffer, decompressed: false };
  if (enc === "gzip" || enc === "x-gzip") {
    return { buffer: await gunzipAsync(buffer), decompressed: true };
  }
  if (enc === "deflate") {
    return { buffer: await inflateAsync(buffer), decompressed: true };
  }
  if (enc === "br") {
    return { buffer: await brotliDecompressAsync(buffer), decompressed: true };
  }
  return { buffer, decompressed: false };
}

function buildProxiedResponseHeaders(input: {
  readonly upstreamHeaders: http.IncomingHttpHeaders;
  readonly token: string;
  readonly port: number;
  readonly isPlainHttp: boolean;
}): {
  readonly headers: Record<string, string>;
  readonly setCookies: string[];
} {
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(input.upstreamHeaders)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || key === "x-frame-options") continue;
    if (key === "set-cookie") {
      const list = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const item of list) {
        setCookies.push(rewriteUpstreamSetCookie(item, input.token, input.isPlainHttp));
      }
      continue;
    }
    const joined = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (key === "content-security-policy" || key === "content-security-policy-report-only") {
      const stripped = stripFrameAncestorsFromCsp(joined);
      if (stripped !== null) headers[key] = stripped;
      continue;
    }
    if (key === "location") {
      headers.location = rewriteUpstreamLocation(joined, input.token, input.port);
      continue;
    }
    headers[key] = joined;
  }

  return { headers, setCookies };
}

export function proxyRequestToLocalSession(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly session: LocalPreviewProxySession;
  readonly targetPathAndQuery: string;
}): Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return Effect.gen(function* () {
    const { request, url, session, targetPathAndQuery } = input;
    const hasRequestBody =
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
    const bodyBytes = hasRequestBody
      ? yield* request.arrayBuffer.pipe(
          Effect.provideService(
            HttpServerRequest.MaxBodySize,
            FileSystem.Size(MAX_PROXY_REQUEST_BODY_BYTES),
          ),
          Effect.map((buf) => new Uint8Array(buf)),
          Effect.mapError((cause) => ({
            status: Cause.isExceededCapacityError(cause) ? 413 : 400,
            message: Cause.isExceededCapacityError(cause)
              ? "Request body too large."
              : "Invalid request body.",
          })),
        )
      : null;

    const upstreamHeaders = buildUpstreamRequestHeaders({
      headers: request.headers,
      port: session.port,
      requestOrigin: url.origin,
    });

    const upstreamRes = yield* Effect.tryPromise({
      try: () =>
        requestUpstreamHttp({
          session,
          method: request.method,
          targetPathAndQuery,
          headers: upstreamHeaders,
          body: bodyBytes,
        }),
      catch: () => ({ status: 502, message: "Local preview target is unreachable." }),
    });

    const status = upstreamRes.statusCode ?? 502;
    const { headers, setCookies } = buildProxiedResponseHeaders({
      upstreamHeaders: upstreamRes.headers,
      token: session.token,
      port: session.port,
      isPlainHttp: url.protocol === "http:" && request.headers["x-forwarded-proto"] !== "https",
    });

    const contentType = headers["content-type"] ?? "";
    const isHtml = /^text\/html(?:;|$)/iu.test(contentType.trim());
    const noBody =
      request.method === "HEAD" ||
      status === 204 ||
      status === 304 ||
      (status >= 100 && status < 200);

    let cookies = Cookies.fromSetCookie(setCookies);
    if (isHtml) {
      cookies = Cookies.setUnsafe(cookies, LOCAL_PREVIEW_COOKIE_NAME, session.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      });
    }

    if (noBody) {
      upstreamRes.resume();
      return HttpServerResponse.empty({ status, headers, cookies });
    }

    if (isHtml) {
      const buffered = yield* Effect.tryPromise({
        try: () => readIncomingMessageUpTo(upstreamRes, MAX_HTML_REWRITE_BYTES),
        catch: () => ({ status: 502, message: "Failed reading local preview HTML." }),
      });
      if (buffered.overflowed) {
        return HttpServerResponse.text("Local preview HTML exceeded size limit.", { status: 502 });
      }
      const decompressed = yield* Effect.tryPromise({
        try: () => decompressBodyIfNeeded(buffered.buffer, headers["content-encoding"]),
        catch: () => ({ status: 502, message: "Failed decoding local preview HTML." }),
      });
      if (decompressed.decompressed) {
        delete headers["content-encoding"];
      }
      const rewrittenText = rewritePreviewHtml(decompressed.buffer.toString("utf8"), session.token);
      const rewrittenBytes = Buffer.from(rewrittenText, "utf8");
      delete headers["content-length"];
      return HttpServerResponse.uint8Array(rewrittenBytes, {
        status,
        contentType: contentType || "text/html; charset=utf-8",
        headers: {
          ...headers,
          "content-length": String(rewrittenBytes.byteLength),
        },
        cookies,
      });
    }

    const parsedContentLength = headers["content-length"]
      ? Number(headers["content-length"])
      : undefined;
    const responseStream = Stream.fromReadableStream({
      evaluate: () => Readable.toWeb(upstreamRes) as unknown as ReadableStream<Uint8Array>,
      onError: (cause) => cause,
    });

    return HttpServerResponse.stream(responseStream, {
      status,
      ...(contentType ? { contentType } : {}),
      ...(parsedContentLength !== undefined &&
      Number.isSafeInteger(parsedContentLength) &&
      parsedContentLength > 0
        ? { contentLength: parsedContentLength }
        : {}),
      headers,
      cookies,
    });
  }).pipe(
    Effect.catch((failure: { readonly status?: number; readonly message?: string }) =>
      Effect.succeed(
        HttpServerResponse.text(failure?.message ?? "Local preview proxy error.", {
          status: failure?.status ?? 502,
        }),
      ),
    ),
  );
}

const createSessionRoute = HttpRouter.add(
  "*",
  LOCAL_PREVIEW_SESSION_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const config = yield* ServerConfig;
    const corsHeaders = proxyCorsHeaders({ config, request, url });

    if (request.method === "OPTIONS") {
      return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return HttpServerResponse.text("Method Not Allowed", {
        status: 405,
        headers: { ...corsHeaders, Allow: "POST, OPTIONS" },
      });
    }

    yield* requireAuthenticatedSessionCreateRequest;

    const rawBody = yield* request.json.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(MAX_SESSION_JSON_BYTES)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Expected JSON body { url: string }." },
        { status: 400, headers: corsHeaders },
      );
    }
    const candidateUrl = (rawBody as { readonly url?: unknown }).url;
    if (typeof candidateUrl !== "string") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Missing target url." },
        { status: 400, headers: corsHeaders },
      );
    }

    const requestPort = url.port ? Number(url.port) : 0;
    const validated = validateLocalPreviewTargetUrl(candidateUrl, [
      config.port,
      ...(Number.isInteger(requestPort) && requestPort > 0 ? [requestPort] : []),
    ]);
    if (!validated) {
      return HttpServerResponse.jsonUnsafe(
        {
          error:
            "Target URL must be http://127.0.0.1, localhost, or [::1] on port 1024-65535 (excluding Moss server port).",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const created = createLocalPreviewProxySession(validated);
    return HttpServerResponse.jsonUnsafe(
      {
        token: created.token,
        previewPath: created.previewPath,
        originLabel: created.originLabel,
        expiresAt: created.expiresAt,
      },
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-store",
        },
      },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

const proxyRoute = HttpRouter.add(
  "*",
  `${LOCAL_PREVIEW_PROXY_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    if (url.pathname === LOCAL_PREVIEW_SESSION_ROUTE_PATH) {
      return HttpServerResponse.text("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      });
    }

    const resolved = resolveProxySessionForRequest({
      url,
      headers: request.headers,
      allowRootFallback: false,
    });
    if (!resolved) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* proxyRequestToLocalSession({
      request,
      url,
      session: resolved.session,
      targetPathAndQuery: resolved.targetPathAndQuery,
    });
  }),
);

export const localPreviewProxyEffectRouteLayer = Layer.mergeAll(createSessionRoute, proxyRoute);

export function proxyFallbackPreviewRequest(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: ServerConfigShape;
}) {
  const { request, url, config } = input;
  const pathname = url.pathname;
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/ws") ||
    pathname.startsWith("/attachments/") ||
    pathname.startsWith("/canvas") ||
    pathname === "/health"
  ) {
    return Effect.succeed(null);
  }

  const refererHeader =
    typeof request.headers.referer === "string" ? request.headers.referer : undefined;
  const hasLocalPreviewReferer = tokenFromReferer(refererHeader, url.origin) !== null;
  if (pathname === "/" && !hasLocalPreviewReferer) {
    return Effect.succeed(null);
  }
  if ((config.staticDir !== undefined || config.devUrl !== undefined) && !hasLocalPreviewReferer) {
    return Effect.succeed(null);
  }

  const resolved = resolveProxySessionForRequest({
    url,
    headers: request.headers,
    allowRootFallback: true,
  });
  if (!resolved) return Effect.succeed(null);

  return proxyRequestToLocalSession({
    request,
    url,
    session: resolved.session,
    targetPathAndQuery: resolved.targetPathAndQuery,
  });
}

function writeRawUpgradeRejection(socket: Duplex, status: number, message: string): void {
  if (!socket.writable || socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.end();
}

function isMossReservedUpgradePath(pathname: string): boolean {
  return (
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    (pathname.startsWith("/api/") && !pathname.startsWith(LOCAL_PREVIEW_PROXY_ROUTE_PREFIX))
  );
}

export function handleLocalPreviewWsUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  let parsedUrl: URL;
  try {
    const hostHeader =
      typeof req.headers.host === "string" && req.headers.host ? req.headers.host : "127.0.0.1";
    parsedUrl = new URL(req.url ?? "/", `http://${hostHeader}`);
  } catch {
    if ((req.url ?? "").startsWith(LOCAL_PREVIEW_PROXY_ROUTE_PREFIX)) {
      socket.on("error", () => undefined);
      writeRawUpgradeRejection(socket, 400, "Bad Request");
      return true;
    }
    return false;
  }

  const pathname = parsedUrl.pathname;
  const isExplicitPrefix = pathname.startsWith(LOCAL_PREVIEW_PROXY_ROUTE_PREFIX);
  if (!isExplicitPrefix && isMossReservedUpgradePath(pathname)) {
    return false;
  }

  const resolved = resolveProxySessionForRequest({
    url: parsedUrl,
    headers: req.headers,
    allowRootFallback: !isExplicitPrefix,
  });
  if (!resolved) {
    if (!isExplicitPrefix) return false;
    socket.on("error", () => undefined);
    writeRawUpgradeRejection(socket, 404, "Not Found");
    return true;
  }

  const { session, targetPathAndQuery } = resolved;
  const upstreamHeaders = buildUpstreamRequestHeaders({
    headers: req.headers,
    port: session.port,
    requestOrigin: parsedUrl.origin,
    preserveUpgradeHeaders: true,
  });

  let closed = false;
  let upstreamSocketRef: Duplex | null = null;
  let activeUpstreamReq: http.ClientRequest | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeUpstreamReq?.destroy();
    if (upstreamSocketRef && !upstreamSocketRef.destroyed) {
      upstreamSocketRef.end();
    }
    if (!socket.destroyed) {
      socket.end();
    }
  };

  socket.on("error", () => {
    closed = true;
    activeUpstreamReq?.destroy();
    upstreamSocketRef?.destroy();
  });
  socket.on("close", () => {
    closed = true;
    activeUpstreamReq?.destroy();
    if (upstreamSocketRef && !upstreamSocketRef.destroyed) {
      upstreamSocketRef.end();
    }
  });

  const connect = (host: "127.0.0.1" | "::1", canFallbackIpv6: boolean) => {
    const upstreamReq = http.request({
      host,
      port: session.port,
      family: host === "::1" ? 6 : 4,
      path: targetPathAndQuery,
      method: req.method ?? "GET",
      headers: upstreamHeaders,
      agent: loopbackHttpAgent,
    });
    activeUpstreamReq = upstreamReq;

    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      if (closed || socket.destroyed) {
        upstreamSocket.end();
        return;
      }
      upstreamSocketRef = upstreamSocket;

      const lines = [
        `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`,
      ];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        const name = upstreamRes.rawHeaders[i]!;
        const value = upstreamRes.rawHeaders[i + 1] ?? "";
        lines.push(`${name}: ${value}`);
      }
      lines.push("", "");

      socket.write(lines.join("\r\n"));
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);

      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);

      upstreamSocket.on("error", () => {
        if (!socket.destroyed) socket.destroy();
      });
      upstreamSocket.on("end", () => {
        if (!socket.destroyed) socket.end();
      });
      upstreamSocket.on("close", cleanup);
    });

    upstreamReq.on("response", (upstreamRes) => {
      if (closed || socket.destroyed) {
        upstreamRes.resume();
        return;
      }
      const lines = [
        `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Bad Gateway"}`,
      ];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      }
      lines.push("", "");
      socket.write(lines.join("\r\n"));
      upstreamRes.pipe(socket);
      upstreamRes.on("end", () => socket.end());
      upstreamRes.on("error", () => socket.destroy());
    });

    upstreamReq.on("error", (error: NodeJS.ErrnoException) => {
      if (closed || socket.destroyed) return;
      if (canFallbackIpv6 && error?.code === "ECONNREFUSED") {
        connect("::1", false);
        return;
      }
      writeRawUpgradeRejection(socket, 502, "Bad Gateway");
    });

    upstreamReq.end();
  };

  connect(session.connectHost, session.allowIpv6Fallback && session.connectHost === "127.0.0.1");
  return true;
}
