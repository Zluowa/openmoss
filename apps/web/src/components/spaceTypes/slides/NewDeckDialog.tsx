// FILE: NewDeckDialog.tsx
// Purpose: 新建幻灯片 quick start: four ways in (空白开始 · 从文件导入 · 用资料空间内容生成 ·
//          从模板开始) and, under them, "describe the deck and let Moss make it".
// Layer: 资料空间 幻灯片

import { useMemo, useState } from "react";

import {
  CloudUploadIcon,
  FoldersIcon,
  SlidesIcon,
  TemplateIcon,
  type LucideIcon,
} from "~/lib/icons";
import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";

export interface NewDeckSourcePage {
  readonly id: string;
  readonly title: string;
}

function Start(props: {
  icon: LucideIcon;
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex flex-col items-start gap-1.5 rounded-[10px] border border-border bg-card p-3 text-left transition-colors hover:bg-accent disabled:opacity-50"
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-ui font-medium">{props.label}</span>
      <span className="text-ui-xs text-muted-foreground">{props.hint}</span>
    </button>
  );
}

export function NewDeckDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  /** 资料空间 pages a deck can be made from. */
  pages: readonly NewDeckSourcePage[];
  onBlank: () => void;
  onTemplate: () => void;
  onImport: () => void;
  onGenerate: (prompt: string) => void;
  onFromPage: (page: NewDeckSourcePage) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(
    () =>
      props.pages
        .filter((page) => page.title.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 50),
    [props.pages, query],
  );
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setPicking(false);
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton>
        <div className="flex flex-col gap-4 p-5" data-new-deck-dialog>
          <DialogTitle>{picking ? "选择资料空间内容" : "新建幻灯片"}</DialogTitle>
          {picking ? (
            <div className="flex flex-col gap-2" data-new-deck-pages>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索页面"
                aria-label="搜索页面"
                className="h-8 rounded-control border border-input bg-background px-2.5 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex max-h-72 flex-col overflow-y-auto">
                {matches.length ? (
                  matches.map((page) => (
                    <button
                      key={page.id}
                      type="button"
                      disabled={props.busy}
                      onClick={() => props.onFromPage(page)}
                      className="truncate rounded-[6px] px-2.5 py-1.5 text-left text-ui-sm hover:bg-accent"
                    >
                      {page.title || "未命名页面"}
                    </button>
                  ))
                ) : (
                  <p className="px-2.5 py-3 text-ui-sm text-muted-foreground">没有可用的页面。</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setPicking(false)}
              >
                返回
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Start
                  icon={SlidesIcon}
                  label="空白开始"
                  hint="一张封面，自己往下写"
                  disabled={props.busy}
                  onClick={props.onBlank}
                />
                <Start
                  icon={CloudUploadIcon}
                  label="从文件导入"
                  hint="PowerPoint 转成可编辑的幻灯片"
                  disabled={props.busy}
                  onClick={props.onImport}
                />
                <Start
                  icon={FoldersIcon}
                  label="用资料空间内容生成"
                  hint="选一个页面，Moss 把它做成演示"
                  disabled={props.busy}
                  onClick={() => setPicking(true)}
                />
                <Start
                  icon={TemplateIcon}
                  label="从模板开始"
                  hint="周报、提案、复盘等现成结构"
                  disabled={props.busy}
                  onClick={props.onTemplate}
                />
              </div>
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (prompt.trim()) props.onGenerate(prompt.trim());
                }}
              >
                <label className="text-ui-sm text-muted-foreground" htmlFor="new-deck-prompt">
                  或者描述你要的演示文稿，让 Moss 生成
                </label>
                <textarea
                  id="new-deck-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && prompt.trim()) {
                      event.preventDefault();
                      props.onGenerate(prompt.trim());
                    }
                  }}
                  rows={3}
                  maxLength={4_000}
                  placeholder="例如：给团队做一份 8 页的 Q4 复盘，包含目标完成情况、关键数据和下季度重点"
                  className="rounded-control border border-input bg-background px-2.5 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button type="submit" disabled={props.busy || !prompt.trim()}>
                  让 Moss 生成
                </Button>
              </form>
            </>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
