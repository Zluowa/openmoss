// FILE: SpaceItemViewers.tsx
// Purpose: What opens when a 资料空间 item that is not a plain page is opened: a file an agent
//          wrote in a chat, an 应用页, or a kind whose editor ships with another stream of this
//          build (幻灯片, 电子表格, 站点, 白板, 模板, 插件).
// Layer: Space UI
// Ownership: each stream replaces its own stub here with one line (types: slides / sheet /
//            board / template; sharing: site; apps-runtime: AppPageFrame for `app`).

import type { ReactNode } from "react";
import { PROJECT_PREVIEW_READ_FILE_MAX_BYTES } from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";
import {
  ChatBubbleIcon,
  SlideDeckIcon,
  SpreadsheetIcon,
  TrashCanIcon,
  WindowAppIcon,
} from "~/lib/icons";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

import { AppPageFrame } from "../pageApps/AppPageFrame";
import { PageChromeButton } from "../pages/chrome/PageChromeButton";
import { Button } from "../ui/button";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { FILE_CONVERSION_LABELS, fileConversionFor } from "../spaceTypes/spaceFileConversion";
import type { SpaceItem } from "./spaceItems";
import { isHtmlOutput, spaceItemMeta, spaceKindMeta } from "./spaceKinds";

/** Reads a chat output's text (HTML for 保存为应用页). */
export async function readOutputText(item: SpaceItem): Promise<string> {
  if (item.source.type !== "output") throw new Error("Not a chat output");
  const { output } = item.source;
  const result = await ensureNativeApi().projects.readFile({
    cwd: output.workspaceRoot,
    relativePath: output.path,
    maxBytes: PROJECT_PREVIEW_READ_FILE_MAX_BYTES,
  });
  if (result.truncated) throw new Error("文件太大，无法保存为应用页。");
  return result.contents;
}

function ViewerHeader(props: { item: SpaceItem; children?: ReactNode }) {
  const meta = spaceItemMeta(props.item);
  const Icon = meta.icon;
  return (
    <header
      className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3"
      data-space-viewer-header
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-ui">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{props.item.title}</span>
        <span className="shrink-0 text-ui-sm text-muted-foreground">{meta.label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5">{props.children}</span>
    </header>
  );
}

/** A file: one an agent wrote in a chat, or one the 资料库 keeps. */
export function SpaceOutputViewer(props: {
  item: SpaceItem;
  onContinueInChat: (item: SpaceItem) => void;
  onSaveAsApp: (item: SpaceItem) => void;
  onTrash: (item: SpaceItem) => void;
  /** "转换为可编辑的幻灯片 / 电子表格" for .pptx, .xlsx and .csv files (types stream). */
  onConvert?: (file: { root: string | null; path: string }) => void;
}) {
  const file =
    props.item.source.type === "output"
      ? {
          key: props.item.source.output.id,
          root: props.item.source.output.workspaceRoot,
          path: props.item.source.output.path,
          origin: `来自对话“${props.item.source.output.threadTitle || "未命名对话"}” · ${props.item.source.output.path}`,
        }
      : props.item.source.type === "library" && props.item.source.item.path
        ? {
            key: props.item.source.item.id,
            root: null,
            path: props.item.source.item.path,
            origin: `资料库 · ${props.item.source.item.path}`,
          }
        : null;
  if (!file) return null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-space-output-viewer>
      <ViewerHeader item={props.item}>
        {props.item.sourceThreadId ? (
          <PageChromeButton
            icon={ChatBubbleIcon}
            label="在对话中继续"
            onClick={() => props.onContinueInChat(props.item)}
          />
        ) : null}
        {isHtmlOutput(props.item) ? (
          <PageChromeButton
            icon={WindowAppIcon}
            label="保存为应用页"
            onClick={() => props.onSaveAsApp(props.item)}
          />
        ) : null}
        {props.onConvert && fileConversionFor(file.path) ? (
          <PageChromeButton
            icon={fileConversionFor(file.path) === "slides" ? SlideDeckIcon : SpreadsheetIcon}
            label={FILE_CONVERSION_LABELS[fileConversionFor(file.path)!]}
            onClick={() => props.onConvert?.({ root: file.root, path: file.path })}
          />
        ) : null}
        {props.item.trashedAt ? null : (
          <PageChromeButton
            icon={TrashCanIcon}
            label="移到回收站"
            iconOnly
            onClick={() => props.onTrash(props.item)}
          />
        )}
      </ViewerHeader>
      <p className="truncate border-b border-border px-5 py-1.5 text-ui-sm text-muted-foreground">
        {file.origin}
      </p>
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspaceFilePreview
          key={file.key}
          workspaceRoot={file.root}
          filePath={file.path}
          markdownPreviewDefault
          liveRevalidationEnabled
        />
      </div>
    </div>
  );
}

/**
 * An 应用页. The runnable frame (`AppPageFrame`, apps-runtime) replaces the body here; until it
 * is integrated this shows the same props as a card, as the shared spec asks.
 */
export function SpaceAppViewer(props: {
  item: SpaceItem;
  onContinueInChat: (item: SpaceItem) => void;
}) {
  if (props.item.source.type !== "app") return null;
  const { app } = props.item.source;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-space-app-viewer
      data-app-page-id={app.id}
    >
      <ViewerHeader item={props.item}>
        {app.sourceThreadId ? (
          <PageChromeButton
            icon={ChatBubbleIcon}
            label="在对话中继续"
            onClick={() => props.onContinueInChat(props.item)}
          />
        ) : null}
      </ViewerHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <AppPageFrame key={app.id} appPageId={app.id} mode="full" className="min-h-0 flex-1" />
      </div>
    </div>
  );
}

const STUB_COPY: Record<string, { title: string; body: string }> = {
  slides: { title: "幻灯片", body: "幻灯片编辑器会在这个版本中推出。" },
  sheet: { title: "电子表格", body: "电子表格会在这个版本中推出。" },
  site: { title: "站点", body: "站点发布会在这个版本中推出。" },
  board: { title: "白板", body: "白板会在这个版本中推出。" },
  app: {
    title: "应用页",
    body: "可运行的应用页会在这个版本中推出。你也可以把对话里生成的网页保存为应用页。",
  },
  image: { title: "图像", body: "在图像工作区生成或编辑图像，生成的图像会出现在资料空间。" },
  template: { title: "从模板开始", body: "模板库会在这个版本中推出。" },
  plugin: { title: "连接插件", body: "连接云端文档等插件的入口会在这个版本中推出。" },
};

/** Placeholder for a kind another stream of this build owns; that stream replaces it. */
export function SpaceComingSoon(props: {
  kind: string;
  /** The stored item, when one was opened (e.g. a 幻灯片 row created elsewhere). */
  item?: SpaceItem | null;
  action?: { label: string; onClick: () => void } | undefined;
}) {
  const copy = STUB_COPY[props.kind] ?? {
    title: spaceKindMeta(props.kind).label,
    body: "这个类型会在这个版本中推出。",
  };
  const Icon = spaceKindMeta(props.kind).icon;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-space-coming-soon={props.kind}>
      {props.item ? <ViewerHeader item={props.item} /> : null}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
        <Icon aria-hidden className="size-5 text-muted-foreground" />
        <h1 className={PAGE_TITLE_CLASS_NAME}>{props.item?.title ?? copy.title}</h1>
        <p className="max-w-sm text-ui text-muted-foreground">{copy.body}</p>
        {props.action ? (
          <Button size="sm" variant="outline" onClick={props.action.onClick}>
            {props.action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
