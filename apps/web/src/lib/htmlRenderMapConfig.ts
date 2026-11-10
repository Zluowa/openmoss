// FILE: htmlRenderMapConfig.ts
// Purpose: The map configuration the app hands a live html_render map page: the provider
//   and browser key for the reader's account, read from the server when the page asks.
//   Keys travel only to the live frame; a stored or shared page never holds one.
// Layer: Web data access
// Exports: readHtmlRenderMapConfig, setHtmlRenderMapConfigReader, htmlRenderMapConfigForPage

import type { HtmlRenderMapConfig } from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";

// Short, so a sign-in or sign-out reaches the next map page, while a page of several
// maps asks the server once.
const CACHE_MS = 10_000;
let cached: { readonly at: number; readonly value: Promise<HtmlRenderMapConfig | null> } | null =
  null;
let reader: (() => Promise<HtmlRenderMapConfig | null>) | null = null;

/**
 * Lets a host without the owner's RPC say where the map configuration comes from. The shared
 * conversation's guest page sets this once, so a page's map reads it through the share. The app
 * itself never calls this.
 */
export function setHtmlRenderMapConfigReader(
  next: (() => Promise<HtmlRenderMapConfig | null>) | null,
): void {
  reader = next;
  cached = null;
}

/** The server's answer for this account, or null when it cannot answer. Never rejects. */
export function readHtmlRenderMapConfig(now = Date.now()): Promise<HtmlRenderMapConfig | null> {
  if (cached === null || now - cached.at > CACHE_MS) {
    cached = {
      at: now,
      value: Promise.resolve()
        .then(() => (reader ? reader() : ensureNativeApi().server.getHtmlRenderMapConfig()))
        .catch(() => null),
    };
  }
  return cached.value;
}

/**
 * What the page receives. A mainland China account's map may end up without a basemap,
 * so it carries the reader-language note the page shows then. Without a configuration
 * (no answer from the server), the page draws the plain map.
 */
export function htmlRenderMapConfigForPage(
  config: HtmlRenderMapConfig | null,
  plainMapNote: string,
): HtmlRenderMapConfig | { readonly provider: "plain" } | (HtmlRenderMapConfig & { note: string }) {
  if (config === null) return { provider: "plain" };
  return config.lane === "cn" ? { ...config, note: plainMapNote } : config;
}
