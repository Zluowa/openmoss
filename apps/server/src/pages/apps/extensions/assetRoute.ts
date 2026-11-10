// FILE: assetRoute.ts
// Purpose: Serves an 应用页's own assets on the page's own origin
// (`<appId>.moss-app.localhost/__moss_app/asset/<assetId>?t=<frame token>`),
// so `<img src>`, `<video>`, fonts and `@font-face` work inside the page
// without a network permission. The frame token must be valid and name the
// same page as the host; responses are sandboxed and never sniffed.
// Layer: Server pages/apps extensions

import { PAGE_APP_ASSET_PATH } from "@moss/contracts";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { pageAppIdFromHost } from "../frameServing";
import { PageAppsService } from "../PageAppsService";
import { makePageAppExtensionStore } from "./PageAppExtensionStore";

const ASSET_ID = /^[0-9a-f-]{36}$/u;

export function pageAppAssetHeaders(
  mimeType: string,
  name: string,
  size: number,
): Record<string, string> {
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return {
    "Content-Type":
      mimeType.startsWith("text/") || mimeType === "application/json"
        ? `${mimeType}; charset=utf-8`
        : mimeType,
    "Content-Length": String(size),
    "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    // Nothing in an asset may run, even when opened directly.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, max-age=3600, immutable",
  };
}

export const pageAppAssetsRouteLayer = HttpRouter.add(
  "GET",
  `${PAGE_APP_ASSET_PATH}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const notFound = HttpServerResponse.text("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
    if (!url) return notFound;
    const assetId = url.pathname.slice(PAGE_APP_ASSET_PATH.length + 1);
    const hostAppId = pageAppIdFromHost(request.headers.host);
    if (!hostAppId || !ASSET_ID.test(assetId)) return notFound;
    const service = yield* PageAppsService;
    const token = service.verifyFrameToken(url.searchParams.get("t") ?? "");
    if (!token || token.appId.toLowerCase() !== hostAppId) return notFound;
    const sql = yield* SqlClient.SqlClient;
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const rows = yield* sql<{
          trashed_at: string | null;
        }>`SELECT trashed_at FROM page_apps WHERE app_id = ${token.appId}`;
        if (!rows[0] || rows[0].trashed_at !== null) return null;
        return yield* makePageAppExtensionStore(sql).readAsset(token.appId, assetId);
      }),
    );
    if (result._tag === "Failure" || !result.success) return notFound;
    const { row, data } = result.success;
    return HttpServerResponse.uint8Array(data, {
      status: 200,
      headers: pageAppAssetHeaders(row.mimeType, row.name, data.byteLength),
    });
  }),
);

/** HTTP statuses for the error codes the reaching-out capabilities add. */
export const PAGE_APP_EXTENSION_HTTP_STATUS: Readonly<Record<string, number>> = {
  consent_required: 403,
  confirmation_required: 403,
  declined: 403,
  policy_blocked: 403,
  tool_error: 422,
  too_large: 413,
  changed: 409,
};
