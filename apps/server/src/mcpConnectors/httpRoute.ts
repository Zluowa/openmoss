/**
 * HTTP routes for Connectors.
 *
 * - `GET /oauth/mcp/callback`: the OAuth redirect target. The browser carries
 *   no Moss session, so the single-use `state` minted with the sign-in is
 *   the only authority here.
 * - `GET /oauth/moss-apps/callback`: where the hosted Moss Apps sign-in page
 *   returns the browser. It only shows a closing page; the connection itself
 *   is read back from the app backend, never from this query string.
 * - `POST|DELETE /mcp/connectors/:connectorId`: the MCP endpoint provider
 *   sessions call, authenticated with the same per-session bearer as `/mcp`.
 *   `GET` answers 405: the gateway offers no standalone SSE stream.
 *
 * @module mcpConnectors/httpRoute
 */
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody } from "../agentGateway/httpRoute.ts";
import { AGENT_GATEWAY_CONNECTORS_PATH } from "../agentGateway/Layers/AgentGatewayCredentials.ts";
import { AgentGatewayCredentials } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { extractBearerToken } from "../agentGateway/bearerToken.ts";
import {
  MCP_CONNECTOR_OAUTH_CALLBACK_PATH,
  MOSS_APPS_CALLBACK_PATH,
} from "./Layers/McpConnectors.ts";
import type { McpConnectorProxyResult } from "./proxy.ts";
import type { McpConnectorCallbackOutcome } from "./runtime.ts";
import { McpConnectors } from "./Services/McpConnectors.ts";

const CONNECTOR_ROUTE = `${AGENT_GATEWAY_CONNECTORS_PATH}/:connectorId`;

const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** What a sign-in's closing page says. Every string is escaped when rendered. */
export interface CallbackPageView {
  readonly ok: boolean;
  readonly lang: "en" | "zh-CN";
  readonly title: string;
  readonly body: string;
  readonly hint: string;
  /** The app's mark beside Moss's; only an https URL is shown. */
  readonly logoUrl: string | null;
}

const CHECK_MARK =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.25 4.9 8.6 9.5 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS_MARK =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3.6 3.6 8.4 8.4M8.4 3.6 3.6 8.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function httpsOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The page the browser lands on after a sign-in: Moss's mark beside the app's
 * (or a status badge on Moss's alone), in Moss's light and dark colors.
 */
export function renderCallbackPage(view: CallbackPageView): string {
  const status = `<span class="status${view.ok ? "" : " failed"}">${view.ok ? CHECK_MARK : CROSS_MARK}</span>`;
  const mossMark = '<span class="tile"><img src="/moss-logo-coral.png" alt=""></span>';
  const marks =
    view.logoUrl && httpsOrigin(view.logoUrl)
      ? `${mossMark}${status}<span class="tile"><img src="${escapeHtml(view.logoUrl)}" alt=""></span>`
      : `<span class="badged">${mossMark}${status}</span>`;
  return `<!doctype html>
<html lang="${view.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(view.title)} · Moss</title>
<style>
:root {
  color-scheme: light dark;
  --background: #fcfcfb;
  --foreground: #1d1c1a;
  --card: #ffffff;
  --muted: #686868;
  --border: rgb(0 0 0 / 6%);
  --success: #10b981;
  --destructive: #ef4444;
  --shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 16px 40px rgb(0 0 0 / 6%);
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #0e0e0e;
    --foreground: #f5f5f5;
    --card: #161616;
    --muted: #8a8a8a;
    --border: rgb(255 255 255 / 8%);
    --destructive: #f26d6d;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--background);
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  width: 100%;
  max-width: 400px;
  padding: 40px 32px 28px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--card);
  box-shadow: var(--shadow);
  text-align: center;
  animation: enter 220ms ease-out both;
}
.marks { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 0 0 24px; }
.tile {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--card);
  box-shadow: inset 0 0 0 1px var(--border), 0 1px 2px rgb(0 0 0 / 5%);
  overflow: hidden;
}
.tile img { width: 36px; height: 36px; object-fit: contain; }
.status {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--success);
  color: #ffffff;
}
.status.failed { background: var(--destructive); }
.badged { position: relative; }
.badged .status { position: absolute; right: -6px; bottom: -6px; box-shadow: 0 0 0 3px var(--card); }
h1 { margin: 0 0 8px; font-size: 20px; line-height: 28px; font-weight: 600; text-wrap: balance; }
p { margin: 0; color: var(--muted); font-size: 14px; line-height: 22px; text-wrap: pretty; }
p.hint { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border); font-size: 13px; line-height: 20px; }
@keyframes enter { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { main { animation: none; } }
</style>
</head>
<body>
<main>
<div class="marks" aria-hidden="true">${marks}</div>
<h1>${escapeHtml(view.title)}</h1>
<p>${escapeHtml(view.body)}</p>
<p class="hint">${escapeHtml(view.hint)}</p>
</main>
</body>
</html>
`;
}

/** A custom connector's OAuth outcome; its text comes from the connector runtime, in English. */
function connectorCallbackView(outcome: McpConnectorCallbackOutcome): CallbackPageView {
  return outcome.ok
    ? {
        ok: true,
        lang: "en",
        title: `${outcome.name} is connected`,
        body: `Every agent in Moss can now use ${outcome.name} for you.`,
        hint: "You can close this tab and return to Moss.",
        logoUrl: null,
      }
    : {
        ok: false,
        lang: "en",
        title: outcome.title,
        body: outcome.message,
        hint: "You can close this tab.",
        logoUrl: null,
      };
}

export function renderConnectorCallbackPage(outcome: McpConnectorCallbackOutcome): string {
  return renderCallbackPage(connectorCallbackView(outcome));
}

/** A Moss Apps sign-in, named from the catalog and worded in the browser's language. */
export function mossAppsCallbackView(input: {
  readonly ok: boolean;
  readonly app: { readonly name: string; readonly logoUrl: string | null } | null;
  readonly chinese: boolean;
}): CallbackPageView {
  const name = input.app?.name ?? null;
  const logoUrl = input.app?.logoUrl ?? null;
  if (input.chinese) {
    return input.ok
      ? {
          ok: true,
          lang: "zh-CN",
          title: name ? `已连接 ${name}` : "应用已连接",
          body: `现在 Moss 中的每个智能体都可以代你使用${name ? ` ${name}` : "它"}。`,
          hint: "你可以关闭此页面，回到 Moss。",
          logoUrl,
        }
      : {
          ok: false,
          lang: "zh-CN",
          title: name ? `${name} 未连接` : "应用未连接",
          body: "登录没有完成，请回到 Moss 重试。",
          hint: "你可以关闭此页面。",
          logoUrl,
        };
  }
  return input.ok
    ? {
        ok: true,
        lang: "en",
        title: name ? `${name} is connected` : "Your app is connected",
        body: `Every agent in Moss can now use ${name ?? "it"} for you.`,
        hint: "You can close this tab and return to Moss.",
        logoUrl,
      }
    : {
        ok: false,
        lang: "en",
        title: name ? `${name} was not connected` : "The app was not connected",
        body: "The sign-in did not finish. Try again from Moss.",
        hint: "You can close this tab.",
        logoUrl,
      };
}

/** Chinese when the browser's first preferred language is; English otherwise. */
export function prefersChinese(acceptLanguage: string | undefined): boolean {
  return (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase().startsWith("zh") ?? false;
}

function callbackPageResponse(view: CallbackPageView) {
  const logoOrigin = httpsOrigin(view.logoUrl);
  return HttpServerResponse.text(renderCallbackPage(view), {
    status: view.ok ? 200 : 400,
    contentType: "text/html; charset=utf-8",
    headers: {
      "Cache-Control": "no-store",
      // The Moss mark is served by this same server; an app's mark only from
      // its own https origin.
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'${logoOrigin ? ` ${logoOrigin}` : ""}`,
      "Referrer-Policy": "no-referrer",
    },
  });
}

const MOSS_APP_SLUG = /^_?[a-z0-9][a-z0-9_-]*$/u;

const callbackRoute = HttpRouter.add(
  "GET",
  MCP_CONNECTOR_OAUTH_CALLBACK_PATH,
  Effect.gen(function* () {
    const connectors = yield* McpConnectors;
    if (!connectors.enabled) return notFound();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    const outcome = yield* connectors.completeAuthorization({
      state: param("state"),
      code: param("code"),
      error: param("error"),
      errorDescription: param("error_description"),
    });
    return callbackPageResponse(connectorCallbackView(outcome));
  }),
);

const mossAppsCallbackRoute = HttpRouter.add(
  "GET",
  MOSS_APPS_CALLBACK_PATH,
  Effect.gen(function* () {
    const connectors = yield* McpConnectors;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = HttpServerRequest.toURL(request)?.searchParams;
    const status = query?.get("status");
    // The app is named from Moss's own catalog; the query only carries its slug.
    const slug = query?.get("app")?.trim().toLowerCase() ?? "";
    const app =
      slug.length <= 120 && MOSS_APP_SLUG.test(slug)
        ? connectors.mossApps.cachedToolkit(slug)
        : null;
    return callbackPageResponse(
      mossAppsCallbackView({
        ok: status !== "failed" && status !== "error",
        app,
        chinese: prefersChinese(request.headers["accept-language"]),
      }),
    );
  }),
);

function unauthorizedResponse() {
  return HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
      },
    },
    { status: 401 },
  );
}

function toHttpResponse(result: McpConnectorProxyResult) {
  const headers = result.sessionId ? { "Mcp-Session-Id": result.sessionId } : undefined;
  switch (result.body.kind) {
    case "json":
      return HttpServerResponse.jsonUnsafe(result.body.value, {
        status: result.status,
        ...(headers ? { headers } : {}),
      });
    case "text":
      return HttpServerResponse.text(result.body.value, {
        status: result.status,
        contentType: result.body.contentType,
        ...(headers ? { headers } : {}),
      });
    case "empty":
      return HttpServerResponse.empty({ status: result.status, ...(headers ? { headers } : {}) });
  }
}

/** Resolves the connector id when the feature is on and the bearer is a live session. */
const authorizeConnectorRequest = Effect.gen(function* () {
  const connectors = yield* McpConnectors;
  if (!connectors.gatewayEnabled) return { kind: "not-found" as const };
  const request = yield* HttpServerRequest.HttpServerRequest;
  const credentials = yield* AgentGatewayCredentials;
  const token = extractBearerToken(request.headers.authorization);
  if (!token || credentials.verifySession(token) === null) {
    return { kind: "unauthorized" as const };
  }
  const { connectorId } = yield* HttpRouter.params;
  // A live bearer only reaches the connectors its session was given.
  if (!connectorId || !(credentials.canUseConnector?.(token, connectorId) ?? false)) {
    return { kind: "not-found" as const };
  }
  return {
    kind: "ok" as const,
    connectors,
    request,
    connectorId,
    sessionId: request.headers["mcp-session-id"],
    protocolVersion: request.headers["mcp-protocol-version"],
  };
});

const postRoute = HttpRouter.add(
  "POST",
  CONNECTOR_ROUTE,
  Effect.gen(function* () {
    const access = yield* authorizeConnectorRequest;
    if (access.kind === "not-found") return notFound();
    if (access.kind === "unauthorized") return unauthorizedResponse();
    const body = yield* readMcpJsonBody(access.request);
    if (body.kind === "too-large") {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body exceeds the 1 MiB limit." },
        },
        { status: 413 },
      );
    }
    if (body.kind === "invalid") {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    const result = yield* access.connectors.forward(access.connectorId, {
      method: "POST",
      body: body.body,
      sessionId: access.sessionId,
      protocolVersion: access.protocolVersion,
    });
    return toHttpResponse(result);
  }),
);

const deleteRoute = HttpRouter.add(
  "DELETE",
  CONNECTOR_ROUTE,
  Effect.gen(function* () {
    const access = yield* authorizeConnectorRequest;
    if (access.kind === "not-found") return notFound();
    if (access.kind === "unauthorized") return unauthorizedResponse();
    if (!access.sessionId) return HttpServerResponse.empty({ status: 400 });
    const result = yield* access.connectors.forward(access.connectorId, {
      method: "DELETE",
      sessionId: access.sessionId,
      protocolVersion: access.protocolVersion,
    });
    return HttpServerResponse.empty({ status: result.status === 404 ? 404 : 204 });
  }),
);

const getRoute = HttpRouter.add(
  "GET",
  CONNECTOR_ROUTE,
  Effect.gen(function* () {
    const connectors = yield* McpConnectors;
    if (!connectors.gatewayEnabled) return notFound();
    return HttpServerResponse.empty({ status: 405, headers: { Allow: "POST, DELETE" } });
  }),
);

export const mcpConnectorsRouteLayer = Layer.mergeAll(
  callbackRoute,
  mossAppsCallbackRoute,
  postRoute,
  deleteRoute,
  getRoute,
);
