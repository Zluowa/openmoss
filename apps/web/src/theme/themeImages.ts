// FILE: themeImages.ts
// Purpose: Pictures themes use, on the client: the one address a stored picture loads from
//          (Moss's own theme image route on the server this window is connected to), storing a
//          picture a person picks, and reporting the pictures saved themes use so they stay.
// Layer: Web appearance runtime
// Exports: themeImageUrl, uploadThemeImage, reportThemeImagesInUse, missingThemeImageIds

import {
  THEME_IMAGE_KEEP_MAX_IDS,
  THEME_IMAGE_KEEP_ROUTE_PATH,
  THEME_IMAGE_MAX_BYTES,
  THEME_IMAGE_ROUTE_PREFIX,
  THEME_IMAGE_UPLOAD_ROUTE_PATH,
  isThemeImageId,
  themeCssImageIds,
} from "@moss/shared/themeCss";

import { resolveWsHttpUrl } from "../lib/wsHttpUrl";

/**
 * Where a stored picture loads from. The id must have the fixed shape (64 hex and a type); the
 * address is always this server's theme image route, with the desktop startup token when the
 * app uses one, because a CSS background cannot send headers.
 */
export function themeImageUrl(id: string): string {
  if (!isThemeImageId(id)) throw new Error("Not a theme picture id.");
  return resolveWsHttpUrl(`${THEME_IMAGE_ROUTE_PREFIX}${id}`);
}

export interface UploadedThemeImage {
  readonly id: string;
  readonly reference: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number;
}

/** Store a picture the person picked; Moss keeps it at full quality under its content hash. */
export async function uploadThemeImage(file: Blob, name = "图片"): Promise<UploadedThemeImage> {
  if (file.size > THEME_IMAGE_MAX_BYTES) {
    throw new Error(
      `“${name}”超过 ${THEME_IMAGE_MAX_BYTES / 1024 / 1024} MB，主题图片最大 10 MB。`,
    );
  }
  const response = await fetch(resolveWsHttpUrl(THEME_IMAGE_UPLOAD_ROUTE_PATH), {
    method: "POST",
    credentials: "include",
    body: file,
  });
  const answer: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // The server's reasons are written for agents; a person reads these.
    throw new Error(
      response.status === 413
        ? `“${name}”超过 ${THEME_IMAGE_MAX_BYTES / 1024 / 1024} MB，主题图片最大 10 MB。`
        : response.status === 400
          ? `“${name}”不是 PNG、JPEG、WebP、GIF 或 AVIF 图片（按文件内容判断），不支持 SVG。`
          : `“${name}”没有存好（${response.status}）。`,
    );
  }
  const uploaded = answer as UploadedThemeImage;
  if (!uploaded || !isThemeImageId(uploaded.id)) throw new Error("Moss 返回的图片编号无效。");
  return uploaded;
}

let reportedKey: string | null = null;

/**
 * Tell the server which stored pictures this window's saved themes use, both packs, so its
 * cleanup keeps them. Loading a picture does not count: the browser serves it from cache. Sent
 * once per set of pictures (at start and when a theme changes); a failure is retried next time.
 */
export function reportThemeImagesInUse(cssList: ReadonlyArray<string | undefined>): void {
  if (typeof fetch === "undefined") return;
  const ids = [...new Set(cssList.flatMap((css) => themeCssImageIds(css ?? "")))]
    .toSorted()
    .slice(0, THEME_IMAGE_KEEP_MAX_IDS);
  const key = ids.join(",");
  if (ids.length === 0 || key === reportedKey) return;
  reportedKey = key;
  void fetch(resolveWsHttpUrl(THEME_IMAGE_KEEP_ROUTE_PATH), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  })
    .then((response) => {
      if (!response.ok && reportedKey === key) reportedKey = null;
    })
    .catch(() => {
      if (reportedKey === key) reportedKey = null;
    });
}

/** Ids `css` refers to that this server does not have (a theme copied from another computer). */
export async function missingThemeImageIds(css: string): Promise<string[]> {
  const missing: string[] = [];
  for (const id of themeCssImageIds(css)) {
    const response = await fetch(themeImageUrl(id), { credentials: "include" }).catch(() => null);
    await response?.body?.cancel().catch(() => undefined);
    if (!response || response.status === 404) missing.push(id);
  }
  return missing;
}
