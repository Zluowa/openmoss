// FILE: PageTopBar.tsx
// Purpose: The page's top bar as two clusters of pills. Left: the title pill (with its menu),
//          one capsule of icon-only quick actions, and the save state. Right: one capsule with
//          历史 and 评论, the presence avatars, then the 分享 pill.
// Layer: Space page chrome (owned by space-ui)
// Geometry: see pageChromeStyles.ts.

import type { ReactNode } from "react";

import { HistoryIcon, PageCommentIcon } from "~/lib/icons";

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
  return (
    <header
      role="toolbar"
      aria-label="页面工具栏"
      className={PAGE_CHROME_BAR_CLASS_NAME}
      data-page-top-bar
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {props.titleMenu}
        <div
          role="group"
          aria-label="页面快捷操作"
          className={PAGE_CHROME_CAPSULE_CLASS_NAME}
          data-page-slot="topBarQuickActions"
        >
          <TopBarQuickActions context={context} />
        </div>
        <span
          role="status"
          className="shrink-0 truncate text-ui-sm text-muted-foreground"
          data-page-save-state={props.saveState}
        >
          {props.saveState === "saving" ? "正在保存…" : props.saveState === "dirty" ? "未保存" : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2" data-page-slot="topBarRight">
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
      </div>
    </header>
  );
}
