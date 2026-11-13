// FILE: SheetHistoryPanel.tsx
// Purpose: 版本历史 beside a 电子表格: its saved versions newest first (who, when, 当前), a page of
//          older ones at a time; picking one shows that version in the grid, view only.
// Layer: 资料空间 电子表格 (side pane)
// Exports: SheetHistoryPanel.
// Why: Every save of a sheet keeps its workbook at that page revision, so any version can be
//      shown and restored; the list is the page's own version list.

import type { Page, PageVersion } from "@moss/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { operationLabel, useVersionSummaries } from "../../pages/PageSidePanels";
import { formatRelativeTime } from "../../space/spaceItems";
import { Button } from "../../ui/button";
import { SpaceSidePanel } from "../shared/SpaceEditorChrome";

function who(version: PageVersion): string {
  if (version.author === "agent") return "Moss";
  if (version.author === "guest") return "访客";
  return "你";
}

export function SheetHistoryPanel(props: {
  readonly account: string;
  readonly page: Page;
  /** The saved revision now (the one marked 当前). */
  readonly revision: number;
  /** The version shown in the grid, or null for the current sheet. */
  readonly viewing: number | null;
  /** The version being opened. */
  readonly opening: number | null;
  readonly onOpen: (version: { revision: number; createdAt: string; current: boolean }) => void;
  readonly onClose: () => void;
}) {
  const [now] = useState(() => Date.now());
  const versions = useVersionSummaries({
    account: props.account,
    scopeSpaceId: props.page.scopeSpaceId,
    pageId: props.page.id,
    revision: props.revision,
    enabled: true,
  });
  const list = versions.data?.pages.flatMap((page) => page.versions) ?? [];
  return (
    <SpaceSidePanel
      title="版本历史"
      closeLabel="关闭版本历史"
      onClose={props.onClose}
      testId="sheet-history"
    >
      <div className="flex flex-col gap-2 p-2">
        {versions.error ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 p-1 text-ui-sm text-destructive"
          >
            <p>版本历史没有加载出来。</p>
            <Button size="xs" variant="ghost" onClick={() => void versions.refetch()}>
              重试
            </Button>
          </div>
        ) : null}
        {versions.isPending && !versions.error ? (
          <p role="status" className="p-1 text-ui-sm text-muted-foreground">
            正在加载版本历史…
          </p>
        ) : null}
        <ol className="flex flex-col gap-0.5" aria-label="版本历史">
          {list.map((version) => {
            const revision = version.page.revision;
            const current = revision === props.revision;
            const shown = props.viewing === null ? current : props.viewing === revision;
            return (
              <li key={revision}>
                <Button
                  type="button"
                  variant="ghost"
                  aria-current={shown ? "true" : undefined}
                  disabled={props.opening !== null}
                  className={cn(
                    "h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left font-normal",
                    shown && "bg-accent",
                  )}
                  onClick={() => props.onOpen({ revision, createdAt: version.createdAt, current })}
                >
                  <span className="text-ui">
                    {who(version)} {operationLabel(version.operation)}
                    {current ? (
                      <span className="ms-1.5 text-ui-sm text-muted-foreground">当前</span>
                    ) : null}
                    {props.opening === revision ? (
                      <span className="ms-1.5 text-ui-sm text-muted-foreground">正在打开…</span>
                    ) : null}
                  </span>
                  <span
                    className="text-ui-sm text-muted-foreground"
                    title={new Date(version.createdAt).toLocaleString()}
                  >
                    版本 {revision} · {formatRelativeTime(version.createdAt, now)}
                  </span>
                </Button>
              </li>
            );
          })}
        </ol>
        {versions.hasNextPage ? (
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            disabled={versions.isFetchingNextPage}
            onClick={() => void versions.fetchNextPage()}
          >
            {versions.isFetchingNextPage ? "正在加载…" : "显示更早的版本"}
          </Button>
        ) : null}
      </div>
    </SpaceSidePanel>
  );
}
