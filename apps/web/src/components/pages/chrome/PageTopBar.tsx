// FILE: PageTopBar.tsx
// Purpose: The page's top bar as two clusters of pills. Left: the title pill (with its menu),
//          one capsule of icon-only quick actions, and the save state. Right: one capsule with
//          历史 and 评论, the presence avatars, then the 分享 pill.
// Layer: Space page chrome (owned by space-ui)
// Geometry: see pageChromeStyles.ts.

import type { ReactNode } from "react";

import { HistoryIcon, PageCommentIcon, Rows3Icon, SparklesIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { PageChromeButton } from "./PageChromeButton";
import type { PageChromeContext } from "./pageChromeContext";
import { PAGE_CHROME_BAR_CLASS_NAME, PAGE_CHROME_CAPSULE_CLASS_NAME } from "./pageChromeStyles";
import { TopBarPresence } from "./TopBarPresence";
import { TopBarQuickActions } from "./TopBarQuickActions";
import { TopBarShare } from "./TopBarShare";

export function PageTopBar(props: {
  context: PageChromeContext;
  /** The title pill with its menu. */
  titleMenu: ReactNode;
  saveState: "saving" | "dirty" | "saved";
}) {
  const { context } = props;
  const dock = context.dock ?? null;
  const dockOpen = Boolean(dock && dock.state !== "collapsed");
  const tocActive = Boolean(context.tocOpen ?? context.activePanel === "navigation");

  const handleToggleToc = () => {
    if (context.onToggleToc) {
      context.onToggleToc();
      return;
    }
    context.openPanel(context.activePanel === "navigation" ? null : "navigation");
  };

  const handleToggleDock = () => {
    if (!dock) return;
    if (dock.state === "collapsed") {
      void dock.ask();
    } else {
      dock.setState("collapsed");
    }
  };

  return (
    <header
      role="toolbar"
      aria-label="页面工具栏"
      className={PAGE_CHROME_BAR_CLASS_NAME}
      data-page-top-bar
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <PageChromeButton
          icon={Rows3Icon}
          label="目录大纲"
          iconOnly
          active={tocActive}
          onClick={handleToggleToc}
        />
        {props.titleMenu}
        <div
          role="group"
          aria-label="页面快捷操作"
          className={cn(PAGE_CHROME_CAPSULE_CLASS_NAME, "hidden @[640px]/page-topbar:inline-flex")}
          data-page-slot="topBarQuickActions"
        >
          <TopBarQuickActions context={context} />
        </div>
        <span
          role="status"
          className="shrink-0 truncate text-ui-xs text-muted-foreground"
          data-page-save-state={props.saveState}
        >
          {props.saveState === "saving" ? "正在保存…" : props.saveState === "dirty" ? "未保存" : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5" data-page-slot="topBarRight">
        <div role="group" aria-label="历史和评论" className={PAGE_CHROME_CAPSULE_CLASS_NAME}>
          <PageChromeButton
            icon={HistoryIcon}
            label="历史"
            iconOnly
            active={context.activePanel === "history"}
            onClick={() => context.openPanel(context.activePanel === "history" ? null : "history")}
          />
          <PageChromeButton
            icon={PageCommentIcon}
            label="评论"
            iconOnly
            active={context.activePanel === "comments"}
            onClick={() =>
              context.openPanel(context.activePanel === "comments" ? null : "comments")
            }
          />
        </div>
        <TopBarPresence context={context} />
        <TopBarShare context={context} />
        {dock ? (
          <Button
            size="xs"
            variant={dockOpen ? "secondary" : "outline"}
            aria-pressed={dockOpen}
            aria-label="问 Moss"
            data-page-dock-toggle
            onClick={handleToggleDock}
            className="h-7 gap-1.5 rounded-full px-2.5 text-ui-sm font-medium tabular-nums"
          >
            <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
            <span>{dock.busy && dock.statusLabel ? dock.statusLabel : "问 Moss"}</span>
            {dock.busy ? (
              <span
                className={cn("size-1.5 shrink-0 rounded-full animate-pulse bg-primary")}
                aria-hidden
              />
            ) : null}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
