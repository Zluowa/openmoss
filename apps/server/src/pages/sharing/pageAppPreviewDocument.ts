import { injectHtmlHeadMarkup } from "@moss/shared/htmlMarkup";
import { PAGE_APP_PREVIEW_LIMITS } from "@moss/contracts";
import {
  pageAppReadonlyContentSecurityPolicy,
  PAGE_APP_PERMISSIONS_POLICY,
} from "@moss/shared/pageAppContentPolicy";
import {
  prepareReadonlyAppItemHtml,
  READONLY_APP_ITEM_PROTOCOL,
} from "@moss/shared/readonlyAppItem";
import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess.ts";
import { preparePageAppLibraries } from "../apps/localLibraries.ts";
import type { AuthorizedReadonlyAppItem } from "./PageSharingService.ts";
import type { PageAppPreviewRenderContext } from "./pageAppPreviewTickets.ts";
import { pageGuestFailure } from "./pageGuestHandler.ts";

export const APP_PREVIEW_DOCUMENT_MAX_BYTES = PAGE_APP_PREVIEW_LIMITS.documentBytes;
export interface PageAppPreviewDocument {
  readonly bytes: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  /** Declared resources only; cannot prove arbitrary application code is offline. */
  readonly declaredResourcesOffline: boolean;
}

export async function preparePageAppPreviewDocument(
  document: Pick<AuthorizedReadonlyAppItem, "html">,
  context: PageAppPreviewRenderContext,
  signal: AbortSignal,
  options: {
    readonly staticDir?: string;
    readonly readLibrary?: typeof readInlineVisualizationLibrary;
  } = {},
): Promise<PageAppPreviewDocument> {
  const check = () => {
    if (signal.aborted) throw pageGuestFailure("unavailable");
  };
  check();
  const libraries = await preparePageAppLibraries(
    document.html,
    options.staticDir,
    async (...args) => {
      check();
      const result = await (options.readLibrary ?? readInlineVisualizationLibrary)(...args);
      check();
      return result;
    },
  );
  check();
  const message = JSON.stringify({
    protocol: READONLY_APP_ITEM_PROTOCOL,
    nonce: context.frameNonce,
    kind: "loaded",
  }).replace(/</gu, "\\u003c");
  const origin = JSON.stringify(context.issuer.parentOrigin).replace(/</gu, "\\u003c");
  const loaded = `<script>(()=>{const send=parent.postMessage.bind(parent);addEventListener("DOMContentLoaded",()=>send(${message},${origin}),{once:true})})();</script>`;
  const html = injectHtmlHeadMarkup(
    prepareReadonlyAppItemHtml(
      libraries.html,
      context.brokerProtocol === 1
        ? { parentOrigin: context.issuer.parentOrigin, nonce: context.frameNonce }
        : undefined,
    ),
    loaded,
  );
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength > APP_PREVIEW_DOCUMENT_MAX_BYTES) throw pageGuestFailure("unavailable");
  const csp = pageAppReadonlyContentSecurityPolicy(context.issuer.parentOrigin);
  return {
    bytes,
    declaredResourcesOffline: libraries.offlineReady,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": csp,
      "permissions-policy": PAGE_APP_PERMISSIONS_POLICY,
    },
  };
}
