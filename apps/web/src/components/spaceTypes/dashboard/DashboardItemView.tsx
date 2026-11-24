// FILE: DashboardItemView.tsx
// Purpose: Opens a 数据看板 in the 资料空间: the top bar (刷新, 使用页面 / 编辑文字, 外观, 历史, 评论,
//          数据来源), the page in its sandboxed frame, the side panels, the notice when sources
//          fail, comments with @Moss, the "让 Moss 修改" composer at the foot, the empty state,
//          and the report of how the page ran that Moss reads back.
// Layer: Web 资料空间 数据看板 host. SpaceTypedItemView renders this for app items whose payload
//        is a dashboard; saving, conflicts and the title stay there.
// Spec: docs/design/data-claude-teardown.md

import type { PagesReadResult, PageTypedItem, SpaceId, ThreadId } from "@moss/contracts";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import {
  applyDashboardSystem,
  DASHBOARD_PAGE_FILE,
  dashboardWithDraft,
  diffDashboards,
  discardDashboardDraft,
  isDashboardPayload,
  parseDashboard,
  saveDashboardDraft,
  type DashboardDataset,
  type DashboardForm,
  type DashboardItem,
  type DashboardLook,
} from "@moss/shared/spaceItems/dashboard";
import { DASHBOARD_STANDARD_LOOK } from "@moss/shared/spaceItems/dashboardFrame";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useTheme } from "~/hooks/useTheme";
import {
  ArrowUpIcon,
  VolumeIcon,
  VolumeOffIcon,
  HistoryIcon,
  PageCommentIcon,
  PaletteIcon,
  PanelRightOpenIcon,
  PencilIcon,
  PointerIcon,
  Redo2Icon,
  RefreshCwIcon,
  SparklesIcon,
  Undo2Icon,
} from "~/lib/icons";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { usePageComments, usePageCommentsStore, type PageCommentAuthor } from "~/pageCommentsStore";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import { useStore } from "~/store";
import { createThreadSelector } from "~/storeSelectors";
import { CommentPin, NewCommentCard, ThreadCard } from "../../chat/pageComments/PageComments";
import {
  pageCommentInitials,
  placePageCommentCard,
  placePageCommentPin,
  resolvePageCommentAgentReply,
} from "../../chat/pageComments/pageComments.logic";
import { useCurrentAccountIdentity } from "../../SidebarAccountMenu";
import type {
  SpaceCanvasDockController,
  SpaceCanvasHostInsets,
  SpaceCanvasSelectionContext,
} from "../../space/spaceCanvasDockContract";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import {
  SpaceSidePanel,
  SpaceToolbarButton,
  SpaceToolbarDivider,
  SpaceToolbarSegmented,
} from "../shared/SpaceEditorChrome";
import { DeckCommentAgentReplies, postDeckComment } from "../slides/deckComments";
import { dashboardTurnPrompt } from "./dashboardAiPrompt";
import { dashboardCopy } from "./dashboardCopy";
import {
  DashboardDesignPanel,
  DashboardEmptyState,
  DashboardHistoryPanel,
} from "./DashboardPanels";
import { DashboardSourcesPanel } from "./DashboardSourcesPanel";
import { useDashboardRuntime } from "./useDashboardRuntime";

type Panel = "sources" | "design" | "history";
const RUN_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 2_500;
const REPORT_DELAY_MS = 1_200;

interface Run {
  readonly id: string;
  readonly request: string;
  readonly startedAt: string;
  readonly threadId: string | null;
}

/** Ends a run once its conversation has answered (or failed). */
function RunWatcher(props: { run: Run; onDone: (id: string) => void }) {
  const threadId = props.run.threadId as ThreadId;
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  useEffect(() => retainThreadDetailSubscription(threadId), [threadId]);
  useEffect(() => {
    const state = resolvePageCommentAgentReply(thread, {
      body: props.run.request,
      sentToAgentAt: props.run.startedAt,
    });
    if (state.status === "done" || state.status === "failed") props.onDone(props.run.id);
  }, [props, thread]);
  return null;
}

export interface DashboardItemHostChrome {
  readonly hideTopBar?: boolean;
  readonly bottomInsetPx?: number;
  readonly rightInsetPx?: number;
}

export function DashboardItemView(props: {
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly item: PageTypedItem;
  readonly dashboard: DashboardItem;
  readonly title: string;
  readonly readOnly: boolean;
  /** The title field and save state, drawn at the left of the top bar. */
  readonly header: ReactNode;
  readonly onChange: (next: DashboardItem) => void;
  readonly flush: () => Promise<boolean>;
  readonly revision: () => number;
  readonly reloadIfChanged: () => Promise<boolean>;
  readonly dock?: SpaceCanvasDockController | null;
  readonly hostInsets?: SpaceCanvasHostInsets;
  readonly hostChrome?: DashboardItemHostChrome;
  readonly onHostActionsChange?: (actions: ReactNode | null) => void;
}) {
  const { locale } = useTranslation();
  const copy = dashboardCopy(locale);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const page = props.item.page;
  const dock = props.dock ?? null;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<{ revision: number; dashboard: DashboardItem } | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [noticeHidden, setNoticeHidden] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<{
    dashboard: DashboardItem;
    at: number;
  } | null>(null);
  const autoAppliedDraftRef = useRef<string | null>(null);
  const preTurnRef = useRef<{
    pageId: string;
    revision: number;
    dashboard: DashboardItem;
  } | null>(null);
  /** 调整: the look being tweaked and the steps to undo. */
  const [style, setStyle] = useState<{ look: DashboardLook; history: DashboardLook[] } | null>(
    null,
  );
  const [reading, setReading] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const agent = threads.describePageAgent({ page, content: "" } as PagesReadResult);
  const canAsk = (dock !== null || agent !== null) && !props.readOnly;

  const draft = props.dashboard.draft;
  const draftReady = Boolean(draft?.files[DASHBOARD_PAGE_FILE]?.text.trim());
  const showingDraft = Boolean(draft && draftReady && !viewing);
  const shown = useMemo(
    () =>
      viewing?.dashboard ?? (showingDraft ? dashboardWithDraft(props.dashboard) : props.dashboard),
    [viewing, showingDraft, props.dashboard],
  );
  const hasPage = Boolean(shown.files[DASHBOARD_PAGE_FILE]?.text.trim());
  const readOnly = props.readOnly || viewing !== null;
  const working = runs.length > 0 || Boolean(dock?.busy);

  const [dockInsets, setDockInsets] = useState<SpaceCanvasHostInsets | null>(null);
  const dockRegisterInsets = dock?.registerHostInsets;
  useEffect(() => {
    if (!dockRegisterInsets) {
      setDockInsets(null);
      return;
    }
    return dockRegisterInsets((next) => setDockInsets(next));
  }, [dockRegisterInsets]);

  useEffect(() => {
    setUndoSnapshot(null);
    autoAppliedDraftRef.current = null;
    preTurnRef.current = null;
    setAskOpen(false);
  }, [page.id]);

  // Auto-apply ready AI drafts live onto the dashboard and preserve a single-click undo snapshot.
  useEffect(() => {
    if (!draft || !draftReady || working || viewing || props.readOnly) return;
    const html = draft.files[DASHBOARD_PAGE_FILE]?.text ?? "";
    const sig = `${page.id}:${draft.shape}:${html.length}:${html.slice(0, 64)}`;
    if (autoAppliedDraftRef.current === sig) return;
    autoAppliedDraftRef.current = sig;
    setUndoSnapshot({ dashboard: discardDashboardDraft(props.dashboard), at: Date.now() });
    props.onChange(saveDashboardDraft(props.dashboard));
    toastManager.add({ type: "success", title: copy.mossUpdated });
  }, [
    copy.mossUpdated,
    draft,
    draftReady,
    page.id,
    props.dashboard,
    props.onChange,
    props.readOnly,
    viewing,
    working,
  ]);

  // Capture baseline before AI work begins and offer one-click undo if the server updated live.
  useEffect(() => {
    if (working) {
      if (!preTurnRef.current || preTurnRef.current.pageId !== page.id) {
        preTurnRef.current = {
          pageId: page.id,
          revision: page.revision,
          dashboard: discardDashboardDraft(props.dashboard),
        };
      }
      return;
    }
    const baseline = preTurnRef.current;
    if (baseline && baseline.pageId === page.id && page.revision > baseline.revision) {
      setUndoSnapshot((current) => current ?? { dashboard: baseline.dashboard, at: Date.now() });
      preTurnRef.current = null;
    }
  }, [page.id, page.revision, props.dashboard, working]);

  // Clear stale draft-review state on page switch if dock finished a turn.
  const prevDockBusyRef = useRef(Boolean(dock?.busy));
  useEffect(() => {
    const busy = Boolean(dock?.busy);
    const wasBusy = prevDockBusyRef.current;
    prevDockBusyRef.current = busy;
    if (wasBusy && !busy) void latest.current.reloadIfChanged();
  }, [dock?.busy]);

  // Optional live server SSE stream for immediate dashboard refresh when Moss edits server-side.
  useEffect(() => {
    if (typeof EventSource !== "function" || typeof window === "undefined") return;
    const hasRealtimeOrigin =
      Boolean(window.desktopBridge?.getWsUrl?.()) || Boolean(import.meta.env.VITE_WS_URL);
    if (!hasRealtimeOrigin) return;
    const params = new URLSearchParams({ pageId: page.id });
    if (props.scopeSpaceId) params.set("scopeSpaceId", props.scopeSpaceId);
    let source: EventSource | null = null;
    try {
      source = new EventSource(resolveWsHttpUrl(`/api/moss/pages/events?${params.toString()}`), {
        withCredentials: true,
      });
      source.addEventListener("page-updated", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as { pageId?: string };
          if (!payload.pageId || payload.pageId === page.id) {
            void latest.current.reloadIfChanged();
          }
        } catch {
          void latest.current.reloadIfChanged();
        }
      });
    } catch {
      return undefined;
    }
    return () => source?.close();
  }, [page.id, props.scopeSpaceId]);

  const handleUndoMoss = useCallback(() => {
    if (!undoSnapshot || props.readOnly) return;
    props.onChange(undoSnapshot.dashboard);
    setUndoSnapshot(null);
    toastManager.add({ type: "success", title: copy.undoneMossEdit });
  }, [copy.undoneMossEdit, props, undoSnapshot]);

  const runtime = useDashboardRuntime({
    scopeSpaceId: props.scopeSpaceId,
    pageId: page.id,
    revision: viewing?.revision ?? page.revision,
    dashboard: shown,
    theme,
    edit: editing,
    pick: panel === "sources",
    comment: commenting,
    lookOverride: style?.look ?? null,
    draft: showingDraft,
    onSerialized: (html) => {
      const current = latest.current.dashboard;
      latest.current.onChange({
        ...current,
        files: {
          ...current.files,
          [DASHBOARD_PAGE_FILE]: {
            text: html,
            edit: { via: "person", at: new Date().toISOString() },
          },
        },
      });
      setEditing(false);
    },
  });

  // ── Moss turns ─────────────────────────────────────────────────────────────────────
  const startTurn = useCallback(
    async (
      input: Omit<
        Parameters<typeof dashboardTurnPrompt>[0],
        "scopeSpaceId" | "pageId" | "revision" | "title"
      >,
    ) => {
      if (!(await latest.current.flush())) {
        toastManager.add({ type: "error", title: copy.saveFailed });
        return null;
      }
      const revision = latest.current.revision();
      const run: Run = {
        id: crypto.randomUUID(),
        request: input.request,
        startedAt: new Date().toISOString(),
        threadId: null,
      };
      setRuns((current) => [...current, run]);
      try {
        const prompt = dashboardTurnPrompt({
          ...input,
          scopeSpaceId: latest.current.scopeSpaceId,
          pageId: page.id,
          revision,
          title: latest.current.title,
        });
        const threadId = await threadsRef.current.startPageAiTurn(
          { page: { ...latest.current.item.page, revision }, content: "" } as PagesReadResult,
          prompt,
          () => latest.current.item.page.id === page.id,
        );
        setRuns((current) =>
          current.map((entry) => (entry.id === run.id ? { ...entry, threadId } : entry)),
        );
        return threadId as string;
      } catch (cause) {
        setRuns((current) => current.filter((entry) => entry.id !== run.id));
        toastManager.add({
          type: "error",
          title: copy.noAgent,
          description: cause instanceof Error ? cause.message : undefined,
        });
        return null;
      }
    },
    [copy, page.id],
  );
  const endRun = useCallback((id: string) => {
    setRuns((current) => current.filter((entry) => entry.id !== id));
    void latest.current.reloadIfChanged();
  }, []);
  // While Moss works, take each revision it saves.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      void latest.current.reloadIfChanged();
      setRuns((current) =>
        current.filter((entry) => Date.now() - Date.parse(entry.startedAt) < RUN_TIMEOUT_MS),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [working]);

  // ── Report for Moss (how the page really ran) ──────────────────────────────────────
  const reportJson = JSON.stringify([
    runtime.faults,
    runtime.pageText,
    Object.entries(runtime.sources).map(([id, s]) => [id, s.status, s.count]),
  ]);
  useEffect(() => {
    if (props.readOnly || viewing || editing || runtime.status !== "ready" || !runtime.pageText)
      return;
    const timer = setTimeout(() => {
      void ensureNativeApi()
        .pageTypes.dashboard.report({
          scopeSpaceId: props.scopeSpaceId,
          pageId: page.id,
          revision: page.revision,
          faults: runtime.faults.slice(0, 50).map((fault) => ({
            where: fault.where.slice(0, 600),
            message: fault.message.slice(0, 600),
          })),
          sources: Object.entries(runtime.sources)
            .slice(0, 120)
            .map(([id, state]) => ({
              id,
              status: state.status,
              message: state.message.slice(0, 600),
              rows: state.count,
            })),
          page: runtime.pageText!.html.slice(0, 60_000),
          width: runtime.pageText!.width,
          ...(showingDraft ? { draft: true } : {}),
        })
        .catch(() => undefined);
    }, REPORT_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportJson, page.revision, runtime.status, showingDraft]);

  // ── Sources ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!runtime.pick) return;
    setPanel("sources");
    setSelected(runtime.pick.source);
    runtime.send({
      kind: "light",
      source: runtime.pick.source,
      ...(runtime.pick.field ? { field: runtime.pick.field } : {}),
      ...(runtime.pick.row !== null ? { row: runtime.pick.row } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.pick]);
  useEffect(() => {
    if (panel !== "sources") runtime.send({ kind: "light", source: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);
  const failing = Object.entries(runtime.sources).filter(
    ([, state]) =>
      state.status === "error" || state.status === "declined" || state.status === "connect",
  );
  const attention = failing.length + runtime.calcs.filter((calc) => calc.status === "error").length;
  const loading = Object.values(runtime.sources).some((state) => state.status === "loading");

  const saveDataset = (id: string, dataset: DashboardDataset) =>
    props.onChange({
      ...props.dashboard,
      datasets: { ...props.dashboard.datasets, [id]: dataset },
    });
  const testDataset = async (id: string, dataset: DashboardDataset) => {
    if (dataset.source.kind !== "call") return { ok: false, text: "" };
    // A test runs the stored connector and tool with the edited arguments, without saving.
    try {
      const result = await ensureNativeApi().pageTypes.dashboard.query({
        scopeSpaceId: props.scopeSpaceId,
        pageId: page.id,
        datasetId: id,
        params: runtime.params as Record<string, unknown>,
        args: dataset.source.args as Record<string, unknown>,
      });
      return {
        ok: result.status === "ok",
        text:
          result.status === "ok"
            ? JSON.stringify(result.answer, null, 2).slice(0, 20_000)
            : (result.message ?? ""),
      };
    } catch (cause) {
      return { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
    }
  };

  // ── History ────────────────────────────────────────────────────────────────────────
  const viewRevision = async (revision: number | null) => {
    if (revision === null) {
      setViewing(null);
      return;
    }
    try {
      const old = await ensureNativeApi().pageTypes.read({
        scopeSpaceId: props.scopeSpaceId,
        pageId: page.id,
        revision,
      });
      if (!old.data || !isDashboardPayload(old.data)) return;
      setEditing(false);
      setViewing({ revision, dashboard: parseDashboard(old.data) });
    } catch {
      toastManager.add({ type: "error", title: copy.restoreFailed });
    }
  };
  const restore = (revision: number) => {
    if (!viewing || viewing.revision !== revision) return;
    props.onChange(viewing.dashboard);
    setViewing(null);
    toastManager.add({ type: "success", title: copy.restored });
  };

  // ── Comments ───────────────────────────────────────────────────────────────────────
  const commentsKey = `dashboard:${page.id}`;
  const comments = usePageComments(commentsKey);
  const identity = useCurrentAccountIdentity();
  const me: PageCommentAuthor = useMemo(
    () =>
      identity.kind === "authenticated" || identity.kind === "saved"
        ? { name: identity.label, initials: identity.initials }
        : {
            name: copy.historyBy.me ?? "我",
            initials: pageCommentInitials(copy.historyBy.me ?? "我"),
          },
    [copy, identity],
  );
  const [openThread, setOpenThread] = useState<string | null>(null);
  const commentIds = useMemo(
    () => [
      ...new Set(
        comments.map((comment) => comment.anchor.selector.split("/")[1] ?? "").filter(Boolean),
      ),
    ],
    [comments],
  );
  useEffect(() => {
    if (runtime.status === "ready") runtime.send({ kind: "rects", ids: commentIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentIds.join(","), runtime.status, commenting]);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setStageSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const askFromComment = useCallback(
    (body: string, anchor: { slideId: string; elementId?: string }) =>
      startTurn({ kind: "comment", request: body, at: anchor.elementId ?? null }),
    [startTurn],
  );

  // ── Keyboard ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "\\" || event.code === "Backslash")
      ) {
        if (commenting) return;
        event.preventDefault();
        setPanel((current) => (current === "sources" ? null : "sources"));
      } else if (event.key === "Escape" && commenting) {
        setCommenting(false);
        runtime.clearAnchor();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [commenting, runtime]);

  const editReason = props.readOnly
    ? copy.editLocked.readOnly
    : viewing
      ? copy.editLocked.history
      : working
        ? copy.editLocked.working
        : commenting
          ? copy.editLocked.comments
          : draft
            ? copy.editLocked.draft
            : !hasPage
              ? copy.editLocked.empty
              : null;
  // 朗读: the page's words as it shows them, in its own language, with the system voice.
  const toggleReading = () => {
    const speech = window.speechSynthesis;
    if (reading) {
      speech.cancel();
      setReading(false);
      return;
    }
    const html = runtime.pageText?.html ?? "";
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const marked = [...doc.querySelectorAll("[data-read]")];
    const text = (
      marked.length
        ? marked.map((el) => el.textContent ?? "").join("\n")
        : (doc.body.textContent ?? "")
    )
      .replace(/\s+/gu, " ")
      .trim();
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 8_000));
    utterance.lang = shown.meta.lang ?? "zh-CN";
    utterance.addEventListener("end", () => setReading(false));
    utterance.addEventListener("error", () => setReading(false));
    speech.cancel();
    speech.speak(utterance);
    setReading(true);
  };
  useEffect(
    () => () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window)
        window.speechSynthesis.cancel();
    },
    [],
  );
  const togglePanel = (next: Panel) => setPanel((current) => (current === next ? null : next));
  const noticeKey = `${failing.map(([id]) => id).join(",")}|${runtime.faults.length}`;
  const showNotice =
    hasPage &&
    !editing &&
    (failing.length > 0 || runtime.faults.length > 0) &&
    noticeHidden !== noticeKey;

  const currentSelectionContext = useCallback(
    (): SpaceCanvasSelectionContext => ({
      kind: "dashboard",
      itemId: page.id,
      title: props.title || copy.kind,
      summary: runtime.selection?.text ?? (selected ? `source:${selected}` : null),
    }),
    [copy.kind, page.id, props.title, runtime.selection?.text, selected],
  );

  const dockSetSelection = dock?.setSelection;
  useEffect(() => {
    if (!dockSetSelection) return;
    dockSetSelection(currentSelectionContext());
  }, [currentSelectionContext, dockSetSelection]);

  const askDockWithPrompt = useCallback(
    (promptText?: string, origin: "bottom-pill" | "inline-card" = "inline-card") => {
      if (!dock) return false;
      const selection = currentSelectionContext();
      dock.setSelection(selection);
      const trimmed = promptText?.trim() ?? "";
      void dock.ask({
        ...(trimmed ? { prompt: trimmed, autoRun: true } : { prefillOnly: true }),
        preferredState: dock.state === "collapsed" ? "pip" : dock.state,
        selection,
        keepItemOpen: true,
        origin,
      });
      return true;
    },
    [currentSelectionContext, dock],
  );

  const sendAsk = () => {
    const request = ask.trim();
    if (!request || !canAsk) return;
    setAsk("");
    setAskOpen(false);
    if (askDockWithPrompt(request, "bottom-pill")) return;
    void startTurn({
      kind: "change",
      request,
      selection: runtime.selection?.text ?? null,
      at: runtime.selection?.at ?? null,
      faults: runtime.faults,
    }).then((threadId) => threadId && toastManager.add({ type: "success", title: copy.asked }));
  };

  const pins = comments.flatMap((comment) => {
    const id = comment.anchor.selector.split("/")[1] ?? "";
    const rect = runtime.rects[id];
    if (!rect || comment.resolved) return [];
    const pin = placePageCommentPin(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      1,
      stageSize,
    );
    return pin ? [{ comment, pin }] : [];
  });
  const opened = pins.find((entry) => entry.comment.id === openThread);
  const newAnchor = commenting && runtime.anchor ? runtime.anchor : null;

  const toggleReadingRef = useRef(toggleReading);
  toggleReadingRef.current = toggleReading;
  const hostActions = useMemo(
    () => (
      <>
        {hasPage && !editing ? (
          <>
            <SpaceToolbarButton
              icon={RefreshCwIcon}
              label={copy.refresh}
              tooltip={copy.refreshTip}
              busy={loading}
              onClick={runtime.refreshAll}
              testId="dashboard-refresh"
            />
            {loading ? (
              <span className="hidden px-1 text-ui-sm text-muted-foreground sm:inline">
                {copy.loading}
              </span>
            ) : null}
          </>
        ) : null}
        {editing ? (
          <div className="flex items-center gap-1" data-testid="dashboard-edit-bar">
            <SpaceToolbarButton
              icon={Undo2Icon}
              label={copy.undo}
              onClick={() => runtime.send({ kind: "editCommand", command: "undo" })}
            />
            <SpaceToolbarButton
              icon={Redo2Icon}
              label={copy.redo}
              onClick={() => runtime.send({ kind: "editCommand", command: "redo" })}
            />
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              {copy.cancel}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={runtime.edits === 0}
              onClick={() => runtime.send({ kind: "serialize" })}
              data-testid="dashboard-edit-save"
            >
              {runtime.edits > 0 ? copy.saveCount(runtime.edits) : copy.save}
            </Button>
            <SpaceToolbarDivider />
          </div>
        ) : null}
        {hasPage ? (
          <SpaceToolbarSegmented
            label={copy.editPage}
            value={editing ? "edit" : "use"}
            options={[
              { value: "use", icon: PointerIcon, label: copy.usePage },
              {
                value: "edit",
                icon: PencilIcon,
                label: copy.editPage,
                disabled: editReason !== null,
                ...(editReason ? { disabledReason: editReason } : {}),
              },
            ]}
            onChange={(value) => {
              if (value === "edit") {
                setCommenting(false);
                setPanel(null);
              }
              setEditing(value === "edit");
            }}
          />
        ) : null}
        {hasPage && !editing ? (
          <SpaceToolbarButton
            icon={reading ? VolumeOffIcon : VolumeIcon}
            label={reading ? copy.readStop : copy.readAloud}
            pressed={reading}
            disabled={typeof window === "undefined" || !("speechSynthesis" in window)}
            disabledReason={copy.readUnavailable}
            onClick={() => toggleReadingRef.current()}
            testId="dashboard-read"
          />
        ) : null}
        <SpaceToolbarButton
          icon={PaletteIcon}
          label={copy.design}
          pressed={panel === "design"}
          disabled={editing}
          onClick={() => togglePanel("design")}
          testId="dashboard-design"
        />
        <SpaceToolbarButton
          icon={HistoryIcon}
          label={copy.history}
          pressed={panel === "history"}
          disabled={editing}
          onClick={() => togglePanel("history")}
          testId="dashboard-history"
        />
        {hasPage ? (
          <SpaceToolbarButton
            icon={PageCommentIcon}
            label={copy.comments}
            tooltip={copy.commentsTip}
            pressed={commenting}
            disabled={editing || viewing !== null}
            onClick={() => {
              setCommenting((value) => !value);
              runtime.clearAnchor();
            }}
            testId="dashboard-comments"
          />
        ) : null}
        <SpaceToolbarButton
          icon={PanelRightOpenIcon}
          label={copy.sources}
          tooltip={
            attention > 0
              ? `${panel === "sources" ? copy.sourcesHide : copy.sourcesTip}（${copy.needsAttention(attention)}）`
              : panel === "sources"
                ? copy.sourcesHide
                : copy.sourcesTip
          }
          shortcut={navigator.userAgent.includes("Mac") ? "⌘\\" : "Ctrl+\\"}
          pressed={panel === "sources"}
          attention={attention > 0}
          disabled={editing}
          onClick={() => togglePanel("sources")}
          testId="dashboard-sources"
        />
      </>
    ),
    [
      attention,
      commenting,
      copy,
      editReason,
      editing,
      hasPage,
      loading,
      panel,
      reading,
      runtime.clearAnchor,
      runtime.edits,
      runtime.refreshAll,
      runtime.send,
      viewing,
    ],
  );

  const onHostActionsChange = props.onHostActionsChange;
  useEffect(() => {
    if (!onHostActionsChange) return;
    onHostActionsChange(hostActions);
  }, [hostActions, onHostActionsChange]);
  useEffect(() => {
    if (!onHostActionsChange) return;
    return () => onHostActionsChange(null);
  }, [onHostActionsChange]);

  const bottomInsetPx =
    props.hostChrome?.bottomInsetPx ??
    props.hostInsets?.bottomInsetPx ??
    dockInsets?.bottomInsetPx ??
    0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-dashboard-item data-testid="dashboard-item">
      {!props.hostChrome?.hideTopBar ? (
        <header
          className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3"
          data-testid="dashboard-toolbar"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">{props.header}</div>
          {!onHostActionsChange ? hostActions : null}
        </header>
      ) : null}
      {draft && !draftReady && !viewing ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] px-4 py-1.5 text-ui-sm"
          data-testid="dashboard-draft-bar"
        >
          <span className="min-w-0 flex-1 truncate text-foreground">
            {working ? copy.draftWorking : copy.draftWaiting}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={props.readOnly}
            onClick={() => {
              props.onChange(discardDashboardDraft(props.dashboard));
              toastManager.add({ type: "success", title: copy.draftDiscarded });
            }}
            data-testid="dashboard-draft-cancel"
          >
            {copy.draftCancel}
          </Button>
        </div>
      ) : null}
      {viewing ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] px-4 py-1.5 text-ui-sm text-muted-foreground">
          <span className="flex-1">{copy.historyViewing}</span>
          <Button size="xs" variant="ghost" onClick={() => setViewing(null)}>
            {copy.historyBack}
          </Button>
        </div>
      ) : null}
      {showNotice ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5 text-ui-sm"
          role="status"
          data-testid="dashboard-notice"
        >
          <span className="flex-1 text-foreground">
            {failing.length > 0 ? copy.noticeFailed(failing.length) : copy.noticeFaults}
          </span>
          <Button size="xs" variant="ghost" onClick={() => setPanel("sources")}>
            {copy.open}
          </Button>
          {canAsk && !viewing ? (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                const faults = [
                  ...failing.map(([id, state]) => ({
                    where: `datasets/${id}`,
                    message: state.message,
                  })),
                  ...runtime.faults,
                ];
                if (
                  askDockWithPrompt(
                    `${copy.askFix}：${faults
                      .map((f) => `${f.where} (${f.message})`)
                      .join("；")
                      .slice(0, 280)}`,
                    "inline-card",
                  )
                )
                  return;
                void startTurn({
                  kind: "fix",
                  request: copy.askFix,
                  faults,
                });
              }}
            >
              {copy.askFix}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setNoticeHidden(noticeKey)}
          >
            {copy.dismiss}
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={stage} className="relative min-h-0 flex-1" data-testid="dashboard-stage">
            <iframe
              ref={runtime.frame}
              title={props.title || copy.kind}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className={cn("h-full w-full border-0 bg-background", !hasPage && "hidden")}
              data-testid="dashboard-frame"
              data-frame-status={runtime.status}
            />
            {!hasPage ? (
              <div className="absolute inset-0 bg-background">
                <DashboardEmptyState
                  copy={copy}
                  working={working}
                  readOnly={readOnly}
                  canAsk={canAsk}
                  mode={theme}
                  onAsk={(request, form, look) => {
                    if (look) props.onChange({ ...props.dashboard, look });
                    if (askDockWithPrompt(request, "inline-card")) return;
                    void startTurn({ kind: "build", request, form, look: look?.name ?? null });
                  }}
                />
              </div>
            ) : runtime.status !== "ready" ? (
              <div
                role="status"
                data-testid="dashboard-shimmer"
                className="absolute inset-0 flex flex-col gap-4 overflow-hidden bg-background p-6"
              >
                <div className="grid grid-cols-3 gap-3">
                  <div className="h-20 animate-pulse rounded-card border border-border/60 bg-muted/60" />
                  <div className="h-20 animate-pulse rounded-card border border-border/60 bg-muted/60" />
                  <div className="h-20 animate-pulse rounded-card border border-border/60 bg-muted/60" />
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
                  <div className="animate-pulse rounded-card border border-border/60 bg-muted/50" />
                  <div className="animate-pulse rounded-card border border-border/60 bg-muted/50" />
                </div>
                <p className="text-center text-ui-sm text-muted-foreground">
                  {runtime.status === "timeout"
                    ? copy.frameTimeout
                    : working
                      ? copy.mossUpdating
                      : copy.loading}
                </p>
              </div>
            ) : working || loading ? (
              <div
                role="status"
                data-testid="dashboard-shimmer"
                className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4"
              >
                <div className="flex justify-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--primary)_10%,var(--background))] px-3 py-1 text-ui-xs font-medium text-[var(--primary)] shadow-sm backdrop-blur-sm">
                    <SparklesIcon className="size-3.5 animate-pulse" aria-hidden />
                    <span>{working ? copy.mossUpdating : copy.loading}</span>
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3 opacity-40">
                  <div className="h-14 animate-pulse rounded-card border border-border/60 bg-muted/60" />
                  <div className="h-14 animate-pulse rounded-card border border-border/60 bg-muted/60" />
                  <div className="h-14 animate-pulse rounded-card border border-border/60 bg-muted/60" />
                </div>
              </div>
            ) : null}
            <div
              className="pointer-events-none absolute inset-0 overflow-hidden"
              data-testid="dashboard-comment-layer"
            >
              {pins.map(({ comment, pin }) => (
                <CommentPin
                  key={comment.id}
                  comment={comment}
                  left={pin.left}
                  top={pin.top}
                  side={pin.side}
                  open={openThread === comment.id}
                  pulse={false}
                  onOpen={() => {
                    setOpenThread(comment.id);
                    usePageCommentsStore.getState().markPageRead(commentsKey);
                  }}
                />
              ))}
              {opened ? (
                <ThreadCard
                  comment={opened.comment}
                  position={placePageCommentCard(opened.pin, stageSize)}
                  pulse={false}
                  author={me}
                  onReply={(body) =>
                    postDeckComment({
                      pageKey: commentsKey,
                      author: me,
                      threadId: opened.comment.id,
                      anchor: null,
                      label: opened.comment.anchor.label,
                      body,
                      sendToAgent: canAsk && /@moss/iu.test(body),
                      ask: askFromComment,
                    })
                  }
                  onDelete={() => {
                    usePageCommentsStore.getState().deleteComment(commentsKey, opened.comment.id);
                    setOpenThread(null);
                  }}
                  onClose={() => setOpenThread(null)}
                />
              ) : null}
              {newAnchor ? (
                <NewCommentCard
                  threadId={page.sourceThreadId ?? ""}
                  pageTitle={props.title}
                  anchor={{ selector: `page/${newAnchor.id}`, label: newAnchor.label, text: "" }}
                  position={placePageCommentCard(
                    placePageCommentPin(
                      {
                        x: newAnchor.rect.left,
                        y: newAnchor.rect.top,
                        width: newAnchor.rect.width,
                        height: newAnchor.rect.height,
                      },
                      1,
                      stageSize,
                    ) ?? { left: 16, top: 16 },
                    stageSize,
                  )}
                  onPost={(body, sendToAgent) => {
                    postDeckComment({
                      pageKey: commentsKey,
                      author: me,
                      threadId: null,
                      anchor: { slideId: "page", elementId: newAnchor.id },
                      label: newAnchor.label,
                      body,
                      sendToAgent: sendToAgent && canAsk,
                      ask: askFromComment,
                    });
                    runtime.clearAnchor();
                  }}
                  onCancel={() => runtime.clearAnchor()}
                />
              ) : null}
            </div>
            {hasPage && !readOnly && !editing ? (
              <div
                className="pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-2 px-3"
                style={{ bottom: Math.max(12, bottomInsetPx + 12) }}
                data-testid="dashboard-ask"
              >
                {!dock && askOpen ? (
                  <form
                    className="pointer-events-auto flex w-full max-w-[440px] items-end gap-1.5 rounded-composer border border-border bg-popover/95 py-1.5 pr-1.5 pl-3 shadow-lg backdrop-blur-sm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      sendAsk();
                    }}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      {runtime.selection ? (
                        <span className="truncate text-ui-xs text-muted-foreground">
                          {copy.askSelected(runtime.selection.text.slice(0, 60))}
                        </span>
                      ) : null}
                      <textarea
                        aria-label={copy.askPlaceholder}
                        value={ask}
                        rows={1}
                        autoFocus
                        placeholder={canAsk ? copy.askPlaceholder : copy.noAgent}
                        style={{ fontFamily: "var(--font-ui-family)" }}
                        disabled={!canAsk}
                        onChange={(event) => setAsk(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !isImeComposingKeyEvent(event)
                          ) {
                            event.preventDefault();
                            sendAsk();
                          }
                        }}
                        className="max-h-28 min-h-7 resize-none bg-transparent py-1 text-ui text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground/70"
                      />
                    </div>
                    <Button
                      type="submit"
                      size="icon-sm"
                      className="rounded-full"
                      aria-label={copy.send}
                      disabled={!ask.trim() || !canAsk}
                      data-testid="dashboard-ask-send"
                    >
                      <ArrowUpIcon className="size-4" aria-hidden />
                    </Button>
                  </form>
                ) : null}
                <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover/95 px-2 py-1 shadow-md backdrop-blur-sm">
                  {undoSnapshot ? (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="gap-1 rounded-full text-ui-xs text-[var(--primary)]"
                        data-testid="dashboard-undo-moss"
                        onClick={handleUndoMoss}
                      >
                        <Undo2Icon className="size-3.5" aria-hidden />
                        <span>{copy.undoMossEdit}</span>
                      </Button>
                      <SpaceToolbarDivider />
                    </>
                  ) : null}
                  {runtime.selection ? (
                    <span className="max-w-44 truncate px-1.5 text-ui-xs text-muted-foreground">
                      {copy.askSelected(runtime.selection.text.slice(0, 40))}
                    </span>
                  ) : null}
                  {dock ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="gap-1 rounded-full px-2.5 text-ui-sm font-medium"
                      disabled={!canAsk}
                      data-testid="dashboard-ask-trigger"
                      onClick={() => setAskOpen((prev) => !prev)}
                    >
                      <SparklesIcon className="size-3.5 text-[var(--primary)]" aria-hidden />
                      <span>{copy.askMoss}</span>
                    </Button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {panel ? (
          <SpaceSidePanel
            title={
              panel === "sources" ? copy.sources : panel === "design" ? copy.design : copy.history
            }
            onClose={() => setPanel(null)}
            closeLabel={copy.close}
            testId={`dashboard-panel-${panel}`}
          >
            {panel === "sources" ? (
              <DashboardSourcesPanel
                copy={copy}
                locale={locale}
                dashboard={shown}
                sources={runtime.sources}
                calcs={runtime.calcs}
                loaders={runtime.loaders}
                used={runtime.used}
                selected={selected}
                pick={runtime.pick}
                params={runtime.params}
                readOnly={readOnly}
                onSelect={(id) => {
                  setSelected(id);
                  runtime.clearPick();
                  runtime.send({ kind: "light", source: id });
                }}
                onUpdates={(updates) =>
                  props.onChange({
                    ...props.dashboard,
                    settings: { ...props.dashboard.settings, updates },
                  })
                }
                onSaveDataset={saveDataset}
                onTest={testDataset}
                onAskFix={(id, message) => {
                  if (
                    askDockWithPrompt(`${copy.askFix}：datasets/${id} (${message})`, "inline-card")
                  )
                    return;
                  void startTurn({
                    kind: "fix",
                    request: copy.askFix,
                    source: id,
                    faults: [{ where: `datasets/${id}`, message }],
                  });
                }}
              />
            ) : panel === "design" ? (
              <DashboardDesignPanel
                copy={copy}
                look={shown.look}
                mode={theme}
                shape={shown.meta.shape}
                readOnly={readOnly}
                canAsk={canAsk}
                onLook={(look: DashboardLook | null) => {
                  // Picking a look takes the dashboard out of its design system.
                  const { look: _old, system: _system, ...rest } = props.dashboard;
                  props.onChange(look ? { ...rest, look } : rest);
                }}
                onRemake={(form: DashboardForm) => {
                  if (askDockWithPrompt(`${copy.remake}：${copy.forms[form]}`, "inline-card"))
                    return;
                  props.onChange({
                    ...props.dashboard,
                    draft: { shape: form, at: new Date().toISOString(), files: {}, datasets: {} },
                  });
                  void startTurn({
                    kind: "reshape",
                    request: `${copy.remake}：${copy.forms[form]}`,
                    form,
                  });
                }}
                draftOpen={Boolean(draft)}
                system={shown.system}
                scopeSpaceId={props.scopeSpaceId}
                account={props.account}
                onSystem={(system) => {
                  setStyle(null);
                  props.onChange(
                    applyDashboardSystem(props.dashboard, system, DASHBOARD_STANDARD_LOOK),
                  );
                }}
                style={style ? { look: style.look, undo: style.history.length } : null}
                onTweak={(look) =>
                  setStyle((current) => ({
                    look,
                    history: [
                      ...(current?.history ?? []),
                      current?.look ?? props.dashboard.look ?? DASHBOARD_STANDARD_LOOK,
                    ].slice(-50),
                  }))
                }
                onStyleUndo={() =>
                  setStyle((current) => {
                    if (!current || current.history.length === 0) return current;
                    const history = current.history.slice(0, -1);
                    return { look: current.history[current.history.length - 1]!, history };
                  })
                }
                onStyleCancel={() => setStyle(null)}
                onStyleSave={() => {
                  if (!style) return;
                  props.onChange({ ...props.dashboard, look: style.look });
                  setStyle(null);
                }}
              />
            ) : (
              <DashboardHistoryPanel
                copy={copy}
                locale={locale}
                account={props.account}
                scopeSpaceId={props.scopeSpaceId}
                pageId={page.id}
                revision={page.revision}
                viewing={viewing?.revision ?? null}
                readOnly={props.readOnly}
                onView={(revision) => void viewRevision(revision)}
                onRestore={restore}
                diff={viewing ? diffDashboards(props.dashboard, viewing.dashboard) : null}
              />
            )}
          </SpaceSidePanel>
        ) : null}
      </div>
      {runs.map((run) =>
        run.threadId ? <RunWatcher key={run.id} run={run} onDone={endRun} /> : null,
      )}
      <DeckCommentAgentReplies pageKey={commentsKey} comments={comments} />
    </div>
  );
}
