// FILE: SheetEditorHost.tsx
// Purpose: Hosts the 电子表格 editor inside an opened 资料空间 item: sends "让 Moss …" requests to
//          the selected agent as a page turn, takes in the revisions the agent writes while it
//          works (each lands at once, its cells marked), and offers "撤销 Moss 的修改".
// Layer: 资料空间 电子表格 AI (types stream)
// Exports: SheetEditorHost.

import { PROVIDER_DISPLAY_NAMES, type PagesReadResult, type PageTypedItem } from "@moss/contracts";
import { parseSheetWorkbook, type SheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { ensureNativeApi } from "~/nativeApi";
import { SparklesIcon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { formatRelativeTime } from "../../space/spaceItems";
import { sheetAskPrompt } from "./sheetAiPrompt";
import { SheetCellHistory, type CellHistoryTarget } from "./SheetCellHistory";
import { SheetHistoryPanel } from "./SheetHistoryPanel";
import { sheetCommentLabel, sheetCommentsKey, type SheetCommentCell } from "./sheetComments.logic";
import { usePageCommentSync } from "../shared/pageCommentSync";
import type { SheetAskRequest } from "./SheetEditor";

const SheetEditor = lazy(() =>
  import("./SheetEditor").then((module) => ({ default: module.SheetEditor })),
);

const POLL_MS = 2_500;
const QUIET_MS = 45_000;
const RUN_LIMIT_MS = 10 * 60_000;
const FLASH_MS = 2_600;

/** Cells whose value, formula or look differ between two workbooks, as `sheetId|r:c`. */
function changedCells(before: SheetWorkbook, after: SheetWorkbook): string[] {
  const out: string[] = [];
  for (const sheet of after.sheets) {
    const old = before.sheets.find((s) => s.id === sheet.id);
    const oldCells = new Map(
      (old?.cells ?? []).map((cell) => [`${cell.r}:${cell.c}`, JSON.stringify(cell)]),
    );
    const seen = new Set<string>();
    for (const cell of sheet.cells) {
      const key = `${cell.r}:${cell.c}`;
      seen.add(key);
      if (oldCells.get(key) !== JSON.stringify(cell)) out.push(`${sheet.id}|${key}`);
    }
    for (const key of oldCells.keys()) if (!seen.has(key)) out.push(`${sheet.id}|${key}`);
  }
  return out;
}

export function SheetEditorHost(props: {
  account: string;
  item: PageTypedItem;
  workbook: SheetWorkbook;
  title: string;
  readOnly: boolean;
  /** Bumped when the workbook was replaced from outside the editor. */
  epoch: number;
  onChange: (workbook: SheetWorkbook) => void;
  onReplace: (workbook: SheetWorkbook) => void;
  /** Saves pending edits; false if they could not be saved. */
  flush: () => Promise<boolean>;
  /** The saved revision right now. */
  revision: () => number;
  /** Re-reads the item and reloads it when someone else (an agent) saved a newer revision. */
  reloadIfChanged: () => Promise<boolean>;
}) {
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const latest = useRef(props);
  latest.current = props;
  const startAccount = useRef(props.account);
  const page = props.item.page;
  const [run, setRun] = useState<{ startedAt: number; changedAt: number } | null>(null);
  const [lastChange, setLastChange] = useState<{ before: SheetWorkbook; count: number } | null>(
    null,
  );
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const beforeRun = useRef<SheetWorkbook | null>(null);
  const shown = useRef(props.workbook);
  const mountedAt = useRef(Date.now());
  /** The workbook as the person last left it (what a restore replaces). */
  const lastLive = useRef(props.workbook);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewing, setViewing] = useState<{
    revision: number;
    createdAt: string;
    workbook: SheetWorkbook;
  } | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  /** The cell whose edit history the side pane shows, instead of the version list. */
  const [cellTarget, setCellTarget] = useState<CellHistoryTarget | null>(null);

  // Cell comments live with the page on the server, as 文档's do.
  usePageCommentSync({
    pageId: page.id,
    scopeSpaceId: page.scopeSpaceId,
    pageKey: sheetCommentsKey(page.id),
  });
  const agent = threads.describePageAgent({ page, content: "" } as PagesReadResult);
  const agentLabel = agent
    ? `${PROVIDER_DISPLAY_NAMES[agent.modelSelection.provider] ?? agent.modelSelection.provider} · ${agent.modelSelection.model}`
    : null;

  // A newer workbook arrived (the agent wrote, or a conflict reload): mark what changed.
  useEffect(() => {
    const before = shown.current;
    shown.current = props.workbook;
    lastLive.current = props.workbook;
    mountedAt.current = Date.now();
    if (before === props.workbook || !run) return;
    const changed = changedCells(before, props.workbook);
    if (!changed.length) return;
    setFlash(new Set(changed));
    setRun((current) => (current ? { ...current, changedAt: Date.now() } : current));
    const timer = setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
    // Only a new epoch is a new workbook from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.epoch]);

  // While Moss works, take in what it writes; the run ends once the sheet is quiet.
  useEffect(() => {
    if (!run) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      await latest.current.reloadIfChanged().catch(() => false);
      const now = Date.now();
      setRun((current) => {
        if (!current) return current;
        const quiet = current.changedAt
          ? now - current.changedAt > QUIET_MS
          : now - current.startedAt > RUN_LIMIT_MS;
        if (!quiet) return current;
        const before = beforeRun.current;
        if (before) {
          const count = changedCells(before, shown.current).length;
          if (count) setLastChange({ before, count });
        }
        beforeRun.current = null;
        return null;
      });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [run]);

  // Coming back to the window picks up what the agent wrote meanwhile.
  useEffect(() => {
    const onFocus = () => void latest.current.reloadIfChanged().catch(() => false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /** Sends a request to Moss; resolves to the conversation that does it, or null. */
  const onAsk = useCallback(async (ask: SheetAskRequest): Promise<string | null> => {
    try {
      // The agent reads the saved sheet, so unsaved edits are saved first.
      if (!(await latest.current.flush())) throw new Error("请先保存表格，再请 Moss 修改。");
      const saved: PagesReadResult = {
        page: { ...latest.current.item.page, revision: latest.current.revision() },
        content: "",
      };
      beforeRun.current = shown.current;
      setLastChange(null);
      setRun({ startedAt: Date.now(), changedAt: 0 });
      return await threadsRef.current.startPageAiTurn(
        saved,
        sheetAskPrompt(saved.page, ask),
        () => latest.current.account === startAccount.current,
      );
    } catch (cause) {
      setRun(null);
      toastManager.add({
        type: "error",
        title: "请求没有发出",
        description: cause instanceof Error ? cause.message : "无法交给 Moss 处理",
      });
      return null;
    }
  }, []);
  const askFromComment = useCallback(
    (body: string, cell: SheetCommentCell) => {
      const sheets = latest.current.workbook.sheets;
      const index = Math.max(
        0,
        sheets.findIndex((sheet) => sheet.id === cell.sheetId),
      );
      const sheet = sheets[index]!;
      const address = sheetCommentLabel(sheet.name, cell.r, cell.c);
      const local = address.slice(address.lastIndexOf("!") + 1);
      return onAsk({
        text: body,
        kind: "comment",
        sheetName: sheet.name,
        sheetNumber: index + 1,
        range: local,
        activeCell: local,
        isSheetBlank: sheet.cells.length === 0,
      });
    },
    [onAsk],
  );
  const canAskMoss = agent != null && !props.readOnly;
  const comments = useMemo(
    () => ({
      pageKey: sheetCommentsKey(page.id),
      pageTitle: props.title,
      sourceThreadId: page.sourceThreadId ?? "",
      ask: canAskMoss ? askFromComment : null,
    }),
    [page.id, page.sourceThreadId, props.title, canAskMoss, askFromComment],
  );

  const openVersion = async (version: {
    revision: number;
    createdAt: string;
    current: boolean;
  }) => {
    if (version.current) {
      setViewing(null);
      return;
    }
    setOpening(version.revision);
    try {
      // What is on screen is saved first, so the current version is in the list too.
      await latest.current.flush();
      const item = await ensureNativeApi().pageTypes.read({
        scopeSpaceId: page.scopeSpaceId,
        pageId: page.id,
        revision: version.revision,
      });
      setViewing({
        revision: version.revision,
        createdAt: version.createdAt,
        workbook: parseSheetWorkbook(item.data ?? ""),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "这个版本打不开",
        description: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      setOpening(null);
    }
  };
  const restoreVersion = () => {
    if (!viewing) return;
    const before = lastLive.current;
    const when = new Date(viewing.createdAt).toLocaleString();
    latest.current.onReplace(viewing.workbook);
    setViewing(null);
    toastManager.add({
      type: "success",
      title: `已恢复 ${when} 的版本`,
      actionProps: { children: "撤销恢复", onClick: () => latest.current.onReplace(before) },
    });
  };
  const historyBanner = viewing ? (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-3 text-ui-sm"
      data-sheet-history-banner
    >
      <span className="min-w-0 flex-1 truncate">
        {formatRelativeTime(viewing.createdAt, Date.now())}的版本（版本 {viewing.revision}
        ），仅供查看
      </span>
      {props.readOnly ? null : (
        <Button size="xs" variant="outline" onClick={restoreVersion}>
          恢复这个版本
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => setViewing(null)}>
        返回编辑
      </Button>
    </div>
  ) : undefined;

  const undoMoss = () => {
    if (!lastChange) return;
    latest.current.onReplace(parseSheetWorkbook(lastChange.before));
    setLastChange(null);
  };

  const notice = useMemo(() => {
    if (run)
      return (
        <div
          role="status"
          className="pointer-events-auto flex items-center gap-2 rounded-card border border-border bg-popover px-3 py-2 text-ui-sm shadow-xl"
          data-sheet-moss-working
        >
          <SparklesIcon
            className="size-4 text-muted-foreground motion-safe:animate-pulse"
            aria-hidden
          />
          <span className="text-muted-foreground">Moss 正在修改，改动会直接出现在表格里。</span>
          <Button size="xs" variant="ghost" onClick={() => setRun(null)}>
            不再等待
          </Button>
        </div>
      );
    if (lastChange)
      return (
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-card border border-border bg-popover px-3 py-2 text-ui-sm shadow-xl"
          data-sheet-moss-done
        >
          <span>Moss 修改了 {lastChange.count} 个单元格。</span>
          <Button size="xs" variant="outline" onClick={undoMoss}>
            撤销 Moss 的修改
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setLastChange(null)}>
            知道了
          </Button>
        </div>
      );
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, lastChange]);

  return (
    <Suspense fallback={<p className="p-8 text-muted-foreground">正在载入表格…</p>}>
      <SheetEditor
        key={viewing ? `version-${viewing.revision}` : props.epoch}
        workbook={viewing ? viewing.workbook : props.workbook}
        title={props.title}
        readOnly={props.readOnly || viewing !== null}
        banner={historyBanner}
        history={{
          open: historyOpen,
          onToggle: () => {
            setHistoryOpen((open) => !open);
            setViewing(null);
            setCellTarget(null);
          },
          panel: cellTarget ? (
            <SheetCellHistory
              page={page}
              revision={props.revision()}
              target={cellTarget}
              onOpenVersion={(version) => void openVersion(version)}
              onClose={() => {
                setCellTarget(null);
                setHistoryOpen(false);
                setViewing(null);
              }}
            />
          ) : (
            <SheetHistoryPanel
              account={props.account}
              page={page}
              revision={props.revision()}
              viewing={viewing?.revision ?? null}
              opening={opening}
              onOpen={(version) => void openVersion(version)}
              onClose={() => {
                setHistoryOpen(false);
                setViewing(null);
              }}
            />
          ),
        }}
        onChange={(next) => {
          if (viewing) return;
          lastLive.current = next;
          // A person's own edit ends the undo offer: it would take their edit back too. The
          // engine's first report after a reload is not an edit.
          if (Date.now() - mountedAt.current > 1_500) setLastChange(null);
          props.onChange(next);
        }}
        onReplace={props.onReplace}
        moss={
          agent && !props.readOnly && !viewing
            ? { label: agentLabel ?? "Moss", busy: run !== null, onAsk: (ask) => void onAsk(ask) }
            : null
        }
        flash={flash}
        notice={notice}
        comments={viewing ? null : comments}
        viewerKey={viewing ? null : page.id}
        onCellHistory={
          viewing
            ? null
            : (target) => {
                setCellTarget(target);
                setHistoryOpen(true);
              }
        }
      />
    </Suspense>
  );
}
