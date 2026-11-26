// FILE: NewDeckDialog.tsx
// Purpose: 新建幻灯片: describe the deck and Moss makes it; under the box, the other ways in
//          (空白 · 导入 PPT · 用页面生成 · 模板) as one quiet row.
// Layer: 资料空间 幻灯片

import { useMemo, useState } from "react";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";

import { CloudUploadIcon, FoldersIcon, SlidesIcon, TemplateIcon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";

export interface NewDeckSourcePage {
  readonly id: string;
  readonly title: string;
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
              <Input
                autoFocus
                size="sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索页面"
                aria-label="搜索页面"
              />
              <div className="flex max-h-72 flex-col overflow-y-auto">
                {matches.length ? (
                  matches.map((page) => (
                    <Button
                      key={page.id}
                      variant="ghost"
                      size="sm"
                      disabled={props.busy}
                      onClick={() => props.onFromPage(page)}
                      className="w-full justify-start truncate text-left font-normal"
                    >
                      {page.title || "未命名文档"}
                    </Button>
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
            // Say what the deck is about and Moss makes it; the other ways in sit below it.
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (prompt.trim()) props.onGenerate(prompt.trim());
              }}
            >
              <Textarea
                autoFocus
                aria-label="描述这份演示"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeComposingKeyEvent(event)) return;
                  if (event.key === "Enter" && !event.shiftKey && prompt.trim()) {
                    event.preventDefault();
                    props.onGenerate(prompt.trim());
                  }
                }}
                rows={4}
                maxLength={4_000}
                placeholder="描述这份演示，Moss 来做。比如：8 页的 Q4 复盘"
              />
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    [SlidesIcon, "空白", props.onBlank],
                    [CloudUploadIcon, "导入 PPT", props.onImport],
                    [FoldersIcon, "用页面生成", () => setPicking(true)],
                    [TemplateIcon, "模板", props.onTemplate],
                  ] as const
                ).map(([Icon, label, onClick]) => (
                  <Button
                    key={label}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={props.busy}
                    onClick={onClick}
                  >
                    <Icon aria-hidden />
                    {label}
                  </Button>
                ))}
                <Button
                  type="submit"
                  size="sm"
                  className="ms-auto"
                  disabled={props.busy || !prompt.trim()}
                >
                  生成
                </Button>
              </div>
            </form>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
