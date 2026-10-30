// FILE: shareCardExport.ts
// Purpose: Fully offline rendering of the share card to a PNG, plus clipboard copy,
// file download, and social-intent URLs. No data leaves the device to BUILD the image;
// opening a social composer is an explicit, user-initiated action.
// Layer: web profile feature.

import { toBlob } from "html-to-image";
import type { MossLocaleCode } from "~/appSettings";
import { copyPngBlobToDesktopClipboard } from "~/lib/desktopClipboard";
import { readNativeApi } from "~/nativeApi";

export { downloadBlob } from "~/lib/browserDownload";

const SHARE_BRAND_HANDLE = "@tryMoss";
const SHARE_TWEET_TEXT: Readonly<Record<MossLocaleCode, string>> = {
  en: `Just checking my ${SHARE_BRAND_HANDLE} dev stats. Absolute masterpiece of an IDE.`,
  "zh-CN": `晒一下我的 ${SHARE_BRAND_HANDLE} 开发数据。这个 IDE 简直是艺术品。`,
};
const SHARE_REDDIT_TITLE: Readonly<Record<MossLocaleCode, string>> = {
  en: "My Moss dev stats",
  "zh-CN": "我的 Moss 开发数据",
};
const SHARE_URL = "https://trymoss.com";

export type ShareTarget = "x" | "linkedin" | "reddit";

// Renders the given node to a PNG blob entirely on-device (canvas serialization).
// Passing explicit width/height keeps the export deterministic and free of trailing
// whitespace regardless of layout measurement quirks.
export async function renderNodeToPngBlob(
  node: HTMLElement,
  size?: { width: number; height: number },
): Promise<Blob | null> {
  try {
    return await toBlob(node, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: "#ffffff",
      ...(size ? { width: size.width, height: size.height } : {}),
    });
  } catch {
    return null;
  }
}

export async function copyImageToClipboard(blob: Blob): Promise<boolean> {
  if (await copyPngBlobToDesktopClipboard(blob)) {
    return true;
  }

  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      return false;
    }
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch {
    return false;
  }
}

// Opens an external URL via the desktop shell when available, else a new browser tab.
export function openExternalUrl(url: string): void {
  const api = readNativeApi();
  if (api?.shell?.openExternal) {
    void api.shell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function shareIntentUrl(target: ShareTarget, locale: MossLocaleCode): string {
  switch (target) {
    case "x":
      return `https://x.com/intent/tweet?text=${encodeURIComponent(SHARE_TWEET_TEXT[locale])}`;
    case "linkedin":
      return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}`;
    case "reddit":
      return `https://www.reddit.com/submit?url=${encodeURIComponent(
        SHARE_URL,
      )}&title=${encodeURIComponent(SHARE_REDDIT_TITLE[locale])}`;
  }
}
