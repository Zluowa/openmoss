// FILE: slidesPptx.ts
// Purpose: The web side of 幻灯片 ⇄ PowerPoint: export loads pictures the way the app can see
//          them (Moss /api/ media paths included); import stores pictures in 资料库 so the deck
//          JSON stays small. The conversion itself is shared with the agent tools.
// Layer: 资料空间 幻灯片 export/import

import {
  exportDeckToPptx as exportShared,
  importPptxToDeck as importShared,
  type PptxExportReport,
  type PptxImportReport,
} from "@moss/shared/spaceItems/deckPptx";
import type { SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";

import { ensureNativeApi } from "~/nativeApi";

async function loadImage(src: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(src, { credentials: "same-origin" });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export function exportDeckToPptx(
  deck: SlidesDeck,
  options: { slideIds?: readonly string[] } = {},
): Promise<PptxExportReport> {
  return exportShared(deck, { loadImage, ...options });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}

/** "转换为可编辑的幻灯片": pictures over 200 KB go to 资料库; smaller ones stay inline. */
export function importPptxToDeck(bytes: ArrayBuffer): Promise<PptxImportReport> {
  return importShared(bytes, {
    storeImage: async (data, mime, name) => {
      if (data.length < 200_000) return null;
      try {
        const result = await ensureNativeApi().library.importFiles({
          files: [
            {
              name: `${name.replace(/[\/:*?"<>|]/gu, "_").slice(0, 80) || "图片"}.${mime.split("/")[1]}`,
              mimeType: mime,
              dataBase64: toBase64(data),
            },
          ],
        });
        return result.items[0]?.previewPath ?? null;
      } catch {
        return null;
      }
    },
  });
}
