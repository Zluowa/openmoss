// FILE: readonlyAppItem.ts
// Purpose: Explicit source identity for the existing AppItem HTML preview.
// Layer: Shared; source identities only, no grants or relay transport

import { injectHtmlHeadMarkup } from "./htmlMarkup";
import { pageAppMetaContentSecurityPolicy } from "./pageAppContentPolicy";
import { buildPageAppFrameRuntime } from "./pageAppFrameRuntime";
import { buildGuestReadonlyPermissionRuntime } from "./guestReadonlyPermissionRuntime";

export const READONLY_APP_ITEM_PROTOCOL = "moss-readonly-app-item-v1";
export const READONLY_APP_ITEM_TIMEOUT_MS = 8_000;
export const READONLY_APP_ITEM_MAX_HTML = 2_000_000;

export interface PageItemAppSource {
  readonly sourceKind: "page-item";
  readonly pageId: string;
  readonly pageRevision: number;
  readonly dataRevision: number;
}
export interface TemplateAppSource {
  readonly sourceKind: "template-preview";
  readonly templateId: string;
}
export interface PublishedPageAppSource {
  readonly sourceKind: "page-app";
  readonly pageId: string;
  readonly pageRevision: number;
  readonly publicationId: string;
  readonly generation: number;
  readonly appId: string;
  readonly appRevision: number;
}
export interface ReadonlyAppItemDocument<
  S = PageItemAppSource | TemplateAppSource | PublishedPageAppSource,
> {
  readonly source: S;
  readonly html: string;
  readonly publicMetadata: { readonly title: string; readonly revision: number | null };
}
export type ReadonlyAppItemContext =
  | { readonly audience: "owner"; readonly document: ReadonlyAppItemDocument<PageItemAppSource> }
  | { readonly audience: "template"; readonly document: ReadonlyAppItemDocument<TemplateAppSource> }
  | {
      readonly audience: "guest";
      readonly document: ReadonlyAppItemDocument<PageItemAppSource>;
      readonly grantId: string;
      readonly expiresAt: string;
    };

export function isReadonlyAppItemDocument(document: ReadonlyAppItemDocument): boolean {
  const { source, html, publicMetadata } = document;
  if (
    !html ||
    html.length > READONLY_APP_ITEM_MAX_HTML ||
    typeof publicMetadata.title !== "string" ||
    publicMetadata.title.length > 256
  )
    return false;
  if (source.sourceKind === "template-preview")
    return !!source.templateId && publicMetadata.revision === null;
  if (source.sourceKind === "page-app")
    return (
      !!source.pageId &&
      !!source.appId &&
      !!source.publicationId &&
      [source.pageRevision, source.appRevision, source.generation].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) &&
      publicMetadata.revision === source.appRevision
    );
  return (
    !!source.pageId &&
    Number.isSafeInteger(source.pageRevision) &&
    source.pageRevision > 0 &&
    Number.isSafeInteger(source.dataRevision) &&
    source.dataRevision > 0 &&
    source.dataRevision <= source.pageRevision &&
    publicMetadata.revision === source.pageRevision
  );
}

export function prepareReadonlyAppItemHtml(
  html: string,
  guestBroker?: { readonly parentOrigin: string; readonly nonce: string },
): string {
  const csp = pageAppMetaContentSecurityPolicy();
  const runtime = guestBroker
    ? buildGuestReadonlyPermissionRuntime(
        guestBroker.parentOrigin,
        guestBroker.nonce,
        READONLY_APP_ITEM_PROTOCOL,
      )
    : buildPageAppFrameRuntime({ parentOrigin: "null", plugins: [] });
  return injectHtmlHeadMarkup(
    html,
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><script>${runtime}</script>`,
  );
}
