// FILE: SheetCellHistory.tsx
// Purpose: 单元格的编辑历史: what one cell held across the sheet's recent versions, newest first —
//          who changed it to what, and when — with a way to open the version it came from.
// Layer: 资料空间 电子表格 (side pane)
// Exports: SheetCellHistory, CellHistoryTarget.
// Why: Every save keeps the workbook at that page revision, so a cell's history is the cell read
//      from each version; consecutive versions that left it alone are folded together.

import type { Page, PageVersion } from "@moss/contracts";
import { formatSheetNumber } from "@moss/shared/spaceItems/sheetValues";
import { parseSheetWorkbook, type SheetCell } from "@moss/shared/spaceItems/sheetWorkbook";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { formatRelativeTime } from "../../space/spaceItems";
import { Button } from "../../ui/button";
import { SpaceSidePanel } from "../shared/SpaceEditorChrome";
import { cellHistoryEntries, type CellHistoryTarget } from "./sheetCellHistory.logic";

export type { CellHistoryTarget } from "./sheetCellHistory.logic";

/** How many versions back a cell's history looks. */
const VERSIONS_LOOKED_AT = 30;

function cellShown(cell: SheetCell | undefined): string | null {
  if (!cell) return null;
  if (cell.f) return cell.f;
  if (cell.v === null || cell.v === "") return null;
  if (typeof cell.v === "number" && cell.s?.format) return formatSheetNumber(cell.s.format, cell.v);
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  return String(cell.v);
}

function who(author: PageVersion["author"]): string {
  return author === "agent" ? "Moss" : author === "guest" ? "访客" : "你";
}

export function SheetCellHistory(props: {
  readonly page: Page;
  /** The saved revision now. */
  readonly revision: number;
  readonly target: CellHistoryTarget;
  readonly onOpenVersion: (version: {
    revision: number;
    createdAt: string;
    current: boolean;
  }) => void;
  readonly onClose: () => void;
}) {
  const [now] = useState(() => Date.now());
  /** How many batches of versions back the history reads. */
  const [batches, setBatches] = useState(1);
  /** What the cell held in each version read so far, so a longer look reads only the new ones. */
  const known = useRef(new Map<string, string | null>());
  const { target, page } = props;
  const history = useQuery({
    queryKey: [
      "sheet-cell-history",
      page.id,
      props.revision,
      target.sheetId,
      target.r,
      target.c,
      batches,
    ],
    queryFn: async () => {
      const api = ensureNativeApi();
      const versions: PageVersion[] = [];
      let before: number | undefined;
      let complete = false;
      for (let batch = 0; batch < batches; batch++) {
        const page_ = await api.pages.versions({
          scopeSpaceId: page.scopeSpaceId,
          pageId: page.id,
          summaryOnly: true,
          limit: VERSIONS_LOOKED_AT,
          ...(before === undefined ? {} : { beforeRevision: before }),
        });
        versions.push(...page_.versions);
        if (page_.versions.length < VERSIONS_LOOKED_AT) {
          complete = true;
          break;
        }
        before = page_.versions.at(-1)?.page.revision;
      }
      const read: {
        revision: number;
        createdAt: string;
        author: PageVersion["author"];
        shown: string | null;
      }[] = [];
      // One version at a time, newest first: a long history must not flood the server.
      for (const version of versions) {
        const cacheKey = `${target.sheetId}|${target.r}:${target.c}|${version.page.revision}`;
        if (known.current.has(cacheKey)) {
          read.push({
            revision: version.page.revision,
            createdAt: version.createdAt,
            author: version.author,
            shown: known.current.get(cacheKey) ?? null,
          });
          continue;
        }
        const item = await api.pageTypes.read({
          scopeSpaceId: page.scopeSpaceId,
          pageId: page.id,
          revision: version.page.revision,
        });
        let shown: string | null = null;
        try {
          const sheet = parseSheetWorkbook(item.data ?? "").sheets.find(
            (s) => s.id === target.sheetId,
          );
          shown = cellShown(
            sheet?.cells.find((cell) => cell.r === target.r && cell.c === target.c),
          );
        } catch {
          shown = null;
        }
        known.current.set(cacheKey, shown);
        read.push({
          revision: version.page.revision,
          createdAt: version.createdAt,
          author: version.author,
          shown,
        });
      }
      return { entries: cellHistoryEntries(read), complete, looked: versions.length };
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    // Looking further back keeps what is shown until the longer list is read.
    placeholderData: (previous) => previous,
  });
  return (
    <SpaceSidePanel
      title={`编辑历史 · ${target.label}`}
      closeLabel="关闭编辑历史"
      onClose={props.onClose}
      testId="sheet-cell-history"
    >
      <div className="flex flex-col gap-2 p-2">
        {history.isPending ? (
          <p role="status" className="p-1 text-ui-sm text-muted-foreground">
            正在读取这个单元格的历史…
          </p>
        ) : null}
        {history.error ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 p-1 text-ui-sm text-destructive"
          >
            <p>编辑历史没有读出来。</p>
            <Button size="xs" variant="ghost" onClick={() => void history.refetch()}>
              重试
            </Button>
          </div>
        ) : null}
        {history.data && history.data.entries.length === 0 ? (
          <p className="p-1 text-ui-sm text-muted-foreground">最近的版本里这个单元格一直是空的。</p>
        ) : null}
        <ol className="flex flex-col gap-0.5" aria-label={`${target.label} 的编辑历史`}>
          {history.data?.entries.map((entry) => (
            <li key={entry.revision}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left font-normal"
                onClick={() =>
                  props.onOpenVersion({
                    revision: entry.revision,
                    createdAt: entry.createdAt,
                    current: entry.revision === props.revision,
                  })
                }
              >
                <span className="w-full truncate text-ui">
                  {who(entry.author)}
                  {entry.shown === null ? " 清空了它" : ` 改成 ${entry.shown}`}
                </span>
                <span
                  className="text-ui-sm text-muted-foreground"
                  title={new Date(entry.createdAt).toLocaleString()}
                >
                  版本 {entry.revision} · {formatRelativeTime(entry.createdAt, now)}
                </span>
              </Button>
            </li>
          ))}
        </ol>
        {history.data && !history.data.complete ? (
          <div className="flex flex-col items-start gap-1 p-1">
            <p className="text-ui-sm text-muted-foreground">
              看了最近 {history.data.looked} 个版本。
            </p>
            <Button
              size="xs"
              variant="ghost"
              disabled={history.isFetching}
              onClick={() => setBatches((n) => n + 1)}
            >
              {history.isFetching ? "正在读取…" : `再往前看 ${VERSIONS_LOOKED_AT} 个版本`}
            </Button>
          </div>
        ) : null}
      </div>
    </SpaceSidePanel>
  );
}
