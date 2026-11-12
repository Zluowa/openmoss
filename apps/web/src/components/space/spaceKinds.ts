// FILE: spaceKinds.ts
// Purpose: Name and glyph of each 资料空间 item kind, and which kinds this build can open.
// Layer: Space UI

import type { LucideIcon } from "~/lib/icons";
import {
  FileChartIcon,
  FileIcon,
  FilePdfIcon,
  FileZipIcon,
  GlobeIcon,
  ImagesIcon,
  PageTextIcon,
  PlayIcon,
  SketchPenIcon,
  SlidesIcon,
  TableIcon,
  WindowAppIcon,
} from "~/lib/icons";

import type { SpaceItem } from "./spaceItems";

export interface SpaceKindMeta {
  readonly label: string;
  readonly icon: LucideIcon;
}

const KINDS: Record<string, SpaceKindMeta> = {
  page: { label: "页面", icon: PageTextIcon },
  app: { label: "应用页", icon: WindowAppIcon },
  slides: { label: "幻灯片", icon: SlidesIcon },
  sheet: { label: "电子表格", icon: TableIcon },
  board: { label: "白板", icon: SketchPenIcon },
  site: { label: "站点", icon: GlobeIcon },
  image: { label: "图像", icon: ImagesIcon },
  file: { label: "文件", icon: FileIcon },
};

const GENERIC: SpaceKindMeta = { label: "条目", icon: FileIcon };

export function spaceKindMeta(kind: string): SpaceKindMeta {
  return KINDS[kind] ?? GENERIC;
}

/** Files get a glyph that says what they are; everything else uses its kind's glyph. */
export function spaceItemMeta(item: SpaceItem): SpaceKindMeta {
  if ((item.source.type !== "output" && item.source.type !== "library") || item.kind !== "file")
    return spaceKindMeta(item.kind);
  const extension = /\.([A-Za-z0-9]+)$/.exec(item.title)?.[1]?.toLowerCase() ?? "";
  if (extension === "html" || extension === "htm") return { label: "网页", icon: GlobeIcon };
  if (extension === "pdf") return { label: "PDF", icon: FilePdfIcon };
  if (extension === "zip") return { label: "压缩包", icon: FileZipIcon };
  if (["mp4", "webm", "mov"].includes(extension)) return { label: "视频", icon: PlayIcon };
  if (["csv", "tsv", "xls", "xlsx"].includes(extension))
    return { label: "表格文件", icon: FileChartIcon };
  if (["ppt", "pptx"].includes(extension)) return { label: "演示文稿", icon: SlidesIcon };
  if (["doc", "docx"].includes(extension)) return { label: "文档", icon: PageTextIcon };
  return spaceKindMeta("file");
}

export function isHtmlOutput(item: SpaceItem): boolean {
  return item.source.type === "output" && /\.html?$/i.test(item.source.output.path);
}
