import {
  MOSS_CLOUD_REGION_HEADER,
  type MossCloudRegion,
} from "@moss/shared/mossProductionPublicConfig";
import { isMossDeveloperApiKey, mossDeveloperApiKeyRealmHint } from "@moss/shared/mossRealmCatalog";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { mossCnModelGatewayEntries, mossRealtimeRelayEntries } from "./account/mossServiceEntries";
import { ServerConfig } from "./config";
import { mossManagedGatewayEntriesForAuthority } from "./provider/mossManagedGatewayTrust";
import { isTrustedAppOrigin, normalizeCorsOrigin } from "./trustedOrigins";

export const MOSS_DEVELOPER_GATEWAY_PREFIX = "/api/moss/developer/v1";

const SUPPORTED_GATEWAY_ENDPOINTS = new Set<string>([
  "GET /quota",
  "GET /models",
  "POST /chat/completions",
  "POST /responses",
  "POST /messages",
  "POST /images/generations",
  "POST /videos/generations",
  "POST /media/query",
  "POST /audio/transcriptions",
  "POST /audio/speech",
]);

function jsonErrorResponse(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: status === 401 ? "authentication_error" : "invalid_request_error",
        code,
        message,
      },
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function gatewayRootFromUrl(entryUrl: string): string {
  return entryUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

function resolveRegionGatewayRoot(region: MossCloudRegion): string | null {
  if (region === "cn") {
    const entries = mossCnModelGatewayEntries().entries;
    return entries[0] ? gatewayRootFromUrl(entries[0]) : null;
  }
  const entries = mossManagedGatewayEntriesForAuthority("supabase-google");
  return entries[0] ? gatewayRootFromUrl(entries[0]) : null;
}

function resolveRegionRealtimeOrigin(region: MossCloudRegion): string | null {
  try {
    const router = mossRealtimeRelayEntries(region);
    const first = router?.entries[0];
    return first ? first.replace(/\/+$/u, "") : null;
  } catch {
    return null;
  }
}

export async function forwardMossDeveloperGatewayRequest(input: {
  readonly method: string;
  readonly pathname: string;
  readonly search?: string;
  readonly headers: Headers;
  readonly bodyBytes?: Uint8Array | null;
  readonly resolveGatewayRoot?: (region: MossCloudRegion) => string | null;
  readonly resolveRealtimeOrigin?: (region: MossCloudRegion) => string | null;
  readonly fetcher?: typeof fetch;
}): Promise<Response> {
  const method = input.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Moss-Operation-Id",
        "Cache-Control": "no-store",
      },
    });
  }

  const authorization = input.headers.get("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/iu);
  const rawKey = match?.[1] ?? "";
  if (!isMossDeveloperApiKey(rawKey)) {
    return jsonErrorResponse(
      401,
      "invalid_developer_api_key",
      "请提供有效的 Moss 开发者 API Key（Authorization: Bearer moss_dk_...）。",
    );
  }

  const region: MossCloudRegion = mossDeveloperApiKeyRealmHint(rawKey) ?? "cn";
  const subpath = input.pathname.startsWith(MOSS_DEVELOPER_GATEWAY_PREFIX)
    ? input.pathname.slice(MOSS_DEVELOPER_GATEWAY_PREFIX.length) || "/"
    : "/";
  const fetcher = input.fetcher ?? fetch;

  const isRealtimeRoute =
    (method === "GET" && subpath === "/realtime/quota") ||
    (method === "POST" && subpath === "/realtime/calls") ||
    (method === "DELETE" && subpath.startsWith("/realtime/sessions/"));

  let targetUrl: string;
  const forwardHeaders = new Headers({
    authorization: `Bearer ${rawKey}`,
  });

  if (isRealtimeRoute) {
    const relayOrigin = (input.resolveRealtimeOrigin ?? resolveRegionRealtimeOrigin)(region);
    if (!relayOrigin) {
      return jsonErrorResponse(
        503,
        "realtime_relay_unavailable",
        "当前区域的实时语音中继暂未配置。",
      );
    }
    targetUrl = `${relayOrigin}/v1${subpath}${input.search ?? ""}`;
    forwardHeaders.set(MOSS_CLOUD_REGION_HEADER, region);
  } else {
    const endpointKey = `${method} ${subpath}`;
    if (!SUPPORTED_GATEWAY_ENDPOINTS.has(endpointKey)) {
      return jsonErrorResponse(
        404,
        "unsupported_developer_endpoint",
        `不支持的开发者接口路径：${method} ${subpath}`,
      );
    }
    const gatewayRoot = (input.resolveGatewayRoot ?? resolveRegionGatewayRoot)(region);
    if (!gatewayRoot) {
      return jsonErrorResponse(
        503,
        "developer_gateway_unavailable",
        "当前区域的模型网关暂未配置。",
      );
    }
    const upstreamPath = subpath === "/quota" ? "/v1/developer/quota" : `/v1${subpath}`;
    targetUrl = `${gatewayRoot}${upstreamPath}${input.search ?? ""}`;
  }

  for (const headerName of [
    "content-type",
    "accept",
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
    "x-moss-operation-id",
  ]) {
    const value = input.headers.get(headerName);
    if (value) forwardHeaders.set(headerName, value);
  }

  let upstream: Response;
  try {
    upstream = await fetcher(targetUrl, {
      method,
      headers: forwardHeaders,
      ...(method !== "GET" && method !== "HEAD" && input.bodyBytes && input.bodyBytes.byteLength > 0
        ? { body: Buffer.from(input.bodyBytes) }
        : {}),
      redirect: "error",
    });
  } catch {
    return jsonErrorResponse(
      502,
      "developer_gateway_unreachable",
      "无法连接 Moss 云端模型网关，请检查网络连接。",
    );
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const headerName of ["content-type", "x-request-id", "retry-after", "x-accel-buffering"]) {
    const value = upstream.headers.get(headerName);
    if (value) responseHeaders.set(headerName, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const mossDeveloperGatewayEffectRouteLayer = HttpRouter.add(
  "*",
  `${MOSS_DEVELOPER_GATEWAY_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const config = yield* ServerConfig;
    if (!url) {
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "invalid_request", message: "无效的请求地址。" } },
        { status: 400 },
      );
    }

    const origin = normalizeCorsOrigin(request.headers.origin);
    const trustedOrigin =
      origin && isTrustedAppOrigin({ origin, requestOrigin: url.origin, config });
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const bodyBuffer =
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS"
        ? yield* request.arrayBuffer.pipe(
            Effect.map((buf) => new Uint8Array(buf)),
            Effect.orElseSucceed(() => new Uint8Array(0)),
          )
        : null;

    const webResponse = yield* Effect.tryPromise({
      try: () =>
        forwardMossDeveloperGatewayRequest({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          headers,
          bodyBytes: bodyBuffer,
        }),
      catch: () => new Error("gateway_proxy_failed"),
    }).pipe(
      Effect.orElseSucceed(() =>
        jsonErrorResponse(502, "developer_gateway_unreachable", "开发者本地网关转发失败。"),
      ),
    );

    const outHeaders: Record<string, string> = {};
    webResponse.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    if (trustedOrigin) {
      outHeaders["Access-Control-Allow-Origin"] = origin;
      outHeaders["Access-Control-Allow-Credentials"] = "true";
      outHeaders.Vary = "Origin";
    }

    const payloadBytes = new Uint8Array(
      yield* Effect.tryPromise({
        try: () => webResponse.arrayBuffer(),
        catch: () => new Error("read_failed"),
      }).pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))),
    );
    return HttpServerResponse.uint8Array(payloadBytes, {
      status: webResponse.status,
      headers: outHeaders,
    });
  }),
);
