// FILE: DesignLinkDialog.tsx
// Purpose: Adds a link card to the 设计 canvas: pick another 资料空间 item (a deck, a doc, another
//          design) or type a web address; the card opens it.
// Layer: 资料空间 设计 (web)
// Why: Link cards connect a canvas to what was made from it, as design canvases do; in Moss they
//      point at 资料空间 items (`moss://space-page/<id>`) or web pages.

import type { SpaceId } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";

import { SPACE_PAGE_LINK_PREFIX } from "~/lib/spacePageLink";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";

const FIELD =
  "h-7 w-full min-w-0 rounded-control-xs border border-border bg-transparent px-2 text-ui text-foreground outline-none focus:border-[var(--color-text-accent)]";

const KIND_LABELS: Record<string, string> = {
  page: "文档",
  slides: "幻灯片",
  sheet: "表格",
  board: "白板",
  design: "设计",
  app: "应用页",
  data: "数据",
};

export function DesignLinkDialog(props: {
  scopeSpaceId: SpaceId | null;
  selfPageId: string;
  style?: CSSProperties;
  onAdd: (card: { href: string; text: string; subtitle?: string }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const pages = useQuery({
    queryKey: ["design-link-pages", props.scopeSpaceId],
    queryFn: async () =>
      (await ensureNativeApi().pages.list({ scopeSpaceId: props.scopeSpaceId })).pages.filter(
        (page) => page.trashedAt === null && page.id !== props.selfPageId,
      ),
    staleTime: 30_000,
  });
  const found = (pages.data ?? [])
    .filter(
      (page) => !query.trim() || page.title.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice(0, 8);
  const addUrl = () => {
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+$/u.test(trimmed))
      return void toastManager.add({ type: "info", title: "请填写 https:// 开头的网址" });
    let host = trimmed;
    try {
      host = new URL(trimmed).host;
    } catch {
      // Shown as typed.
    }
    props.onAdd({ href: trimmed, text: host });
  };
  return (
    <div
      role="dialog"
      aria-label="添加链接卡片"
      data-design-link-dialog=""
      className="absolute top-2 right-2 z-20 flex w-80 flex-col gap-2 rounded-popover border border-border bg-popover p-3 shadow-xl"
      style={props.style}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") props.onClose();
      }}
    >
      <span className="text-ui-sm font-medium text-foreground">添加链接卡片</span>
      <input
        autoFocus
        aria-label="搜索资料空间"
        value={query}
        placeholder="搜索资料空间里的条目"
        className={FIELD}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex max-h-56 flex-col overflow-y-auto" data-design-scrollable="">
        {pages.isLoading ? (
          <span className="px-1 py-2 text-ui-sm text-muted-foreground">正在载入…</span>
        ) : found.length ? (
          found.map((page) => (
            <Button
              key={page.id}
              size="sm"
              variant="ghost"
              className={cn("justify-between gap-2 px-2 font-normal")}
              onClick={() =>
                props.onAdd({
                  href: `${SPACE_PAGE_LINK_PREFIX}${encodeURIComponent(page.id)}`,
                  text: page.title,
                  subtitle: KIND_LABELS[page.kind ?? "page"] ?? "资料空间",
                })
              }
            >
              <span className="min-w-0 truncate">{page.title}</span>
              <span className="shrink-0 text-ui-xs text-muted-foreground">
                {KIND_LABELS[page.kind ?? "page"] ?? ""}
              </span>
            </Button>
          ))
        ) : (
          <span className="px-1 py-2 text-ui-sm text-muted-foreground">没有找到条目</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <input
          aria-label="网址"
          value={url}
          placeholder="或者填一个网址 https://…"
          className={FIELD}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addUrl();
          }}
        />
        <Button size="xs" disabled={!url.trim()} onClick={addUrl}>
          添加
        </Button>
      </div>
      <div className="flex justify-end">
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}
