// FILE: SpaceCanvasChatDock.tsx
// Purpose: Single-instance non-unmounting Portal canvas-chat companion dock across all 7 Space
//          artifact types (`page`, `slides`, `sheet`, `design`, `dashboard`, `board`, `app`).
//          Transitions cleanly between `collapsed` (compact 1000ms tabular-nums bar),
//          `pip` (560x640 draggable/resizable floating card with 32x184 right-edge snap SVG),
//          and `docked` (RightDock containerMode="parent" split pane with <320px auto-collapse
//          and 300ms tab close-lock + opt-out confirmation).
// Layer: Space workspace UI (space-dock-chrome slice)

import { type SpaceId, type ThreadId } from "@moss/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useHandleNewThread, type SpaceArtifactAssistantTarget } from "~/hooks/useHandleNewThread";
import { createPastedTextDraft } from "~/lib/composerPastedText";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LayoutRightIcon,
  Maximize2,
  MoreHorizontalIcon,
  PlusIcon,
  PopOutIcon,
  RotateCcwIcon,
  SidechatIcon,
  SparklesIcon,
  StopFilledIcon,
  XIcon,
} from "~/lib/icons";
import { artifactAssistantThreadKey, pageAssistantThreads } from "~/lib/pageAi/pageAssistantThread";
import { cn } from "~/lib/utils";
import { readDesktopBackendWsUrl } from "~/lib/transportLink";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

function readStartupBearerHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = readDesktopBackendWsUrl() ?? (import.meta.env.VITE_WS_URL as string | undefined);
  if (!raw) return {};
  try {
    const token = new URL(raw).searchParams.get("token");
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
import { createDefaultRightDockState, type RightDockPane } from "~/rightDockStore.logic";
import { useStore } from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "../chat/chatHeaderControls";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { RightDock } from "../chat/RightDock";
import { SidechatDockPane } from "../chat/SidechatDockPane";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import {
  SPACE_DOCK_PERSIST_KEYS,
  type SpaceArtifactKind,
  type SpaceCanvasDockController,
  type SpaceCanvasDockRequest,
  type SpaceCanvasDockState,
  type SpaceCanvasHostInsets,
  type SpaceCanvasSelectionContext,
} from "./spaceCanvasDockContract";
import {
  SPACE_DOCK_DEFAULT_TOP_INSET_PX,
  SPACE_DOCK_RIGHT_COLLAPSE_THRESHOLD_PX,
  SPACE_DOCK_TAB_CLOSE_LOCK_MS,
  type SpaceDockFailureRecovery,
  type SpaceDockPipRect,
  type SpaceDockPipResizeEdge,
  applySpaceDockPipResize,
  areSpaceDockSelectionsEqual,
  buildSpaceDockCompanionContext,
  clampSpaceDockPipRect,
  computeSpaceDockHostInsets,
  formatSpaceDockElapsedLabel,
  formatSpaceDockSelectionSummary,
  formatSpaceDockTimerBadge,
  isNearSpaceDockRightSnapZone,
  readPersistedSpaceDockMode,
  readPersistedSpaceDockPipSize,
  readSkipSidechatCloseConfirmation,
  readSpaceDockRecentThreads,
  recordSpaceDockRecentThread,
  spaceArtifactKindLabel,
  writePersistedSpaceDockMode,
  writePersistedSpaceDockPipSize,
  writeSkipSidechatCloseConfirmation,
} from "./SpaceCanvasChatDock.logic";

export interface SpaceCanvasActiveArtifact {
  readonly kind: SpaceArtifactKind;
  readonly itemId: string;
  readonly title: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly account: string;
  readonly sourceThreadId?: string | null;
  readonly revision?: number | null;
}

interface ExtraSidechatTab {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly title: string;
}

const PRIMARY_PANE_ID = "space-primary";
const PINNED_PRIMARY_PANE_IDS = new Set([PRIMARY_PANE_ID]);
const RIGHT_DOCK_ADD_MENU_KINDS: readonly [] = [];
const EMPTY_EXTRA_TABS: readonly ExtraSidechatTab[] = [];

function makeSidechatDockPane(id: string, threadId: ThreadId | null): RightDockPane {
  return {
    id,
    kind: "sidechat",
    threadId,
    diffTurnId: null,
    diffFilePath: null,
    filePath: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    pullRequestNumber: null,
    pullRequestInitialTab: null,
  };
}

function shouldSkipResizeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, [role='button'], [role='menuitem'], a, input, textarea"));
}

function captureScrollPositions(
  root: HTMLElement,
): Array<{ element: Element; top: number; left: number }> {
  const saved: Array<{ element: Element; top: number; left: number }> = [];
  const scrollers = root.querySelectorAll("[data-scroll-container], [class*='overflow-y-auto']");
  scrollers.forEach((element) => {
    if (element.scrollTop > 0 || element.scrollLeft > 0) {
      saved.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
  });
  return saved;
}

function TemporarySidechatDockPane(props: {
  readonly pane: RightDockPane;
  readonly runtimeMode: "live" | "preview";
  readonly isFocusedPane: boolean;
}) {
  const threadId = props.pane.threadId;
  const summaryExists = useStore((store) =>
    threadId ? Boolean(store.sidebarThreadSummaryById[threadId]) : false,
  );
  const shellExists = useStore((store) =>
    threadId ? Boolean(store.threadShellById?.[threadId]) : false,
  );
  const draftExists = useComposerDraftStore((store) =>
    threadId ? Boolean(store.draftThreadsByThreadId[threadId]) : false,
  );
  return (
    <SidechatDockPane
      pane={props.pane}
      runtimeMode={props.runtimeMode}
      threadExists={summaryExists || shellExists || draftExists}
      isFocusedPane={props.isFocusedPane}
    />
  );
}

function RightEdgeSnapIndicator() {
  return (
    <div
      data-floating-chat-drop-indicator="right-pane"
      className="pointer-events-none absolute inset-y-4 right-3 z-50 flex items-center text-primary transition-opacity duration-150"
      aria-hidden="true"
    >
      <div className="flex items-center justify-center rounded-card border border-border bg-popover/90 px-1.5 py-2 shadow-xl">
        <svg viewBox="0 0 32 184" width={32} height={184} fill="none">
          <rect
            x="4"
            y="4"
            width="24"
            height="176"
            rx="10"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="2"
            strokeDasharray="6 4"
            fill="currentColor"
            fillOpacity="0.12"
          />
          <rect x="13" y="64" width="6" height="56" rx="3" fill="currentColor" fillOpacity="0.72" />
        </svg>
      </div>
    </div>
  );
}

function PipStarterSurface(props: {
  readonly artifact: SpaceCanvasActiveArtifact;
  readonly selectionSummary: string | null;
  readonly initialPrompt: string;
  readonly submitting: boolean;
  readonly onSubmitPrompt: (prompt: string) => void;
}) {
  const [draft, setDraft] = useState(props.initialPrompt);
  useEffect(() => {
    if (props.initialPrompt) {
      setDraft(props.initialPrompt);
    }
  }, [props.initialPrompt]);

  const handleSubmit = () => {
    const trimmed = draft.trim();
    if (!trimmed || props.submitting) return;
    setDraft("");
    props.onSubmitPrompt(trimmed);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col justify-between bg-background p-4">
      <div className="flex flex-col gap-2 pt-4">
        <div className="flex items-center gap-2 text-ui font-medium text-foreground">
          <SparklesIcon className="size-4 text-primary" aria-hidden />
          <span>关于「{props.artifact.title}」问 Moss</span>
        </div>
        <p className="text-ui-sm text-muted-foreground">
          {spaceArtifactKindLabel(props.artifact.kind)}上下文已就绪，对话不会离开当前画布。
        </p>
        {props.selectionSummary ? (
          <div className="rounded-control border border-border bg-muted/50 px-2.5 py-1.5 text-ui-xs text-muted-foreground">
            已附带选区：{props.selectionSummary}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 shadow-xs">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposingKeyEvent(event)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          rows={3}
          placeholder={`就当前${spaceArtifactKindLabel(props.artifact.kind)}输入问题或修改要求…`}
          aria-label="向 Moss 提问"
          className="w-full resize-none bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            size="xs"
            variant="default"
            disabled={!draft.trim() || props.submitting}
            onClick={handleSubmit}
          >
            {props.submitting ? "发送中…" : "发送"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SpaceCanvasChatDockHost(props: {
  readonly artifact: SpaceCanvasActiveArtifact | null;
  readonly containerRef: { readonly current: HTMLElement | null };
  readonly topBarHeightPx?: number;
  readonly keepItemOpen?: boolean;
  readonly children: (dock: SpaceCanvasDockController) => ReactNode;
}) {
  const artifact = props.artifact;
  const artifactRef = useRef(artifact);
  artifactRef.current = artifact;
  const navigate = useNavigate();
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const fetchedAssistantThreadKeysRef = useRef(new Set<string>());
  const autoPreparedKeysRef = useRef(new Set<string>());
  const inFlightPrepareRef = useRef(new Map<string, Promise<ThreadId | null>>());
  const openChatThreadPage = useTerminalStateStore((store) => store.openChatThreadPage);

  const [dockState, setDockStateRaw] = useState<SpaceCanvasDockState>(() =>
    readPersistedSpaceDockMode(),
  );
  const [selection, setSelectionRaw] = useState<SpaceCanvasSelectionContext | null>(null);
  const selectionRef = useRef<SpaceCanvasSelectionContext | null>(null);
  selectionRef.current = selection;
  const setSelection = useCallback((next: SpaceCanvasSelectionContext | null) => {
    setSelectionRaw((prev) => (areSpaceDockSelectionsEqual(prev, next) ? prev : next));
  }, []);
  const [pipSize, setPipSize] = useState(() => readPersistedSpaceDockPipSize());
  const [pipPosition, setPipPosition] = useState<{ left: number; top: number } | null>(null);
  const [containerBounds, setContainerBounds] = useState({ width: 1200, height: 800 });
  const [dockedWidthPx, setDockedWidthPx] = useState(420);
  const [rightSnapActive, setRightSnapActive] = useState(false);

  const [boundThreadsByKey, setBoundThreadsByKey] = useState<Readonly<Record<string, ThreadId>>>(
    {},
  );
  const [extraSidechatTabsByKey, setExtraSidechatTabsByKey] = useState<
    Readonly<Record<string, readonly ExtraSidechatTab[]>>
  >({});
  const [activeTabIdByKey, setActiveTabIdByKey] = useState<Readonly<Record<string, string>>>({});
  const [lastPromptSnippet, setLastPromptSnippet] = useState<string | null>(null);
  const [prefillPrompt, setPrefillPrompt] = useState("");
  const [askSubmitting, setAskSubmitting] = useState(false);
  const [failureRecovery, setFailureRecovery] = useState<SpaceDockFailureRecovery | null>(null);
  const [hasUnreadDot, setHasUnreadDot] = useState(false);
  const [closeConfirmState, setCloseConfirmState] = useState<{
    paneId: string;
    threadId: ThreadId;
    title: string;
  } | null>(null);
  const [closeConfirmDontAsk, setCloseConfirmDontAsk] = useState(false);

  // Elapsed timer tracking for active turn (`1000ms` `tabular-nums` `"已处理 {n}秒"` / `"已完成"`).
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const runStartMsRef = useRef<number | null>(null);
  const wasBusyRef = useRef(false);

  // Single-instance Portal container DOM node: never unmounted when switching collapsed <-> pip <-> docked.
  const [portalHostEl] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.className = "flex h-full min-h-0 min-w-0 flex-1 flex-col";
    element.dataset.spaceCanvasPortalHost = "true";
    return element;
  });
  const [parkedSlotEl, setParkedSlotEl] = useState<HTMLDivElement | null>(null);
  const [pipSlotEl, setPipSlotEl] = useState<HTMLDivElement | null>(null);
  const [dockedSlotEl, setDockedSlotEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      portalHostEl?.remove();
    };
  }, [portalHostEl]);

  const artifactKey = useMemo(
    () =>
      artifact
        ? artifactAssistantThreadKey(
            artifact.account,
            artifact.scopeSpaceId,
            artifact.kind,
            artifact.itemId,
          )
        : null,
    [artifact],
  );
  const artifactKeyRef = useRef(artifactKey);
  artifactKeyRef.current = artifactKey;

  const isCurrentArtifact = useCallback(
    () => artifactKey !== null && artifactKeyRef.current === artifactKey,
    [artifactKey],
  );

  const prevArtifactKeyRef = useRef(artifactKey);
  // Clear selection/failure when switching artifacts cleanly while keeping mounted portal intact.
  useEffect(() => {
    if (prevArtifactKeyRef.current === artifactKey) return;
    prevArtifactKeyRef.current = artifactKey;
    setSelectionRaw((prev) =>
      prev &&
      artifactRef.current &&
      prev.kind === artifactRef.current.kind &&
      prev.itemId === artifactRef.current.itemId
        ? prev
        : null,
    );
    setFailureRecovery(null);
    setPrefillPrompt("");
    setHasUnreadDot(false);
    runStartMsRef.current = null;
    wasBusyRef.current = false;
    setElapsedSeconds(0);
  }, [artifactKey]);

  const primaryThreadId = useMemo<ThreadId | null>(() => {
    if (!artifact || !artifactKey) return null;
    const explicit = boundThreadsByKey[artifactKey];
    if (explicit) return explicit;
    return threadsRef.current.resolveExistingArtifactThread(
      {
        kind: artifact.kind,
        itemId: artifact.itemId,
        title: artifact.title,
        scopeSpaceId: artifact.scopeSpaceId,
        sourceThreadId: artifact.sourceThreadId,
        revision: artifact.revision,
      },
      artifactKey,
    );
  }, [artifact, artifactKey, boundThreadsByKey, threads.projects]);

  // Best-effort sync of per-item default assistant thread with server (#159 / #161), falling back gracefully.
  useEffect(() => {
    const currentArtifact = artifactRef.current;
    if (!currentArtifact || !artifactKey || primaryThreadId || typeof window === "undefined")
      return;
    if (fetchedAssistantThreadKeysRef.current.has(artifactKey)) return;
    fetchedAssistantThreadKeysRef.current.add(artifactKey);
    let cancelled = false;
    const targetKey = artifactKey;
    const targetItemId = currentArtifact.itemId;
    const scopeSpaceId = currentArtifact.scopeSpaceId;
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (scopeSpaceId !== null) params.set("scopeSpaceId", scopeSpaceId);
        const query = params.toString();
        const url = resolveWsHttpUrl(
          `/api/moss/pages/${encodeURIComponent(targetItemId)}/assistant-thread${query ? `?${query}` : ""}`,
          { includeLegacyToken: false },
        );
        const res = await fetch(url, {
          credentials: "include",
          headers: readStartupBearerHeaders(),
        });
        if (!res.ok || cancelled || artifactKeyRef.current !== targetKey) return;
        const payload = (await res.json()) as { defaultAssistantThreadId?: string | null };
        const serverThreadId = payload.defaultAssistantThreadId as ThreadId | undefined;
        if (!serverThreadId) return;
        const matched = threadsRef.current.resolveExistingArtifactThread(
          {
            kind: currentArtifact.kind,
            itemId: currentArtifact.itemId,
            title: currentArtifact.title,
            scopeSpaceId: currentArtifact.scopeSpaceId,
            sourceThreadId: serverThreadId,
          },
          targetKey,
        );
        if (matched && !cancelled && artifactKeyRef.current === targetKey) {
          pageAssistantThreads.set(targetKey, matched);
          setBoundThreadsByKey((prev) =>
            prev[targetKey] === matched ? prev : { ...prev, [targetKey]: matched },
          );
        }
      } catch {
        // Endpoint may not exist on older server builds; local LRU stays authoritative.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactKey, primaryThreadId]);

  const persistPrimaryBinding = useCallback(
    (
      key: string,
      currentArtifact: SpaceCanvasActiveArtifact,
      threadId: ThreadId,
      force = false,
    ) => {
      pageAssistantThreads.set(key, threadId);
      setBoundThreadsByKey((prev) =>
        prev[key] === threadId ? prev : { ...prev, [key]: threadId },
      );
      recordSpaceDockRecentThread({
        threadId,
        title: currentArtifact.title,
        artifactKey: key,
        kind: currentArtifact.kind,
        itemId: currentArtifact.itemId,
        scopeSpaceId: currentArtifact.scopeSpaceId,
        updatedAt: Date.now(),
      });
      if (typeof window !== "undefined") {
        void (async () => {
          try {
            const url = resolveWsHttpUrl(
              `/api/moss/pages/${encodeURIComponent(currentArtifact.itemId)}/assistant-thread`,
              { includeLegacyToken: false },
            );
            await fetch(url, {
              method: "PUT",
              credentials: "include",
              headers: {
                "content-type": "application/json",
                ...readStartupBearerHeaders(),
              },
              body: JSON.stringify({
                scopeSpaceId: currentArtifact.scopeSpaceId,
                threadId,
                ifUnset: !force,
              }),
            });
          } catch {
            // Optional server persistence only.
          }
        })();
      }
    },
    [],
  );

  const extraTabs = useMemo(
    () =>
      artifactKey ? (extraSidechatTabsByKey[artifactKey] ?? EMPTY_EXTRA_TABS) : EMPTY_EXTRA_TABS,
    [artifactKey, extraSidechatTabsByKey],
  );
  // The panel's conversations render a full ChatView, which shows a conversation only once its
  // detail has synced; that needs a detail lease, as split-view and right-dock panes hold.
  // Without one the panel sat on 「正在加载对话」 for good.
  const leasedThreadIds = useMemo(
    () =>
      [primaryThreadId, ...(dockState === "docked" ? extraTabs.map((tab) => tab.threadId) : [])]
        .filter((id): id is ThreadId => id !== null)
        .join(","),
    [dockState, extraTabs, primaryThreadId],
  );
  useEffect(() => {
    if (!leasedThreadIds) return;
    const releases = leasedThreadIds
      .split(",")
      .map((id) => retainThreadDetailSubscription(id as ThreadId));
    return () => releases.forEach((release) => release());
  }, [leasedThreadIds]);
  const activeTabId =
    artifactKey && activeTabIdByKey[artifactKey] ? activeTabIdByKey[artifactKey]! : PRIMARY_PANE_ID;
  const activeTabThreadId: ThreadId | null =
    activeTabId === PRIMARY_PANE_ID
      ? primaryThreadId
      : (extraTabs.find((tab) => tab.id === activeTabId)?.threadId ?? primaryThreadId);

  const threadSummary = useStore((store) =>
    activeTabThreadId ? store.sidebarThreadSummaryById[activeTabThreadId] : undefined,
  );
  const primaryThreadSummary = useStore((store) =>
    primaryThreadId ? store.sidebarThreadSummaryById[primaryThreadId] : undefined,
  );
  const primaryThreadShell = useStore((store) =>
    primaryThreadId ? store.threadShellById?.[primaryThreadId] : undefined,
  );
  const primaryHasDraft = useComposerDraftStore((store) =>
    primaryThreadId ? Boolean(store.draftThreadsByThreadId[primaryThreadId]) : false,
  );

  const liveThreadBusy = Boolean(
    threadSummary &&
    !threadSummary.archivedAt &&
    (threadSummary.session?.status === "running" ||
      threadSummary.session?.activeTurnId != null ||
      threadSummary.latestTurn?.state === "running"),
  );
  const busy = askSubmitting || liveThreadBusy;

  useEffect(() => {
    if (busy) {
      if (!wasBusyRef.current) {
        runStartMsRef.current = Date.now();
        setElapsedSeconds(0);
        wasBusyRef.current = true;
      }
      const interval = window.setInterval(() => {
        if (runStartMsRef.current !== null) {
          setElapsedSeconds(Math.max(0, Math.floor((Date.now() - runStartMsRef.current) / 1000)));
        }
      }, 1000);
      return () => window.clearInterval(interval);
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false;
      const finalElapsed =
        runStartMsRef.current !== null
          ? Math.max(1, Math.floor((Date.now() - runStartMsRef.current) / 1000))
          : 1;
      setElapsedSeconds(finalElapsed);
      if (dockState === "collapsed") {
        setHasUnreadDot(true);
      }
    }
    return undefined;
  }, [busy, dockState]);

  const setState = useCallback((next: SpaceCanvasDockState) => {
    setDockStateRaw(next);
    writePersistedSpaceDockMode(next);
    if (next !== "collapsed") {
      setHasUnreadDot(false);
    }
  }, []);

  // Esc closes the floating panel, as it closes any popover, when the key is not someone else's:
  // focus is in the panel, on the 问 Moss toggle, or nowhere in particular.
  useEffect(() => {
    if (dockState !== "pip") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeComposingKeyEvent(event)) return;
      const active = document.activeElement as HTMLElement | null;
      const pip = pipSlotEl?.closest("[data-space-canvas-dock='pip']");
      const ours =
        !active ||
        active === document.body ||
        Boolean(pip?.contains(active)) ||
        active.closest("[data-space-dock-toggle], [data-page-dock-toggle]") !== null;
      if (!ours) return;
      event.preventDefault();
      setState("collapsed");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dockState, pipSlotEl, setState]);

  // Measure workspace container bounds for clamping PiP cleanly inside workspace.
  useEffect(() => {
    const element = props.containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      if (typeof window !== "undefined") {
        const width = window.innerWidth;
        const height = window.innerHeight;
        setContainerBounds((prev) =>
          prev.width === width && prev.height === height ? prev : { width, height },
        );
      }
      return;
    }
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        setContainerBounds((prev) =>
          prev.width === width && prev.height === height ? prev : { width, height },
        );
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.containerRef]);

  const topInsetPx = props.topBarHeightPx ?? SPACE_DOCK_DEFAULT_TOP_INSET_PX;
  const pipRect = useMemo<SpaceDockPipRect>(
    () =>
      clampSpaceDockPipRect(
        {
          ...(pipPosition ? { left: pipPosition.left, top: pipPosition.top } : {}),
          width: pipSize.width,
          height: pipSize.height,
        },
        {
          width: containerBounds.width,
          height: containerBounds.height,
          topInsetPx,
          bottomInsetPx: artifact?.kind === "page" ? 72 : 16,
        },
      ),
    [
      artifact?.kind,
      containerBounds.height,
      containerBounds.width,
      pipPosition,
      pipSize.height,
      pipSize.width,
      topInsetPx,
    ],
  );

  // Move the single persistent portalHostEl between parked <-> pip <-> docked without unmounting React subtree!
  useLayoutEffect(() => {
    if (!portalHostEl) return;
    const targetSlot =
      dockState === "pip"
        ? pipSlotEl
        : dockState === "docked" && activeTabId === PRIMARY_PANE_ID
          ? dockedSlotEl
          : parkedSlotEl;
    if (!targetSlot || portalHostEl.parentElement === targetSlot) return;
    const scrollSnapshot = captureScrollPositions(portalHostEl);
    targetSlot.appendChild(portalHostEl);
    for (const item of scrollSnapshot) {
      item.element.scrollTop = item.top;
      item.element.scrollLeft = item.left;
    }
  }, [activeTabId, dockState, dockedSlotEl, parkedSlotEl, pipSlotEl, portalHostEl]);

  // A closed panel leaves nothing behind unless there is something to report: Moss is working,
  // a request failed, or an answer came while the panel was closed.
  const showCollapsedPill = useMemo(() => {
    if (!artifact || dockState !== "collapsed") return false;
    return busy || failureRecovery !== null || hasUnreadDot;
  }, [artifact, busy, dockState, failureRecovery, hasUnreadDot]);

  // Host insets listeners (Canvas/Docs/Sheets/Design bottom pills stay clear of the Dock).
  const insetListenersRef = useRef(new Set<(insets: SpaceCanvasHostInsets) => void>());
  const rawHostInsets = computeSpaceDockHostInsets({
    state: dockState,
    showCollapsedPill,
    pipRect,
    containerWidthPx: containerBounds.width,
    dockedWidthPx,
  });
  const hostInsets = useMemo<SpaceCanvasHostInsets>(
    () => ({
      bottomInsetPx: rawHostInsets.bottomInsetPx,
      rightInsetPx: rawHostInsets.rightInsetPx,
    }),
    [rawHostInsets.bottomInsetPx, rawHostInsets.rightInsetPx],
  );
  const hostInsetsRef = useRef(hostInsets);
  hostInsetsRef.current = hostInsets;
  const lastNotifiedInsetsRef = useRef<SpaceCanvasHostInsets>(hostInsets);

  useEffect(() => {
    const prev = lastNotifiedInsetsRef.current;
    if (
      prev.bottomInsetPx === hostInsets.bottomInsetPx &&
      prev.rightInsetPx === hostInsets.rightInsetPx
    ) {
      return;
    }
    lastNotifiedInsetsRef.current = hostInsets;
    insetListenersRef.current.forEach((listener) => listener(hostInsets));
  }, [hostInsets]);

  const registerHostInsets = useCallback((listener: (insets: SpaceCanvasHostInsets) => void) => {
    insetListenersRef.current.add(listener);
    listener(hostInsetsRef.current);
    return () => {
      insetListenersRef.current.delete(listener);
    };
  }, []);

  const ensurePrimaryThread = useCallback(
    async (currentArtifact: SpaceCanvasActiveArtifact, key: string): Promise<ThreadId | null> => {
      const target: SpaceArtifactAssistantTarget = {
        kind: currentArtifact.kind,
        itemId: currentArtifact.itemId,
        title: currentArtifact.title,
        scopeSpaceId: currentArtifact.scopeSpaceId,
        sourceThreadId: currentArtifact.sourceThreadId,
        revision: currentArtifact.revision,
      };
      const existing = threadsRef.current.resolveExistingArtifactThread(target, key);
      if (existing) {
        persistPrimaryBinding(key, currentArtifact, existing);
        return existing;
      }
      const inFlight = inFlightPrepareRef.current.get(key);
      if (inFlight) return inFlight;

      const flight = (async () => {
        const created = await threadsRef.current.prepareArtifactAssistant(
          target,
          () => artifactKeyRef.current === key,
          { key, title: currentArtifact.title },
        );
        if (created) {
          persistPrimaryBinding(key, currentArtifact, created);
        }
        return created;
      })();
      inFlightPrepareRef.current.set(key, flight);
      try {
        return await flight;
      } finally {
        if (inFlightPrepareRef.current.get(key) === flight) {
          inFlightPrepareRef.current.delete(key);
        }
      }
    },
    [persistPrimaryBinding],
  );

  // Prepare the primary companion thread immediately whenever PiP/Docked is open so the real
  // ChatView composer & history appear inside the single Portal right away.
  useEffect(() => {
    if (!artifact || !artifactKey || dockState === "collapsed" || primaryThreadId) return;
    if (autoPreparedKeysRef.current.has(artifactKey)) return;
    autoPreparedKeysRef.current.add(artifactKey);
    void ensurePrimaryThread(artifact, artifactKey);
  }, [artifact, artifactKey, dockState, ensurePrimaryThread, primaryThreadId]);

  const ask = useCallback(
    async (request?: SpaceCanvasDockRequest) => {
      if (!artifact || !artifactKey) return;
      const effectiveSelection = request?.selection ?? selectionRef.current;
      if (request?.selection) {
        setSelection(request.selection);
      }
      setFailureRecovery(null);

      // Reveal PiP when currently collapsed unless caller explicitly picked a mode.
      const nextState: SpaceCanvasDockState =
        request?.preferredState ?? (dockState === "collapsed" ? "pip" : dockState);
      setState(nextState);
      if (artifactKey) {
        setActiveTabIdByKey((prev) => ({ ...prev, [artifactKey]: PRIMARY_PANE_ID }));
      }

      const rawPrompt = request?.prompt?.trim() ?? "";
      if (rawPrompt) {
        setLastPromptSnippet(rawPrompt);
      }

      const target: SpaceArtifactAssistantTarget = {
        kind: artifact.kind,
        itemId: artifact.itemId,
        title: artifact.title,
        scopeSpaceId: artifact.scopeSpaceId,
        sourceThreadId: artifact.sourceThreadId,
        revision: artifact.revision,
      };

      // Prefill-only or empty focus-ask opens the dock cleanly without spending a model turn.
      if (!rawPrompt || request?.prefillOnly) {
        if (rawPrompt) {
          setPrefillPrompt(rawPrompt);
        }
        const preparedId = await ensurePrimaryThread(artifact, artifactKey);
        if (preparedId && rawPrompt) {
          useComposerDraftStore.getState().setPrompt(preparedId, rawPrompt);
        }
        return;
      }

      const agentReady = threadsRef.current.describeArtifactAgent(target);
      if (!agentReady) {
        // Fallback when no AI lane is configured/ready: prefill prompt + non-destructive notice.
        setPrefillPrompt(rawPrompt);
        const preparedId = await ensurePrimaryThread(artifact, artifactKey);
        if (preparedId) {
          useComposerDraftStore.getState().setPrompt(preparedId, rawPrompt);
        }
        setFailureRecovery({
          message: "当前未检测到可用智能体，已为你保留提示词到输入框。",
          retryRequest: request,
          threadId: preparedId,
        });
        return;
      }

      const contextBlock = buildSpaceDockCompanionContext(target, effectiveSelection);

      setAskSubmitting(true);
      runStartMsRef.current = Date.now();
      setElapsedSeconds(0);
      wasBusyRef.current = true;
      try {
        const result = await threadsRef.current.startArtifactAssistantTurn(
          target,
          { request: rawPrompt, context: contextBlock },
          isCurrentArtifact,
          { key: artifactKey, title: artifact.title },
        );
        persistPrimaryBinding(artifactKey, artifact, result.threadId);
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "未能确认请求已送达智能体";
        const preparedId = await ensurePrimaryThread(artifact, artifactKey).catch(
          () => primaryThreadId,
        );
        if (preparedId) {
          useComposerDraftStore.getState().setPrompt(preparedId, rawPrompt);
        }
        setPrefillPrompt(rawPrompt);
        setFailureRecovery({
          message,
          retryRequest: request,
          threadId: preparedId ?? primaryThreadId,
        });
      } finally {
        setAskSubmitting(false);
      }
    },
    [
      artifact,
      artifactKey,
      dockState,
      ensurePrimaryThread,
      isCurrentArtifact,
      persistPrimaryBinding,
      primaryThreadId,
      setSelection,
      setState,
    ],
  );

  const openSideChatTab = useCallback(
    (options?: { readonly title?: string; readonly prompt?: string }) => {
      if (!artifact || !artifactKey) return;
      setState("docked");
      const target: SpaceArtifactAssistantTarget = {
        kind: artifact.kind,
        itemId: artifact.itemId,
        title: artifact.title,
        scopeSpaceId: artifact.scopeSpaceId,
        sourceThreadId: artifact.sourceThreadId,
        revision: artifact.revision,
      };
      void (async () => {
        const created = await threadsRef.current.createTemporaryArtifactSidechat(
          target,
          isCurrentArtifact,
          {
            title: options?.title ?? `${artifact.title} · 临时对话`,
          },
        );
        if (!created || artifactKeyRef.current !== artifactKey) return;
        const nextTab: ExtraSidechatTab = {
          id: `sidechat-${created}`,
          threadId: created,
          title: options?.title ?? `临时对话`,
        };
        if (options?.prompt?.trim()) {
          const store = useComposerDraftStore.getState();
          store.setPrompt(created, options.prompt.trim());
          store.addPastedTexts(created, [
            createPastedTextDraft({
              id: `space-companion:${artifact.kind}:${artifact.itemId}`,
              createdAt: new Date().toISOString(),
              text: buildSpaceDockCompanionContext(target, selectionRef.current),
            }),
          ]);
        }
        setExtraSidechatTabsByKey((prev) => ({
          ...prev,
          [artifactKey]: [...(prev[artifactKey] ?? []), nextTab],
        }));
        setActiveTabIdByKey((prev) => ({ ...prev, [artifactKey]: nextTab.id }));
      })();
    },
    [artifact, artifactKey, isCurrentArtifact, setState],
  );

  const handleCreateFreshBoundThread = useCallback(async () => {
    if (!artifact || !artifactKey) return;
    pageAssistantThreads.forget(artifactKey);
    const freshId = await threadsRef.current.prepareArtifactAssistant(
      {
        kind: artifact.kind,
        itemId: artifact.itemId,
        title: artifact.title,
        scopeSpaceId: artifact.scopeSpaceId,
        sourceThreadId: artifact.sourceThreadId,
        revision: artifact.revision,
      },
      isCurrentArtifact,
      { key: artifactKey, title: `${artifact.title}` },
    );
    if (freshId) {
      persistPrimaryBinding(artifactKey, artifact, freshId, true);
      setActiveTabIdByKey((prev) => ({ ...prev, [artifactKey]: PRIMARY_PANE_ID }));
    }
  }, [artifact, artifactKey, isCurrentArtifact, persistPrimaryBinding]);

  const handleSelectRecentThread = useCallback(
    (threadId: ThreadId) => {
      if (!artifact || !artifactKey) return;
      persistPrimaryBinding(artifactKey, artifact, threadId, true);
      setActiveTabIdByKey((prev) => ({ ...prev, [artifactKey]: PRIMARY_PANE_ID }));
    },
    [artifact, artifactKey, persistPrimaryBinding],
  );

  const handleOpenFullscreenThread = useCallback(() => {
    const targetId = activeTabThreadId ?? primaryThreadId;
    if (!targetId) return;
    openChatThreadPage(targetId);
    void navigate({ to: "/$threadId", params: { threadId: targetId } });
  }, [activeTabThreadId, navigate, openChatThreadPage, primaryThreadId]);

  const removeTemporaryTab = useCallback(
    (paneId: string) => {
      if (!artifactKey) return;
      setExtraSidechatTabsByKey((prev) => ({
        ...prev,
        [artifactKey]: (prev[artifactKey] ?? []).filter((tab) => tab.id !== paneId),
      }));
      setActiveTabIdByKey((prev) =>
        prev[artifactKey] === paneId ? { ...prev, [artifactKey]: PRIMARY_PANE_ID } : prev,
      );
    },
    [artifactKey],
  );

  const handleRequestCloseDockedPane = useCallback(
    (paneId: string) => {
      if (paneId === PRIMARY_PANE_ID) {
        setState("collapsed");
        return;
      }
      const tab = extraTabs.find((entry) => entry.id === paneId);
      if (!tab) return;
      const storeState = useStore.getState();
      const summary = storeState.sidebarThreadSummaryById[tab.threadId];
      const draft = useComposerDraftStore.getState().draftsByThreadId[tab.threadId];
      const hasMessages =
        Boolean(summary?.latestTurn) ||
        (storeState.messageIdsByThreadId?.[tab.threadId]?.length ?? 0) > 0 ||
        Boolean(draft && (draft.prompt.trim() || draft.pastedTexts.length > 0));
      if (!hasMessages || readSkipSidechatCloseConfirmation()) {
        removeTemporaryTab(paneId);
        return;
      }
      setCloseConfirmDontAsk(false);
      setCloseConfirmState({ paneId, threadId: tab.threadId, title: tab.title });
    },
    [extraTabs, removeTemporaryTab, setState],
  );

  // Drag PiP header & detect right-edge snap drop zone (`data-floating-chat-drop-indicator="right-pane"`).
  const pipDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    snapping: boolean;
  } | null>(null);

  const startPipDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || shouldSkipResizeTarget(event.target)) return;
      event.preventDefault();
      pipDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: pipRect.left,
        startTop: pipRect.top,
        snapping: false,
      };
      const containerRect = props.containerRef.current?.getBoundingClientRect();
      const handleMove = (moveEvent: PointerEvent) => {
        const drag = pipDragRef.current;
        if (!drag || moveEvent.pointerId !== drag.pointerId) return;
        const next = clampSpaceDockPipRect(
          {
            left: drag.startLeft + (moveEvent.clientX - drag.startX),
            top: drag.startTop + (moveEvent.clientY - drag.startY),
            width: pipRect.width,
            height: pipRect.height,
          },
          {
            width: containerBounds.width,
            height: containerBounds.height,
            topInsetPx,
            bottomInsetPx: artifact?.kind === "page" ? 72 : 16,
          },
        );
        setPipPosition({ left: next.left, top: next.top });
        const nearRight = isNearSpaceDockRightSnapZone({
          rectRightPx: next.left + next.width,
          containerWidthPx: containerBounds.width,
          pointerClientX: moveEvent.clientX,
          containerRightPx: containerRect?.right,
        });
        drag.snapping = nearRight;
        setRightSnapActive(nearRight);
      };
      const handleEnd = (endEvent: PointerEvent) => {
        const drag = pipDragRef.current;
        if (!drag || endEvent.pointerId !== drag.pointerId) return;
        pipDragRef.current = null;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        window.removeEventListener("pointercancel", handleEnd);
        setRightSnapActive(false);
        if (drag.snapping) {
          setState("docked");
        }
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
      window.addEventListener("pointercancel", handleEnd);
    },
    [
      artifact?.kind,
      containerBounds.height,
      containerBounds.width,
      pipRect.height,
      pipRect.left,
      pipRect.top,
      pipRect.width,
      props.containerRef,
      setState,
      topInsetPx,
    ],
  );

  const startPipResize = useCallback(
    (edge: SpaceDockPipResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startRect = pipRect;
      const startX = event.clientX;
      const startY = event.clientY;
      let latestRect = startRect;
      const viewport = {
        width: containerBounds.width,
        height: containerBounds.height,
        topInsetPx,
        bottomInsetPx: artifact?.kind === "page" ? 72 : 16,
      };
      const handleMove = (moveEvent: PointerEvent) => {
        latestRect = applySpaceDockPipResize(
          startRect,
          edge,
          moveEvent.clientX - startX,
          moveEvent.clientY - startY,
          viewport,
        );
        setPipPosition({ left: latestRect.left, top: latestRect.top });
        setPipSize({ width: latestRect.width, height: latestRect.height });
      };
      const handleEnd = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        window.removeEventListener("pointercancel", handleEnd);
        writePersistedSpaceDockPipSize({ width: latestRect.width, height: latestRect.height });
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
      window.addEventListener("pointercancel", handleEnd);
    },
    [artifact?.kind, containerBounds.height, containerBounds.width, pipRect, topInsetPx],
  );

  const statusLabel = useMemo(
    () => formatSpaceDockElapsedLabel(busy, elapsedSeconds),
    [busy, elapsedSeconds],
  );

  const controller = useMemo<SpaceCanvasDockController>(
    () => ({
      state: dockState,
      setState,
      activeThreadId: activeTabThreadId,
      busy,
      elapsedSeconds,
      statusLabel,
      ask,
      openSideChatTab,
      selection,
      setSelection,
      registerHostInsets,
    }),
    [
      activeTabThreadId,
      ask,
      busy,
      dockState,
      elapsedSeconds,
      openSideChatTab,
      registerHostInsets,
      selection,
      setState,
      statusLabel,
    ],
  );

  // Build RightDock panes (pinned primary companion tab + any temporary `+` sidechat tabs).
  const rightDockState = useMemo(() => {
    const base = createDefaultRightDockState();
    const primaryPane = makeSidechatDockPane(PRIMARY_PANE_ID, primaryThreadId);
    const extraPanes = extraTabs.map((tab) => makeSidechatDockPane(tab.id, tab.threadId));
    const panes = [primaryPane, ...extraPanes];
    const resolvedActiveId = panes.some((pane) => pane.id === activeTabId)
      ? activeTabId
      : PRIMARY_PANE_ID;
    return {
      ...base,
      open: Boolean(artifact && dockState === "docked"),
      activePaneId: resolvedActiveId,
      panes,
    };
  }, [activeTabId, artifact, dockState, extraTabs, primaryThreadId]);

  const paneLabelOverrides = useMemo(() => {
    const map: Record<string, string | undefined> = {
      [PRIMARY_PANE_ID]: artifact ? `${artifact.title} · 对话` : "画布助手",
    };
    for (const tab of extraTabs) {
      map[tab.id] = tab.title;
    }
    return map;
  }, [artifact, extraTabs]);

  const primaryPipPane = useMemo(
    () => (primaryThreadId ? makeSidechatDockPane(PRIMARY_PANE_ID, primaryThreadId) : null),
    [primaryThreadId],
  );

  const handleDockedWidthChange = useCallback(
    (next: number) => setDockedWidthPx((prev) => (prev === next ? prev : next)),
    [],
  );
  const shouldAcceptRightDockWidth = useCallback(() => true, []);
  const rightDockAddAction = useMemo(
    () => ({
      label: "新建临时对话",
      onClick: () => openSideChatTab(),
    }),
    [openSideChatTab],
  );
  const handleSelectRightDockPane = useCallback((paneId: string) => {
    const key = artifactKeyRef.current;
    if (key) {
      setActiveTabIdByKey((prev) => (prev[key] === paneId ? prev : { ...prev, [key]: paneId }));
    }
  }, []);
  const handleCollapseDock = useCallback(() => setState("collapsed"), [setState]);
  const handleRightDockOpenChange = useCallback(
    (open: boolean) => {
      if (!open && dockState === "docked") {
        setState("collapsed");
      }
    },
    [dockState, setState],
  );
  const handleAddRightDockPane = useCallback(() => openSideChatTab(), [openSideChatTab]);

  const recentThreads = (() => {
    const list = readSpaceDockRecentThreads();
    if (!artifactKey) return list.slice(0, 6);
    const matching = list.filter((item) => item.artifactKey === artifactKey);
    const others = list.filter((item) => item.artifactKey !== artifactKey);
    return [...matching.slice(0, 3), ...others.slice(0, 4)];
  })();

  const selectionSummary = formatSpaceDockSelectionSummary(selection);
  const timerBadge = formatSpaceDockTimerBadge(busy, elapsedSeconds);
  const primaryThreadExists = Boolean(
    primaryThreadSummary || primaryThreadShell || primaryHasDraft,
  );

  const portalContent = artifact ? (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {selectionSummary ? (
        <div
          data-space-dock-selection-bar
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-ui-xs text-muted-foreground"
        >
          <span className="min-w-0 truncate">上下文：{selectionSummary}</span>
          <IconButton
            size="icon-xs"
            variant="ghost"
            label="清除上下文选区"
            onClick={() => setSelection(null)}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      ) : null}
      {failureRecovery ? (
        <div
          role="status"
          data-space-dock-recovery-banner
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-ui-xs text-foreground"
        >
          <span className="min-w-0 truncate">请求未确认 · {failureRecovery.message}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {failureRecovery.retryRequest ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void ask(failureRecovery.retryRequest)}
              >
                <RotateCcwIcon className="size-3.5" aria-hidden />
                <span>重试</span>
              </Button>
            ) : null}
            {failureRecovery.threadId ? (
              <Button size="xs" variant="ghost" onClick={handleOpenFullscreenThread}>
                <span>查看对话</span>
              </Button>
            ) : null}
            <IconButton
              size="icon-xs"
              variant="ghost"
              label="关闭提示"
              onClick={() => setFailureRecovery(null)}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {primaryPipPane ? (
          <SidechatDockPane
            pane={primaryPipPane}
            runtimeMode="live"
            threadExists={primaryThreadExists}
            isFocusedPane={dockState !== "collapsed"}
          />
        ) : (
          <PipStarterSurface
            artifact={artifact}
            selectionSummary={selectionSummary}
            initialPrompt={prefillPrompt}
            submitting={askSubmitting}
            onSubmitPrompt={(prompt) => void ask({ prompt, selection })}
          />
        )}
      </div>
    </div>
  ) : null;

  const threadSwitcherMenu = artifact ? (
    <Menu modal={false}>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="max-w-[220px] gap-1.5 px-2 font-medium text-foreground"
            aria-label="切换画布关联对话"
          />
        }
      >
        <SidechatIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{artifact.title}</span>
        {timerBadge ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-ui-xs tabular-nums text-muted-foreground">
            {timerBadge}
          </span>
        ) : null}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-64 min-w-64">
        <div className="px-2 py-1 text-ui-xs font-medium text-muted-foreground">关联此画布</div>
        {primaryThreadId ? (
          <MenuItem
            onClick={() =>
              artifactKey &&
              setActiveTabIdByKey((prev) => ({ ...prev, [artifactKey]: PRIMARY_PANE_ID }))
            }
          >
            <CheckIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{artifact.title} · 主对话</span>
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => void handleCreateFreshBoundThread()}>
          <PlusIcon className="size-3.5 shrink-0" aria-hidden />
          <span>新建关联对话</span>
        </MenuItem>
        {recentThreads.length > 0 ? (
          <>
            <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1 text-ui-xs font-medium text-muted-foreground">
              近期
            </div>
            {recentThreads.map((entry) => (
              <MenuItem
                key={entry.threadId}
                onClick={() => handleSelectRecentThread(entry.threadId)}
              >
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                {entry.threadId === primaryThreadId ? (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
                ) : null}
              </MenuItem>
            ))}
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  ) : null;

  return (
    <>
      {portalHostEl ? createPortal(portalContent, portalHostEl) : null}

      {/* Hidden inert host preserves Portal DOM/scroll/IME/streaming across collapsed periods. */}
      <div
        ref={setParkedSlotEl}
        aria-hidden="true"
        inert
        data-space-dock-parked-slot="true"
        className="pointer-events-none fixed bottom-0 right-0 -z-10 h-[400px] w-[360px] overflow-hidden opacity-0"
      />

      <div className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {props.children(controller)}

          {/* State 1: Collapsed compact 1000ms tabular-nums status bar (`--foot-bar-room` safe) */}
          {showCollapsedPill && artifact ? (
            <div
              data-space-canvas-dock="collapsed"
              className={cn(
                "pointer-events-auto absolute right-4 z-30 flex items-center gap-1.5 rounded-pill border border-border bg-popover/95 px-2.5 py-1.5 shadow-xl backdrop-blur-sm transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
                artifact.kind === "page" ? "bottom-[72px]" : "bottom-4",
              )}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  busy ? "animate-pulse bg-primary" : "bg-muted-foreground/60",
                )}
                aria-hidden="true"
              />
              <Button
                size="xs"
                variant="ghost"
                className="h-7 gap-1.5 px-1.5 text-ui-sm font-medium text-foreground tabular-nums"
                onClick={() => setState("pip")}
              >
                <span>{statusLabel}</span>
                {lastPromptSnippet ? (
                  <span className="max-w-[160px] truncate text-ui-xs font-normal text-muted-foreground">
                    · {lastPromptSnippet}
                  </span>
                ) : null}
              </Button>
              {busy && primaryThreadId ? (
                <IconButton
                  size="icon-xs"
                  variant="ghost"
                  label="停止当前生成"
                  tooltip="停止当前生成"
                  onClick={() => void threads.releasePageAssistant(primaryThreadId)}
                >
                  <StopFilledIcon className="size-3.5 text-destructive" />
                </IconButton>
              ) : null}
              <IconButton
                size="icon-xs"
                variant="ghost"
                label="展开悬浮窗"
                tooltip="展开悬浮窗"
                onClick={() => setState("pip")}
              >
                <Maximize2 className="size-3.5" />
              </IconButton>
              <IconButton
                size="icon-xs"
                variant="ghost"
                label="停靠到右侧分栏"
                tooltip="停靠到右侧分栏"
                onClick={() => setState("docked")}
              >
                <LayoutRightIcon className="size-3.5" />
              </IconButton>
            </div>
          ) : null}

          {/* State 2: Floating PiP (`560x640` default, 8-edge resize, header drag + right snap zone) */}
          {artifact && dockState === "pip" ? (
            <aside
              aria-label="Moss 画布助手浮窗"
              data-space-canvas-dock="pip"
              style={{
                left: `${pipRect.left}px`,
                top: `${pipRect.top}px`,
                width: `${pipRect.width}px`,
                height: `${pipRect.height}px`,
              }}
              className="pointer-events-auto absolute z-40 flex flex-col overflow-hidden rounded-card border border-border bg-popover text-foreground shadow-2xl transition-[box-shadow] duration-300 ease-out motion-reduce:transition-none"
            >
              {/* Edge / corner resize hit zones */}
              <div
                onPointerDown={(e) => startPipResize("n", e)}
                className="absolute inset-x-3 top-0 z-10 h-1.5 cursor-ns-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("s", e)}
                className="absolute inset-x-3 bottom-0 z-10 h-1.5 cursor-ns-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("w", e)}
                className="absolute inset-y-3 left-0 z-10 w-1.5 cursor-ew-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("e", e)}
                className="absolute inset-y-3 right-0 z-10 w-1.5 cursor-ew-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("nw", e)}
                className="absolute left-0 top-0 z-20 size-3 cursor-nwse-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("ne", e)}
                className="absolute right-0 top-0 z-20 size-3 cursor-nesw-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("sw", e)}
                className="absolute bottom-0 left-0 z-20 size-3 cursor-nesw-resize"
              />
              <div
                onPointerDown={(e) => startPipResize("se", e)}
                className="absolute bottom-0 right-0 z-20 size-3 cursor-nwse-resize"
              />

              {/* Draggable PiP header */}
              <div
                data-space-dock-pip-header
                onPointerDown={startPipDrag}
                className={cn(
                  "flex shrink-0 cursor-grab items-center justify-between gap-2 px-3 active:cursor-grabbing select-none",
                  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
                  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
                )}
              >
                <div className="flex min-w-0 items-center gap-1">{threadSwitcherMenu}</div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    size="icon-xs"
                    variant="ghost"
                    label="停靠到右侧分栏"
                    tooltip="停靠到右侧分栏"
                    onClick={() => setState("docked")}
                  >
                    <LayoutRightIcon className="size-3.5" />
                  </IconButton>
                  <Menu modal={false}>
                    <MenuTrigger
                      render={<Button size="icon-xs" variant="ghost" aria-label="更多操作" />}
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </MenuTrigger>
                    <ComposerPickerMenuPopup align="end" side="bottom" className="w-48 min-w-48">
                      <MenuItem disabled={!activeTabThreadId} onClick={handleOpenFullscreenThread}>
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                        <span>在完整视图中打开</span>
                      </MenuItem>
                      <MenuItem onClick={() => openSideChatTab()}>
                        <PlusIcon className="size-3.5 shrink-0" aria-hidden />
                        <span>右侧新建临时对话</span>
                      </MenuItem>
                    </ComposerPickerMenuPopup>
                  </Menu>
                  <IconButton
                    size="icon-xs"
                    variant="ghost"
                    label="关闭"
                    tooltip="关闭"
                    data-space-dock-close
                    onClick={() => setState("collapsed")}
                  >
                    <XIcon className="size-3.5" />
                  </IconButton>
                </div>
              </div>

              {/* Persistent Portal slot host */}
              <div
                ref={setPipSlotEl}
                data-space-dock-pip-body="true"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              />
            </aside>
          ) : null}

          {/* Exact right-edge SVG snap indicator while dragging PiP near the right edge */}
          {rightSnapActive ? <RightEdgeSnapIndicator /> : null}
        </div>

        {/* State 3: Docked RightDock (`containerMode="parent"`, `<320px` auto-collapse, 300ms close-lock) */}
        <div
          data-space-canvas-dock={dockState === "docked" ? "docked" : undefined}
          className={cn("min-h-0 flex-none", dockState !== "docked" && "pointer-events-none w-0")}
        >
          <RightDock
            state={rightDockState}
            minWidth={SPACE_DOCK_RIGHT_COLLAPSE_THRESHOLD_PX}
            defaultWidth={420}
            preferredDefaultWidthPx={420}
            shouldAcceptWidth={shouldAcceptRightDockWidth}
            widthStorageKey={SPACE_DOCK_PERSIST_KEYS.rightWidthRatio}
            containerMode="parent"
            mobileSheet={false}
            layoutHostRef={props.containerRef}
            windowControlsGutterClassName=""
            paneLabelOverrides={paneLabelOverrides}
            addMenuKinds={RIGHT_DOCK_ADD_MENU_KINDS}
            addAction={rightDockAddAction}
            pinnedPaneIds={PINNED_PRIMARY_PANE_IDS}
            keepMountedPaneIds={PINNED_PRIMARY_PANE_IDS}
            tabCloseLockMs={SPACE_DOCK_TAB_CLOSE_LOCK_MS}
            collapseBelowMinWidthPx={SPACE_DOCK_RIGHT_COLLAPSE_THRESHOLD_PX}
            onWidthChange={handleDockedWidthChange}
            onSelectPane={handleSelectRightDockPane}
            onClosePane={handleRequestCloseDockedPane}
            onCollapse={handleCollapseDock}
            onOpenChange={handleRightDockOpenChange}
            onAddPane={handleAddRightDockPane}
            headerExtraControls={
              <div className="flex items-center gap-0.5">
                {activeTabThreadId ? (
                  <IconButton
                    size="icon-xs"
                    variant="chrome"
                    label="在完整视图中打开"
                    tooltip="在完整视图中打开"
                    tooltipSide="bottom"
                    onClick={handleOpenFullscreenThread}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </IconButton>
                ) : null}
                <IconButton
                  size="icon-xs"
                  variant="chrome"
                  label="切换为悬浮小窗"
                  tooltip="切换为悬浮小窗"
                  tooltipSide="bottom"
                  onClick={() => setState("pip")}
                >
                  <PopOutIcon className="size-3.5" />
                </IconButton>
              </div>
            }
            renderPane={(pane, context) => {
              if (pane.id === PRIMARY_PANE_ID) {
                return (
                  <div
                    ref={setDockedSlotEl}
                    data-space-dock-docked-body="true"
                    className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
                  />
                );
              }
              return (
                <TemporarySidechatDockPane
                  pane={pane}
                  runtimeMode={context.runtimeMode}
                  isFocusedPane={context.isActive && context.isVisible}
                />
              );
            }}
          />
        </div>
      </div>

      {/* Close temporary sidechat tab confirmation dialog with persisted "不再询问" */}
      <Dialog
        open={closeConfirmState !== null}
        onOpenChange={(open) => {
          if (!open) setCloseConfirmState(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>关闭临时对话标签页？</DialogTitle>
            <DialogDescription>
              「{closeConfirmState?.title}」仍会保留在对话历史中，可随时从对话列表中恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex cursor-pointer items-center gap-2 text-ui-sm text-foreground">
              <Checkbox
                checked={closeConfirmDontAsk}
                onCheckedChange={(checked) => setCloseConfirmDontAsk(Boolean(checked))}
              />
              <span>不再询问</span>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCloseConfirmState(null)}>
              取消
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                if (closeConfirmDontAsk) {
                  writeSkipSidechatCloseConfirmation(true);
                }
                const paneId = closeConfirmState?.paneId;
                setCloseConfirmState(null);
                if (paneId) removeTemporaryTab(paneId);
              }}
            >
              关闭标签页
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
