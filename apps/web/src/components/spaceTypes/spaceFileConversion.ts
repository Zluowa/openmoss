// FILE: spaceFileConversion.ts
// Purpose: "转换为可编辑的幻灯片 / 电子表格" for files in the 资料空间 (chat outputs and 资料库
//          files): which files convert, and reading their bytes.
// Layer: 资料空间 types stream, used by space-ui's file viewer

import type { PageSpaceId, PageTypedItem, SpaceId } from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { convertPptxToSlides, convertSpreadsheetToSheet } from "./spaceItemTypes";

export type SpaceFileConversion = "slides" | "sheet";

/** The typed item a file can become, or null. */
export function fileConversionFor(path: string): SpaceFileConversion | null {
  if (/\.pptx$/iu.test(path)) return "slides";
  if (/\.(xlsx|csv)$/iu.test(path)) return "sheet";
  return null;
}

export const FILE_CONVERSION_LABELS: Record<SpaceFileConversion, string> = {
  slides: "转换为可编辑的幻灯片",
  sheet: "转换为可编辑的电子表格",
};

const MAX_CONVERT_BYTES = 50 * 1024 * 1024;

/** Converts a file the server can serve (`root` is its workspace, null for 资料库 paths). */
export async function convertSpaceFile(input: {
  scopeSpaceId: SpaceId | null;
  spaceId?: PageSpaceId | null;
  root: string | null;
  path: string;
}): Promise<{ item: PageTypedItem; skipped: number }> {
  const kind = fileConversionFor(input.path);
  if (!kind) throw new Error("这种文件不能转换。");
  const response = await fetch(
    buildLocalImageUrl({ src: input.path, cwd: input.root ?? undefined, download: true }),
  );
  if (!response.ok) throw new Error(`无法读取文件（HTTP ${response.status}）。`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_CONVERT_BYTES) throw new Error("文件超过 50 MB，无法转换。");
  const name = input.path.split(/[\\/]/u).pop() ?? "文件";
  const api = ensureNativeApi();
  if (kind === "slides") {
    return convertPptxToSlides(api, {
      scopeSpaceId: input.scopeSpaceId,
      bytes,
      fileName: name,
      spaceId: input.spaceId ?? null,
    });
  }
  const item = await convertSpreadsheetToSheet(api, {
    scopeSpaceId: input.scopeSpaceId,
    file: new File([bytes], name),
    spaceId: input.spaceId ?? null,
  });
  return { item, skipped: 0 };
}
