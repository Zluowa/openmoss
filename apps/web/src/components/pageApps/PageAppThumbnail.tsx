// FILE: PageAppThumbnail.tsx
// Purpose: An 应用页 card cover: shows the stored/AI thumbnail image, or a scaled
//          script-less live miniature of the app's own HTML until a snapshot or AI
//          cover is saved, matching 资料空间's 2:1 card preview frame.
// Layer: Web pageApps

import type { PageAppId } from "@moss/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "~/components/ui/spinner";
import { AppsIcon } from "~/lib/icons";

import { pageAppsClient } from "./pageAppsClient";

const PREVIEW_VIRTUAL_WIDTH = 1120;
const PREVIEW_VIRTUAL_HEIGHT = 560;
const MAX_CACHE_ENTRIES = 64;

const previewHtmlCache = new Map<string, string | null>();
const inflightPreviewReads = new Map<string, Promise<string | null>>();

export function clearPageAppPreviewCacheForTests(): void {
  previewHtmlCache.clear();
  inflightPreviewReads.clear();
}

export function pageAppPlaceholderHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function stripScriptsForStaticPreview(html: string): string {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, "");
  const resetStyle =
    "<style>html,body{overflow:hidden!important;pointer-events:none!important;user-select:none!important;}</style>";
  if (/<\/head>/iu.test(cleaned)) {
    return cleaned.replace(/<\/head>/iu, `${resetStyle}</head>`);
  }
  return `${resetStyle}${cleaned}`;
}

function readCachedPreviewHtml(cacheKey: string, appId: string): Promise<string | null> {
  const cached = previewHtmlCache.get(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = inflightPreviewReads.get(cacheKey);
  if (existing) return existing;
  if (typeof pageAppsClient.read !== "function") {
    return Promise.resolve(null);
  }
  const promise = pageAppsClient
    .read({ appId: appId as PageAppId })
    .then((result) => result.html || null)
    .catch(() => null)
    .then((html) => {
      inflightPreviewReads.delete(cacheKey);
      if (previewHtmlCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = previewHtmlCache.keys().next().value;
        if (oldest !== undefined) previewHtmlCache.delete(oldest);
      }
      previewHtmlCache.set(cacheKey, html);
      return html;
    });
  inflightPreviewReads.set(cacheKey, promise);
  return promise;
}

export function PageAppThumbnail({
  app,
  previewHtml,
  livePreview = true,
  generating = false,
}: {
  readonly app: {
    readonly id: string;
    readonly title: string;
    readonly thumbnail: string | null;
    readonly revision?: number | undefined;
  };
  readonly previewHtml?: string | null | undefined;
  readonly livePreview?: boolean;
  readonly generating?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const cacheKey = `${app.id}:${app.revision ?? 0}`;
  const hasStoredThumbnail = Boolean(app.thumbnail && failed !== app.thumbnail);
  const shouldFetchLive = livePreview && !hasStoredThumbnail && previewHtml === undefined;

  const [fetchedHtml, setFetchedHtml] = useState<string | null>(
    () => previewHtmlCache.get(cacheKey) ?? null,
  );
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!shouldFetchLive) return;
    const cached = previewHtmlCache.get(cacheKey);
    if (cached !== undefined) {
      setFetchedHtml(cached);
      return;
    }
    let cancelled = false;
    void readCachedPreviewHtml(cacheKey, app.id).then((html) => {
      if (!cancelled) setFetchedHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [app.id, cacheKey, shouldFetchLive]);

  const effectiveHtml = previewHtml !== undefined ? previewHtml : fetchedHtml;
  const staticSrcDoc = useMemo(
    () => (effectiveHtml ? stripScriptsForStaticPreview(effectiveHtml) : null),
    [effectiveHtml],
  );

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el || hasStoredThumbnail || !staticSrcDoc) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasStoredThumbnail, staticSrcDoc]);

  const scale = containerWidth > 0 ? containerWidth / PREVIEW_VIRTUAL_WIDTH : 0.25;

  return (
    <span
      ref={hostRef}
      className="relative flex aspect-[2/1] w-full items-center justify-center overflow-hidden rounded-t-panel border-b border-border/60 bg-[var(--color-background-elevated-secondary)]"
    >
      {hasStoredThumbnail ? (
        <img
          src={app.thumbnail!}
          onError={() => setFailed(app.thumbnail)}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : staticSrcDoc ? (
        <iframe
          title=""
          tabIndex={-1}
          sandbox=""
          aria-hidden
          data-page-app-live-preview="true"
          srcDoc={staticSrcDoc}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-background"
          style={{
            width: PREVIEW_VIRTUAL_WIDTH,
            height: PREVIEW_VIRTUAL_HEIGHT,
            transform: `scale(${scale})`,
          }}
        />
      ) : (
        <AppsIcon aria-hidden className="size-6 text-muted-foreground/75" />
      )}
      {generating ? (
        <span
          data-testid="page-app-cover-generating"
          className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/75 text-ui-xs font-medium text-foreground backdrop-blur-[2px]"
        >
          <Spinner decorative className="size-3.5 text-muted-foreground" />
          <span>正在生成封面…</span>
        </span>
      ) : null}
    </span>
  );
}
