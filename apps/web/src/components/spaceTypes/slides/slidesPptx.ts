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
import { slideIconUrl, type SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";

import { uploadLibraryFiles } from "~/lib/libraryUpload";

async function loadImage(src: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(src, { credentials: "same-origin" });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** An icon element as a 512 px PNG in its colour: the glyph is drawn, then tinted. */
async function loadIcon(name: string, color: string): Promise<Uint8Array | null> {
  const url = slideIconUrl(name);
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    // An SVG decodes through an <img>, not createImageBitmap.
    const objectUrl = URL.createObjectURL(await response.blob());
    const image = new Image(512, 512);
    try {
      image.src = objectUrl;
      await image.decode();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, 512, 512);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = color;
    context.fillRect(0, 0, 512, 512);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export function exportDeckToPptx(
  deck: SlidesDeck,
  options: { slideIds?: readonly string[]; fonts?: "current" | "basic" } = {},
): Promise<PptxExportReport> {
  return exportShared(deck, { loadImage, loadIcon, ...options });
}

/** "转换为可编辑的幻灯片": pictures over 200 KB go to 资料库; smaller ones stay inline. */
export function importPptxToDeck(bytes: ArrayBuffer): Promise<PptxImportReport> {
  return importShared(bytes, {
    storeImage: async (data, mime, name) => {
      if (data.length < 200_000) return null;
      try {
        // Raw bytes over HTTP: the WebSocket's 2 MiB message cap stops base64 files of ~1.5 MB.
        const result = await uploadLibraryFiles([
          {
            name: `${name.replace(/[\/:*?"<>|]/gu, "_").slice(0, 80) || "图片"}.${mime.split("/")[1]}`,
            mimeType: mime,
            data: new Blob([new Uint8Array(data)], { type: mime }),
          },
        ]);
        return result.items[0]?.previewPath ?? null;
      } catch {
        return null;
      }
    },
  });
}
