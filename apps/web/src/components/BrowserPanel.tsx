// FILE: BrowserPanel.tsx
// Purpose: Renders the in-app browser chrome and mirrors the native Electron view.
// Layer: Desktop-only React component
// Depends on: browserStateStore, nativeApi browser bridge, DiffPanelShell
//
// Note: raw <button>s for autocomplete-suggestion rows and tab-title activate
// regions are intentional — list-row and tab semantics, not shadcn Buttons.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type BrowserAnnotationEvent,
  type ProjectId,
  type ThreadBrowserState,
  type ThreadId,
} from "@moss/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Maximize2,
  Minimize2,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "~/lib/icons";

import {
  BROWSER_BLANK_URL,
  isBlankBrowserTabUrl,
  resolveCopyableBrowserTabUrl,
} from "@moss/shared/browserSession";
import {
  BROWSER_COPY_LINK_TOAST_TITLE,
  isBrowserCopyLinkChord,
} from "@moss/shared/browserShortcuts";

import { isElectron } from "~/env";
import { CentralIcon } from "~/lib/central-icons";
import { readNativeApi } from "~/nativeApi";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { readDesktopZoomFactor, subscribeDesktopZoomFactor } from "~/lib/desktopZoom";
import {
  BROWSER_PANEL_BOUNDS_SYNC_EVENT,
  requestBrowserPanelBoundsSync,
} from "~/lib/browserPanelBoundsSync";
import {
  NATIVE_SURFACE_MENU_OVERLAY_SELECTOR,
  NATIVE_SURFACE_OCCLUSION_SYNC_EVENT,
} from "~/lib/nativeSurfaceOcclusion";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";

import {
  useBrowserStateStore,
  selectThreadBrowserHistory,
  selectThreadBrowserState,
} from "../browserStateStore";
import { useComposerDraftStore, type BrowserAnnotationDraft } from "../composerDraftStore";
import { prepareComposerImageAttachmentsFromFiles } from "../lib/composerSend";
import { useTranslation } from "~/localization";
import { BROWSER_NEW_TAB_REQUEST_EVENT, BrowserPageTabs } from "./browser/BrowserPageTabs";
import { BrowserPanelMenu } from "./browser/BrowserPanelMenu";
import {
  browserAddressDisplay,
  browserAddressEditValue,
  findBrowserViewportPreset,
  resolveBrowserViewportFrame,
} from "./browser/browserPanelChrome.logic";
import {
  browserViewportTabKey,
  openUrlInThreadBrowser,
  useBrowserViewportStore,
} from "./browser/browserPanelNavigation";
import { BrowserServersMenu } from "./browser/BrowserServersMenu";
import { LaunchServersPage } from "./browser/LaunchServerList";
import { useProjectLaunchServers } from "./browser/useProjectLaunchServers";
import {
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
} from "./chat/chatHeaderControls";
import { BrowserSketchOverlay } from "./browser/BrowserSketchOverlay";
import { BrowserSketchToolbar } from "./browser/BrowserSketchToolbar";
import { useBrowserSketch } from "./browser/useBrowserSketch";
import {
  browserWebviewInitialUrl,
  buildBrowserAddressSuggestions,
  createBrowserPanelHideScheduler,
  createBrowserPanelRendererHandoff,
  createBrowserRendererLossHandler,
  hasObscuringHitStackElementAboveSurface,
  normalizeBrowserAddressInput,
  resolveBrowserAddressSync,
  shouldOccludeBrowserWebview,
  applyBrowserWebviewPresentation,
  isBrowserPanelBoundsHiddenKey,
  resolveBrowserRuntimePresentation,
  type BrowserAddressSuggestion,
} from "./BrowserPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import {
  useBrowserAnnotations,
  type BrowserAnnotationsController,
} from "./browser/useBrowserAnnotations";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Skeleton } from "./ui/skeleton";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BrowserPanelProps {
  mode: DiffPanelMode;
  threadId: ThreadId;
  onClosePanel: () => void;
  runtimeMode?: DockPaneRuntimeMode;
  onRequestLive?: () => void;
  /**
   * Where the panel sits: `dock` (the side panel) or `standalone` (a split pane). Either
   * way it draws its own header row (page tabs and "+", then servers, "…", expand and
   * close) above its address row, as the desktop panel does.
   */
  chrome?: "dock" | "standalone";
  /** The chat's project folder: local pages show their path from here. */
  workspaceRoot?: string | null;
  /** The chat's project: its servers are listed on a new tab and under the servers button. */
  projectId?: ProjectId | null;
  /** Opens a local page's file as source ("…" › View source), or the launch file. */
  onViewSource?: (absolutePath: string) => void;
  /** The side panel's width toggle, shown in the header as Expand / Restore. */
  layout?: { readonly expanded: boolean; readonly onToggleExpanded: () => void } | undefined;
}

const BROWSER_BOUNDS_SYNC_BURST_FRAMES = 30;
const BROWSER_BOUNDS_SYNC_STABLE_FRAME_TARGET = 2;
/** How long an overlay waits for a first still of the page before hiding it anyway. */
const BROWSER_COVER_STILL_WAIT_MS = 200;
/** Resting stills: first one soon after the page settles, then slower while nothing changes. */
const BROWSER_RESTING_FRAME_FIRST_MS = 400;
const BROWSER_RESTING_FRAME_ACTIVE_MS = 1_000;
const BROWSER_RESTING_FRAME_IDLE_MAX_MS = 4_000;
/** A picked element is shot once its pick highlight has left the page. */
const PICKED_ELEMENT_SHOT_DELAY_MS = 260;
/** Room around a picked element in its picture, and the picture's largest side. */
const PICKED_ELEMENT_SHOT_PADDING_PX = 8;
const PICKED_ELEMENT_SHOT_MAX_PX = 1_200;

/** Cuts a picked element (plus a little room) out of a screenshot of the page's viewport. */
async function cropPickedElementShot(input: {
  readonly bytes: Uint8Array;
  readonly box: NonNullable<Extract<BrowserAnnotationEvent, { kind: "committed" }>["elementBox"]>;
  readonly name: string;
}): Promise<File | null> {
  const bitmap = await createImageBitmap(
    new Blob([input.bytes as BlobPart], { type: "image/png" }),
  );
  try {
    const scale = bitmap.width / input.box.viewport.width;
    const pad = PICKED_ELEMENT_SHOT_PADDING_PX;
    const left = Math.max(0, Math.floor((input.box.rect.x - pad) * scale));
    const top = Math.max(0, Math.floor((input.box.rect.y - pad) * scale));
    const right = Math.min(
      bitmap.width,
      Math.ceil((input.box.rect.x + input.box.rect.width + pad) * scale),
    );
    const bottom = Math.min(
      bitmap.height,
      Math.ceil((input.box.rect.y + input.box.rect.height + pad) * scale),
    );
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) return null;
    const fit = Math.min(1, PICKED_ELEMENT_SHOT_MAX_PX / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * fit));
    canvas.height = Math.max(1, Math.round(height * fit));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, left, top, width, height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new File([blob], input.name, { type: "image/png" }) : null;
  } finally {
    bitmap.close();
  }
}

/** The still stays up this long after an overlay closes, while the page comes back. */
const BROWSER_PREVIEW_FRAME_HOLD_MS = 250;
const BROWSER_WEBVIEW_PARTITION = "persist:moss-browser";
const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
const MOSS_BROWSER_LABEL = "Moss browser";
const browserPanelHideScheduler = createBrowserPanelHideScheduler();
const browserPanelRendererHandoff = createBrowserPanelRendererHandoff();
const EMPTY_BROWSER_ANNOTATIONS: readonly BrowserAnnotationDraft[] = [];
const NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR = [
  NATIVE_SURFACE_MENU_OVERLAY_SELECTOR,
  "[data-slot='dialog-backdrop']",
  "[data-slot='dialog-popup']",
  "[data-slot='dialog-viewport']",
  "[data-slot='alert-dialog-backdrop']",
  "[data-slot='alert-dialog-popup']",
  "[data-slot='alert-dialog-viewport']",
  "[data-slot='command-dialog-backdrop']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='command-dialog-viewport']",
  "[data-slot='toast-popup']",
  "[role='dialog'][aria-modal='true']",
].join(", ");

export function BrowserAnnotationButton(props: {
  controller: BrowserAnnotationsController;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const label = props.controller.active ? t("browser.pick.close") : t("browser.pick.open");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn(
              "size-7 text-foreground/80 hover:text-foreground [&_[data-slot=central-icon]]:!opacity-100",
              props.controller.active &&
                "bg-[color-mix(in_srgb,var(--color-text-accent)_13%,transparent)]! text-[var(--color-text-accent)]! hover:bg-[color-mix(in_srgb,var(--color-text-accent)_18%,transparent)]!",
            )}
            disabled={props.disabled}
            aria-label={label}
            aria-pressed={props.controller.active}
            aria-busy={props.controller.starting || undefined}
            data-pressed={props.controller.active ? "" : undefined}
            data-browser-annotate=""
            title={label}
            onClick={props.controller.toggle}
          />
        }
      >
        <CentralIcon name="window-cursor" className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.controller.active ? t("browser.pick.closeTooltip") : t("browser.pick.openTooltip")}
      </TooltipPopup>
    </Tooltip>
  );
}

// The browser itself lives inside a sheet, and toast portals/positioners are just
// layout containers. Treating either as blockers hides the WebContentsView.
const NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR = [
  "[data-panel-resize-overlay='true']",
  "[data-floating-browser-controls='true']",
  "[data-slot='sheet-backdrop']",
  "[data-slot='sheet-popup']",
  "[data-slot='toast-portal']",
  "[data-slot='toast-portal-anchored']",
  "[data-slot='toast-viewport']",
  "[data-slot='toast-viewport-anchored']",
  "[data-slot='toast-positioner']",
].join(", ");

interface BrowserViewportPerfCounters {
  syncAttempts: number;
  syncSkips: number;
  syncSends: number;
  resizeSchedules: number;
  resizeScheduleSkips: number;
  burstStarts: number;
  burstExtensions: number;
  burstFrames: number;
  transitionSignals: number;
  ignoredTransitionSignals: number;
}

interface BrowserWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
}

const VIEWPORT_TRANSITION_PROPERTIES = new Set([
  "transform",
  "translate",
  "scale",
  "rotate",
  "width",
  "max-width",
  "min-width",
  "height",
  "max-height",
  "min-height",
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
]);

function withShortLocalFileDetail(
  suggestion: BrowserAddressSuggestion,
  workspaceRoot: string | null | undefined,
): BrowserAddressSuggestion {
  if (browserAddressDisplay(suggestion.detail).kind !== "file") return suggestion;
  return { ...suggestion, detail: browserAddressEditValue(suggestion.detail, workspaceRoot) };
}

function formatBrowserActionError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return "Couldn't complete that browser action.";
  }
  if (/ERR_ABORTED|\(-3\)/i.test(error.message)) {
    return null;
  }
  return "Couldn't complete that browser action.";
}

function ignoreBrowserBoundsSyncError(): void {
  // Bounds sync is best-effort plumbing between the React shell and the native
  // browser surface. Avoid surfacing transient geometry-sync failures as user-facing
  // browser errors because they do not reflect page navigation health.
}

function ignoreBrowserWebviewDetachError(): void {
  // Renderer webview detach is best-effort cleanup; a stale/destroyed guest is already gone.
}

function setBrowserWebviewOverlayOcclusion(
  webview: BrowserWebviewElement | null,
  occluded: boolean,
): void {
  if (!webview) {
    return;
  }
  // Never use visibility:hidden on a <webview>. Electron unpaints or kills the
  // guest, which shows as a black card and BrowserHostUnavailable to the agent.
  webview.style.pointerEvents = occluded ? "none" : "auto";
}

function isVisibleOverlayElement(element: HTMLElement): boolean {
  const styles = window.getComputedStyle(element);
  if (styles.display === "none" || styles.visibility === "hidden" || styles.opacity === "0") {
    return false;
  }
  return element.getClientRects().length > 0;
}

function isNativeBrowserNonObscuringOverlayElement(element: HTMLElement): boolean {
  return (
    element.closest("[data-slot='toast-popup']") === null &&
    element.closest(NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR) !== null
  );
}

const NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
] as const;

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function candidateObscuresNativeBrowser(candidate: HTMLElement, element: HTMLElement): boolean {
  if (candidate === element || candidate.contains(element) || element.contains(candidate)) {
    return false;
  }
  if (!isVisibleOverlayElement(candidate)) {
    return false;
  }

  const elementRect = element.getBoundingClientRect();
  const candidateRects = candidate.getClientRects();
  for (const candidateRect of candidateRects) {
    if (rectsIntersect(elementRect, candidateRect)) {
      return true;
    }
  }

  return false;
}

function hasTopLayerDomObstruction(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  for (const [xRatio, yRatio] of NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS) {
    const x = rect.left + rect.width * xRatio;
    const y = rect.top + rect.height * yRatio;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      continue;
    }

    const hitElements = document.elementsFromPoint(x, y);
    if (
      hasObscuringHitStackElementAboveSurface(hitElements, {
        isSurfaceBoundary: (hitElement) =>
          hitElement === element ||
          (hitElement instanceof HTMLElement && element.contains(hitElement)),
        isNonObscuring: (hitElement) =>
          hitElement instanceof HTMLElement &&
          isNativeBrowserNonObscuringOverlayElement(hitElement),
        isVisible: (hitElement) =>
          hitElement instanceof HTMLElement && isVisibleOverlayElement(hitElement),
      })
    ) {
      return true;
    }
  }

  return false;
}

function hasNativeBrowserObscuringOverlay(element: HTMLElement): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR,
  );
  for (const candidate of candidates) {
    if (candidateObscuresNativeBrowser(candidate, element)) {
      return true;
    }
  }

  return hasTopLayerDomObstruction(element);
}

function isNativeBrowserTransitionSignalTarget(
  target: EventTarget | null,
  viewportElement: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (viewportElement.contains(target) || target.contains(viewportElement)) {
    return true;
  }

  return (
    target.closest(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) !== null ||
    target.closest("[data-slot='sidebar-container']") !== null ||
    target.closest("[data-slot='sheet-popup']") !== null
  );
}

/** Timeline marks for `moss:browser-perf` sessions (how a menu covers and uncovers the page). */
function markBrowserPerf(name: string): void {
  if (isBrowserPerfLoggingEnabled()) performance.mark(name);
}

function isBrowserPerfLoggingEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem("moss:browser-perf") === "1";
  } catch {
    return false;
  }
}

// Keeps a restored browser pane visually occupied while the live webview hydrates.
function BrowserRuntimePreview(props: { title: string; detail: string }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background/35 p-6"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 rounded-full" />
            <Skeleton className="h-2.5 w-full rounded-full" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-lg" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-8 rounded-md" />
            <Skeleton className="h-8 rounded-md" />
            <Skeleton className="h-8 rounded-md" />
          </div>
        </div>
        <div className="mt-4 min-w-0 text-center">
          <p className="text-ui leading-snug font-medium text-foreground">Restoring browser</p>
          <p className="mt-1 truncate text-ui-sm text-muted-foreground" title={props.detail}>
            {props.title}
          </p>
        </div>
      </div>
    </div>
  );
}

function BrowserRuntimeError(props: { message: string; onReload: () => void }) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-[#0d0d0d] px-6 text-center text-white"
      role="alert"
    >
      <div className="flex max-w-xs flex-col items-center">
        <CircleAlertIcon className="size-7 text-white/35" aria-hidden="true" />
        <p className="mt-3 text-ui-lg font-medium text-white/80">This page could not be loaded</p>
        <p className="mt-1 text-ui leading-snug text-white/45">{props.message}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={props.onReload}
        >
          Reload page
        </Button>
      </div>
    </div>
  );
}

export function BrowserPanel({
  mode,
  threadId,
  onClosePanel,
  runtimeMode: runtimeModeProp,
  onRequestLive,
  chrome: chromeProp,
  workspaceRoot: workspaceRootProp,
  projectId: projectIdProp,
  onViewSource,
  layout,
}: BrowserPanelProps) {
  // Defaults belong in the body, never in the destructuring pattern: React Compiler cannot lower an
  // AssignmentPattern there and silently drops the whole component's memoization.
  const runtimeMode = runtimeModeProp ?? "live";
  const chrome = chromeProp ?? "standalone";
  const workspaceRoot = workspaceRootProp ?? null;
  const projectId = projectIdProp ?? null;
  const { t, format } = useTranslation();
  const isFloatingMode = mode === "floating";
  const api = readNativeApi();
  const isLiveRuntime = runtimeMode === "live";
  const threadBrowserState = useBrowserStateStore(selectThreadBrowserState(threadId));
  const recentHistory = useBrowserStateStore(selectThreadBrowserHistory(threadId));
  const upsertThreadState = useBrowserStateStore((store) => store.upsertThreadState);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addBrowserAnnotation = useComposerDraftStore((store) => store.addBrowserAnnotation);
  const browserAnnotations = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.browserAnnotations ?? EMPTY_BROWSER_ANNOTATIONS,
  );
  const composerDraftImageCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.images.length ?? 0,
  );
  const composerDraftFileCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.files.length ?? 0,
  );
  const composerDraftAssistantSelectionCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.assistantSelections.length ?? 0,
  );
  const addressInputRef = useRef<HTMLInputElement>(null);
  const browserViewportRef = useRef<HTMLDivElement>(null);
  const browserWebviewRef = useRef<BrowserWebviewElement | null>(null);
  const browserWebviewStageRef = useRef<HTMLDivElement | null>(null);
  const browserWebviewTabIdRef = useRef<string | null>(null);
  const browserWebviewWebContentsIdRef = useRef<number | null>(null);
  const detachedBrowserWebviewsRef = useRef(new WeakSet<BrowserWebviewElement>());
  const browserWebviewAttachKeyRef = useRef<string | null>(null);
  // Unlike effect-local state, this lease survives browser metadata pushes.
  // Main can emit a newer tab snapshot before attachWebview() resolves; keeping
  // the in-flight key here prevents that render from issuing another bind for
  // the same physical guest and starving its compositor with IPC churn.
  const browserWebviewAttachInFlightKeyRef = useRef<string | null>(null);
  const activeTabInitialUrlRef = useRef(BROWSER_BLANK_URL);
  const addressDraftsByTabIdRef = useRef(new Map<string, string>());
  const lastSyncedAddressByTabIdRef = useRef(new Map<string, string>());
  const previousActiveTabIdRef = useRef<string | null>(null);
  const lastSentBoundsRef = useRef<string | null>(null);
  const lastMeasuredBoundsKeyRef = useRef<string | null>(null);
  const lastOverlayObscuredRef = useRef(false);
  // A pending "hide the page" for an overlay that just opened: sent once the still under it
  // has painted, so the slot never shows empty in between.
  const pendingCoverTokenRef = useRef(0);
  const requestRestingFrameRef = useRef<(force?: boolean) => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const isAddressEditingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const boundsBurstFrameRef = useRef<number | null>(null);
  const burstFramesRemainingRef = useRef(0);
  const burstStableFramesRef = useRef(0);
  const perfCountersRef = useRef<BrowserViewportPerfCounters>({
    syncAttempts: 0,
    syncSkips: 0,
    syncSends: 0,
    resizeSchedules: 0,
    resizeScheduleSkips: 0,
    burstStarts: 0,
    burstExtensions: 0,
    burstFrames: 0,
    transitionSignals: 0,
    ignoredTransitionSignals: 0,
  });
  const [addressValue, setAddressValue] = useState("");
  const [isAddressFocused, setIsAddressFocused] = useState(false);
  // Programmatic focus (e.g. right after "New tab") should not pop the suggestion list
  // over the tab strip; the user has to type or click into the field first.
  const [addressSuggestionsSuppressed, setAddressSuggestionsSuppressed] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [browserRendererGeneration, setBrowserRendererGeneration] = useState(0);
  // A page opened from a local file tried to leave for a site that is not allowed.
  const [blockedNavigation, setBlockedNavigation] = useState<{
    tabId: string;
    url: string;
  } | null>(null);
  const [isBrowserSurfaceOccluded, setIsBrowserSurfaceOccluded] = useState(false);
  const [previewFrame, setPreviewFrame] = useState<{ tabId: string; src: string } | null>(null);
  const previewFrameRef = useRef(previewFrame);
  previewFrameRef.current = previewFrame;
  // Keeps the still up briefly after an overlay closes, until the page is back on screen.
  const [holdingPreviewFrame, setHoldingPreviewFrame] = useState(false);
  const runtimeReady = isLiveRuntime ? workspaceReady : true;
  const activeTab =
    threadBrowserState?.tabs.find((tab) => tab.id === threadBrowserState.activeTabId) ??
    threadBrowserState?.tabs[0] ??
    null;
  const activeTabId = activeTab?.id ?? null;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const viewportPreset = findBrowserViewportPreset(
    useBrowserViewportStore((store) =>
      activeTabId ? store.presetByTabKey[browserViewportTabKey(threadId, activeTabId)] : undefined,
    ),
  );
  const usesNativeRuntime = activeTab?.runtimeSurface === "native";
  const rendererHasPopup =
    threadBrowserState?.tabs.some(
      (tab) =>
        Boolean(tab.openerTabId) && tab.openerTabId === browserWebviewRef.current?.dataset.tabId,
    ) ?? false;
  const activeTabInitialUrl = activeTab?.lastCommittedUrl ?? activeTab?.url ?? BROWSER_BLANK_URL;
  activeTabInitialUrlRef.current = activeTabInitialUrl;
  const loading = activeTab?.isLoading ?? false;
  const activeTabIsBlank = isBlankBrowserTabUrl(activeTab);
  const showLocalServersHome = isLiveRuntime && workspaceReady && (!activeTab || activeTabIsBlank);
  // A new tab lists the project's servers, as the desktop panel does: ▷ starts one and
  // shows it here once its port answers.
  const openInThisBrowser = useCallback(
    (url: string) => {
      const nativeApi = readNativeApi();
      if (!nativeApi) return;
      // The address field of a new tab has focus; the page replaces what it showed.
      isAddressEditingRef.current = false;
      setIsAddressFocused(false);
      void openUrlInThreadBrowser({ api: nativeApi, threadId, url }).catch((cause: unknown) => {
        setLocalError(formatBrowserActionError(cause) ?? t("browser.menu.actionFailed"));
      });
    },
    [t, threadId],
  );
  const launchServers = useProjectLaunchServers({
    projectId,
    workspaceRoot,
    enabled: showLocalServersHome,
    onOpen: openInThisBrowser,
  });

  const browserPageError = threadBrowserState?.lastError ?? null;
  // Local pages are listed by their short name too, never by their folder chain.
  const browserAddressSuggestions = buildBrowserAddressSuggestions({
    query: addressValue,
    activeTabId: activeTab?.id ?? null,
    tabs: threadBrowserState?.tabs ?? [],
    recentHistory,
  }).map((suggestion) => withShortLocalFileDetail(suggestion, workspaceRoot));
  // The field still showing the current page (focused to copy or retype it) is not a
  // search; suggestions start once the person types something else.
  const addressShowsCurrentPage =
    activeTab !== null && addressValue === browserAddressEditValue(activeTab.url, workspaceRoot);
  const showBrowserAddressSuggestions =
    isLiveRuntime &&
    isAddressFocused &&
    !addressSuggestionsSuppressed &&
    !addressShowsCurrentPage &&
    browserAddressSuggestions.length > 0 &&
    runtimeReady;
  const annotationMethods = api?.browser.annotations;
  // A local page runs at Moss's local-page address; the chat names it by its file instead,
  // the address the panel shows and the agent can open and edit.
  const activePageAddressRef = useRef<string | null>(null);
  activePageAddressRef.current = activeTab?.lastCommittedUrl ?? activeTab?.url ?? null;
  const addPickedElement = useCallback(
    (thread: ThreadId, annotation: Omit<BrowserAnnotationDraft, "ordinal">) => {
      const pageAddress = activePageAddressRef.current;
      const localPage =
        annotation.source.url.startsWith("moss-local-preview:") &&
        pageAddress?.startsWith("file:") === true;
      return addBrowserAnnotation(
        thread,
        localPage
          ? { ...annotation, source: { ...annotation.source, url: pageAddress } }
          : annotation,
      );
    },
    [addBrowserAnnotation],
  );
  // Select element works on any page: a web page or one opened from a local file (the
  // pages Moss writes), as in Claude.
  const annotationController = useBrowserAnnotations({
    methods: annotationMethods,
    threadId,
    activeTabId,
    browserStateVersion: threadBrowserState?.version ?? 0,
    enabled:
      isElectron && isLiveRuntime && workspaceReady && activeTab !== null && !showLocalServersHome,
    annotations: browserAnnotations,
    addAnnotation: addPickedElement,
    onError: setLocalError,
    onPicked: (event) => attachPickedElementShotRef.current(event),
  });
  const annotationAvailable =
    isLiveRuntime &&
    isElectron &&
    workspaceReady &&
    activeTab !== null &&
    !showLocalServersHome &&
    annotationMethods !== undefined;
  const elementPickAvailable = annotationAvailable;
  const sketch = useBrowserSketch({
    enabled: annotationAvailable,
    selectAvailable: elementPickAvailable,
    activeTabId,
    pageUrl: activeTab?.lastCommittedUrl ?? activeTab?.url ?? "",
    pageTitle: activeTab?.title ?? "",
    elementPicker: annotationController,
    capturePage: (tabId) =>
      api
        ? runBrowserAction(() => api.browser.captureScreenshot({ threadId, tabId }))
        : Promise.resolve(null),
    // The drawn area is the page itself: a device viewport's frame when one is set.
    readPageWidth: () => {
      const width = browserViewportRef.current?.clientWidth ?? 0;
      const height = browserViewportRef.current?.clientHeight ?? 0;
      return resolveBrowserViewportFrame({ width, height }, viewportPreset)?.width ?? width;
    },
    attachImage: async (file) => {
      const existing =
        composerDraftImageCount + composerDraftFileCount + composerDraftAssistantSelectionCount;
      const result = await prepareComposerImageAttachmentsFromFiles({
        files: [file],
        existingAttachmentCount: existing,
      });
      const image = result.images[0];
      if (!image || !addComposerDraftImage(threadId, image)) {
        throw new Error(
          result.error ??
            `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
        );
      }
    },
    onError: setLocalError,
  });
  const sketchCoversPage = sketch.coversPage;
  // A picked element also goes to the chat as a picture of itself (Claude sends one with
  // every selected element), cut from the page once the pick highlight is gone.
  const attachPickedElementShotRef = useRef<
    (event: Extract<BrowserAnnotationEvent, { kind: "committed" }>) => void
  >(() => undefined);
  attachPickedElementShotRef.current = (event) => {
    const box = event.elementBox;
    if (!api || !box || box.rect.width < 1 || box.rect.height < 1) return;
    const tabId = event.tabId;
    window.setTimeout(() => {
      void (async () => {
        try {
          const shot = await api.browser.captureScreenshot({ threadId, tabId });
          const file = await cropPickedElementShot({
            bytes: shot.bytes,
            box,
            name: `${event.annotation.tagName.toLowerCase() || "element"}.png`,
          });
          if (!file) return;
          const existing =
            composerDraftImageCount + composerDraftFileCount + composerDraftAssistantSelectionCount;
          const result = await prepareComposerImageAttachmentsFromFiles({
            files: [file],
            existingAttachmentCount: existing,
          });
          const image = result.images[0];
          if (image) addComposerDraftImage(threadId, image);
        } catch {
          // The element is in the chat already; its picture is a bonus.
        }
      })();
    }, PICKED_ELEMENT_SHOT_DELAY_MS);
  };
  const sketchButtonController: BrowserAnnotationsController = {
    active: sketch.open,
    starting: annotationController.starting,
    toggle: sketch.toggle,
  };

  const requestLiveRuntime = useCallback(() => {
    onRequestLive?.();
  }, [onRequestLive]);

  const ensureLiveRuntime = useCallback(() => {
    if (isLiveRuntime) {
      return true;
    }
    requestLiveRuntime();
    return false;
  }, [isLiveRuntime, requestLiveRuntime]);

  const runBrowserAction = useCallback(async <T,>(action: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await action();
      setLocalError(null);
      return result;
    } catch (error) {
      setLocalError(formatBrowserActionError(error));
      return null;
    }
  }, []);

  // Renderer-owned <webview>s are adopted by the desktop manager. Always detach before
  // removing the DOM node so main never keeps a stale webContents runtime.
  const detachRendererBrowserWebview = useCallback(
    (expectedWebview?: BrowserWebviewElement) => {
      const webview = browserWebviewRef.current;
      if (
        !webview ||
        (expectedWebview !== undefined && webview !== expectedWebview) ||
        detachedBrowserWebviewsRef.current.has(webview)
      ) {
        return;
      }
      detachedBrowserWebviewsRef.current.add(webview);

      const tabId = browserWebviewTabIdRef.current;

      if (api && isLiveRuntime && tabId) {
        let webContentsId = browserWebviewWebContentsIdRef.current ?? undefined;
        try {
          webContentsId ??= webview.getWebContentsId?.();
        } catch {
          // A destroyed guest can no longer answer getWebContentsId(). Retain the
          // id captured during attachment so main can still discard its lease.
        }
        if (webContentsId && webContentsId > 0) {
          try {
            const detachPromise = api.browser.detachWebview({ threadId, tabId, webContentsId });
            browserPanelRendererHandoff.trackDetach(threadId, detachPromise);
            void detachPromise.catch(ignoreBrowserWebviewDetachError);
          } catch {
            ignoreBrowserWebviewDetachError();
          }
        }
      }

      try {
        webview.remove();
      } catch {
        ignoreBrowserWebviewDetachError();
      } finally {
        if (browserWebviewRef.current === webview) {
          browserWebviewRef.current = null;
          browserWebviewTabIdRef.current = null;
          browserWebviewWebContentsIdRef.current = null;
          browserWebviewAttachKeyRef.current = null;
          browserWebviewAttachInFlightKeyRef.current = null;
        }
        const stage = browserWebviewStageRef.current;
        if (stage && stage.childElementCount === 0) {
          stage.remove();
          browserWebviewStageRef.current = null;
        }
      }
    },
    [api, isLiveRuntime, threadId],
  );

  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    return api.browser.onState((state) => {
      upsertThreadState(state);
    });
  }, [api, isLiveRuntime, upsertThreadState]);

  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    const releaseLiveHost = browserPanelHideScheduler.acquire(threadId);

    // Timeout-0 keeps the reset writes asynchronous (no wasted pre-paint
    // render), which also keeps this component eligible for React Compiler.
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      setWorkspaceReady(false);
      setLocalError(null);

      void runBrowserAction(() => api.browser.open({ threadId })).then((state) => {
        if (cancelled) {
          return;
        }
        if (!state) {
          setWorkspaceReady(true);
          return;
        }
        upsertThreadState(state);
        setWorkspaceReady(true);
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      releaseLiveHost();
      browserPanelHideScheduler.schedule(threadId, () => {
        void api.browser.hide({ threadId });
      });
    };
  }, [api, isLiveRuntime, runBrowserAction, threadId, upsertThreadState]);

  useEffect(() => {
    const activeTabId = activeTab?.id ?? null;
    const nextDisplayValue = browserAddressEditValue(activeTab?.url, workspaceRoot);
    const decision = resolveBrowserAddressSync({
      activeTabId,
      previousActiveTabId: previousActiveTabIdRef.current,
      savedDraft: activeTabId ? addressDraftsByTabIdRef.current.get(activeTabId) : undefined,
      nextDisplayValue,
      lastSyncedValue: activeTabId
        ? lastSyncedAddressByTabIdRef.current.get(activeTabId)
        : undefined,
      isEditing: isAddressEditingRef.current,
    });

    if (decision.type === "replace") {
      setAddressValue(decision.value);
      if (activeTabId) {
        addressDraftsByTabIdRef.current.set(activeTabId, decision.value);
        if (decision.syncedValue !== undefined) {
          lastSyncedAddressByTabIdRef.current.set(activeTabId, decision.syncedValue);
        }
      }
    }

    previousActiveTabIdRef.current = activeTabId;
  }, [activeTab, workspaceRoot]);

  useLayoutEffect(() => {
    if (!api || !isLiveRuntime || !workspaceReady || !activeTabId) {
      return;
    }

    if (showLocalServersHome || usesNativeRuntime) {
      if (rendererHasPopup && browserWebviewStageRef.current) {
        // Keep the renderer-owned opener alive while its native popup is shown.
        browserWebviewStageRef.current.style.visibility = "hidden";
        return;
      }
      detachRendererBrowserWebview();
      return;
    }

    const host = browserViewportRef.current;
    if (!host) {
      return;
    }

    let stage = browserWebviewStageRef.current;
    if (!stage) {
      stage = document.createElement("div");
      stage.dataset.floatingBrowserStage = "true";
      browserWebviewStageRef.current = stage;
    }
    if (stage.parentElement !== host) {
      host.append(stage);
    }
    stage.style.visibility = "visible";
    stage.style.pointerEvents = isFloatingMode ? "none" : "";
    stage.inert = isFloatingMode;

    let webview = browserWebviewRef.current;
    if (!webview) {
      webview = document.createElement("webview") as BrowserWebviewElement;
      webview.className = "h-full w-full";
      webview.style.display = "flex";
      webview.style.width = "100%";
      webview.style.height = "100%";
      webview.style.transform = "";
      webview.style.backgroundColor = "#0d0d0d";
      webview.setAttribute("partition", BROWSER_WEBVIEW_PARTITION);
      webview.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=yes");
      // A <webview> blocks window.open() unless `allowpopups` is set. Without it, clicking
      // "Continue with Google" (and any OAuth/popup flow) is silently dropped before the main
      // process's window-open handler ever runs. Enabling it lets the popup classifier in
      // browserManager decide popup-vs-tab and keep the OAuth `window.opener` handshake alive.
      webview.setAttribute("allowpopups", "true");
      // No `useragent` attribute on purpose: the desktop main process spoofs a desktop Chrome
      // UA on the shared persistent partition, so this webview (and OAuth popups) inherit the
      // same identity. This keeps in-app Google/OAuth sign-in working without duplicating the
      // UA string into the renderer.
      webview.dataset.rendererGeneration = String(browserRendererGeneration);
      browserWebviewWebContentsIdRef.current = null;
      browserWebviewRef.current = webview;
    }
    if (webview.parentElement !== stage) {
      stage.append(webview);
    }
    applyBrowserWebviewPresentation(stage, {
      floating: isFloatingMode,
      slotWidth: host.clientWidth,
      slotHeight: host.clientHeight,
    });

    const initialUrl = activeTabInitialUrlRef.current;
    const shouldLoadInitialUrl = browserWebviewTabIdRef.current !== activeTabId;
    if (shouldLoadInitialUrl) {
      browserWebviewTabIdRef.current = activeTabId;
      browserWebviewAttachKeyRef.current = null;
      webview.dataset.tabId = activeTabId;
    }

    let cancelled = false;
    let attachRetryTimer: number | null = null;
    let attachRetryDelayMs = 25;

    const scheduleAttachRetry = () => {
      if (cancelled || attachRetryTimer !== null) {
        return;
      }
      attachRetryTimer = window.setTimeout(() => {
        attachRetryTimer = null;
        attachVisibleWebview();
      }, attachRetryDelayMs);
      attachRetryDelayMs = Math.min(attachRetryDelayMs * 2, 500);
    };

    let attachHandoffInFlight = false;
    const attachVisibleWebviewNow = () => {
      if (cancelled) {
        return;
      }
      if (attachRetryTimer !== null) {
        window.clearTimeout(attachRetryTimer);
        attachRetryTimer = null;
      }

      let webContentsId: number | undefined;
      try {
        webContentsId = webview.getWebContentsId?.();
      } catch {
        scheduleAttachRetry();
        return;
      }
      if (!webContentsId || webContentsId <= 0) {
        scheduleAttachRetry();
        return;
      }
      if (browserWebviewRef.current === webview) {
        browserWebviewWebContentsIdRef.current = webContentsId;
      }

      const attachKey = `${browserRendererGeneration}:${activeTabId}:${webContentsId}`;
      if (browserWebviewAttachKeyRef.current === attachKey) {
        return;
      }
      // A previous layout-effect generation may still be completing. Serialize
      // physical guest adoption so an older response can never overwrite the
      // currently visible tab binding.
      if (browserWebviewAttachInFlightKeyRef.current !== null) {
        scheduleAttachRetry();
        return;
      }
      browserWebviewAttachInFlightKeyRef.current = attachKey;
      // Publish the requested lease before IPC. attachWebview() emits browser
      // state synchronously from main, so waiting for its Promise to resolve
      // would let React clean this effect up and immediately submit it again.
      browserWebviewAttachKeyRef.current = attachKey;
      const finishAttachment = (state: ThreadBrowserState | null) => {
        if (browserWebviewAttachInFlightKeyRef.current === attachKey) {
          browserWebviewAttachInFlightKeyRef.current = null;
        }
        if (!state) {
          if (browserWebviewAttachKeyRef.current === attachKey) {
            browserWebviewAttachKeyRef.current = null;
          }
          if (
            !cancelled &&
            browserWebviewRef.current === webview &&
            browserWebviewTabIdRef.current === activeTabId
          ) {
            scheduleAttachRetry();
          }
          return;
        }
        // A tab switch can supersede this request while IPC is in flight. Main
        // processes invokes in order, and the current effect will bind the new
        // tab next; never let the stale completion rewrite its renderer lease.
        if (
          browserWebviewRef.current === webview &&
          browserWebviewTabIdRef.current === activeTabId
        ) {
          browserWebviewAttachKeyRef.current = attachKey;
          upsertThreadState(state);
        }
      };
      void api.browser
        .attachWebview({
          threadId,
          tabId: activeTabId,
          webContentsId,
        })
        .then(finishAttachment, () => finishAttachment(null));
    };
    const attachVisibleWebview = () => {
      if (cancelled || attachHandoffInFlight) {
        return;
      }
      attachHandoffInFlight = true;
      void browserPanelRendererHandoff.waitForDetach(threadId).then(() => {
        attachHandoffInFlight = false;
        attachVisibleWebviewNow();
      });
    };

    const handleRendererLoss = createBrowserRendererLossHandler({
      renderer: webview,
      rendererGeneration: browserRendererGeneration,
      tabId: activeTabId,
      isCurrent: (candidate) =>
        browserWebviewRef.current === candidate && browserWebviewTabIdRef.current === activeTabId,
      detach: detachRendererBrowserWebview,
      recover: ({ generation }) => {
        setBrowserRendererGeneration((current) => Math.max(current + 1, generation));
      },
    });

    // Subscribe before assigning src: a cached/blank page may begin loading
    // synchronously, before getWebContentsId() becomes available. The bounded
    // backoff below makes that renderer-to-main handshake reliable even while
    // Electron throttles requestAnimationFrame in the background.
    webview.addEventListener("dom-ready", attachVisibleWebview);
    webview.addEventListener("did-start-loading", attachVisibleWebview);
    webview.addEventListener("render-process-gone", handleRendererLoss);
    webview.addEventListener("destroyed", handleRendererLoss);
    if (shouldLoadInitialUrl) {
      webview.setAttribute(
        "src",
        browserWebviewInitialUrl(initialUrl.length > 0 ? initialUrl : BROWSER_BLANK_URL),
      );
    }
    attachVisibleWebview();

    return () => {
      cancelled = true;
      if (attachRetryTimer !== null) {
        window.clearTimeout(attachRetryTimer);
      }
      webview.removeEventListener("dom-ready", attachVisibleWebview);
      webview.removeEventListener("did-start-loading", attachVisibleWebview);
      webview.removeEventListener("render-process-gone", handleRendererLoss);
      webview.removeEventListener("destroyed", handleRendererLoss);
    };
  }, [
    activeTabId,
    api,
    browserRendererGeneration,
    detachRendererBrowserWebview,
    isLiveRuntime,
    isFloatingMode,
    showLocalServersHome,
    threadId,
    upsertThreadState,
    usesNativeRuntime,
    rendererHasPopup,
    workspaceReady,
  ]);

  useLayoutEffect(() => {
    return () => {
      detachRendererBrowserWebview();
    };
  }, [detachRendererBrowserWebview]);

  useEffect(() => {
    const liveTabIds = new Set(threadBrowserState?.tabs.map((tab) => tab.id) ?? []);
    for (const tabId of addressDraftsByTabIdRef.current.keys()) {
      if (!liveTabIds.has(tabId)) {
        addressDraftsByTabIdRef.current.delete(tabId);
        lastSyncedAddressByTabIdRef.current.delete(tabId);
      }
    }
  }, [threadBrowserState?.tabs]);

  useEffect(() => {
    if (!isLiveRuntime || !isBrowserPerfLoggingEnabled()) {
      return;
    }

    const intervalId = window.setInterval(() => {
      console.info(`[${MOSS_BROWSER_LABEL} panel perf]`, {
        threadId,
        ...perfCountersRef.current,
      });
    }, BROWSER_PERF_SAMPLE_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLiveRuntime, threadId]);

  useLayoutEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    const element = browserViewportRef.current;
    if (!element) {
      return;
    }

    const syncBounds = () => {
      perfCountersRef.current.syncAttempts += 1;
      // While the local-servers home is up, force the browser surface hidden instead of
      // trusting the obscuring-overlay heuristic. The native/inline webview otherwise paints
      // about:blank white over our dark DOM home — the "always white" empty state.
      const obscuredByOverlay =
        (!isFloatingMode || usesNativeRuntime) &&
        (browserPageError !== null ||
          shouldOccludeBrowserWebview({
            showLocalServersHome,
            browserActionsMenuOpen: false,
            // Drawing covers the page with its still, so the live view steps aside.
            hasObscuringOverlay:
              sketchCoversPage ||
              showBrowserAddressSuggestions ||
              hasNativeBrowserObscuringOverlay(element),
          }));
      const wasObscured = lastOverlayObscuredRef.current;
      lastOverlayObscuredRef.current = obscuredByOverlay;
      setIsBrowserSurfaceOccluded(usesNativeRuntime && obscuredByOverlay);
      setBrowserWebviewOverlayOcclusion(browserWebviewRef.current, obscuredByOverlay);
      const webview = browserWebviewRef.current;
      const stage = browserWebviewStageRef.current;
      if (stage) {
        applyBrowserWebviewPresentation(stage, {
          floating: isFloatingMode,
          slotWidth: element.clientWidth,
          slotHeight: element.clientHeight,
          viewport: viewportPreset,
        });
      } else if (webview) {
        applyBrowserWebviewPresentation(webview, {
          floating: isFloatingMode,
          slotWidth: element.clientWidth,
          slotHeight: element.clientHeight,
          viewport: viewportPreset,
        });
      }
      const rect = element.getBoundingClientRect();
      const presentation = resolveBrowserRuntimePresentation({
        native: usesNativeRuntime,
        floating: isFloatingMode,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        desktopZoom: readDesktopZoomFactor(),
        viewport: viewportPreset,
      });
      const bounds =
        obscuredByOverlay || rect.width <= 0 || rect.height <= 0 ? null : presentation.bounds;
      const { surface, pageZoomFactor } = presentation;
      const nextKey = bounds
        ? `${surface}:${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}:zoom-${pageZoomFactor}:preview-${isFloatingMode}`
        : `${surface}:hidden:zoom-${pageZoomFactor}:preview-${isFloatingMode}`;
      lastMeasuredBoundsKeyRef.current = nextKey;
      if (lastSentBoundsRef.current === nextKey) {
        perfCountersRef.current.syncSkips += 1;
        return;
      }
      lastSentBoundsRef.current = nextKey;
      perfCountersRef.current.syncSends += 1;
      const send = () => {
        markBrowserPerf(bounds ? "moss-browser-page-shown" : "moss-browser-page-hidden");
        void api.browser
          .setPanelBounds({
            threadId,
            bounds,
            surface,
            pageZoomFactor,
            occluded: obscuredByOverlay,
            preview: isFloatingMode,
          })
          .catch(ignoreBrowserBoundsSyncError);
      };
      pendingCoverTokenRef.current += 1;
      // A menu or popover just opened over the page. The native page paints above the DOM,
      // so it has to step aside; first put a still of it in its place (kept fresh while the
      // page rests) and hide it only after that still has painted. Hiding first showed the
      // empty slot for a frame or two: the flash on every menu.
      const startsCovering =
        usesNativeRuntime &&
        bounds === null &&
        obscuredByOverlay &&
        !wasObscured &&
        !isFloatingMode &&
        browserPageError === null &&
        !showLocalServersHome &&
        activeTabIdRef.current !== null;
      if (!startsCovering) {
        send();
        return;
      }
      const token = pendingCoverTokenRef.current;
      const hideWhenStillCovered = () => {
        if (
          pendingCoverTokenRef.current !== token ||
          lastMeasuredBoundsKeyRef.current !== nextKey
        ) {
          return;
        }
        send();
      };
      const afterStillPaints = () =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(hideWhenStillCovered));
      if (previewFrameRef.current?.tabId === activeTabIdRef.current) {
        // The still is already painted under the page.
        hideWhenStillCovered();
        return;
      }
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        afterStillPaints();
      };
      window.setTimeout(settle, BROWSER_COVER_STILL_WAIT_MS);
      void requestRestingFrameRef.current(true).finally(settle);
    };

    // The panel can slide horizontally without resizing. A short burst keeps the
    // native browser view in lockstep without paying for a long frame-by-frame loop.
    const syncBoundsBurst = (frames = BROWSER_BOUNDS_SYNC_BURST_FRAMES) => {
      if (boundsBurstFrameRef.current !== null) {
        perfCountersRef.current.burstExtensions += 1;
        burstFramesRemainingRef.current = Math.max(burstFramesRemainingRef.current, frames);
        burstStableFramesRef.current = 0;
        return;
      }

      perfCountersRef.current.burstStarts += 1;
      burstFramesRemainingRef.current = frames;
      burstStableFramesRef.current = 0;
      const tick = () => {
        perfCountersRef.current.burstFrames += 1;
        const previousMeasuredKey = lastMeasuredBoundsKeyRef.current;
        syncBounds();
        const measuredHidden = lastMeasuredBoundsKeyRef.current
          ? isBrowserPanelBoundsHiddenKey(lastMeasuredBoundsKeyRef.current)
          : false;
        if (!measuredHidden && lastMeasuredBoundsKeyRef.current === previousMeasuredKey) {
          burstStableFramesRef.current += 1;
        } else {
          burstStableFramesRef.current = 0;
        }
        burstFramesRemainingRef.current -= 1;
        if (
          burstFramesRemainingRef.current > 0 &&
          burstStableFramesRef.current < BROWSER_BOUNDS_SYNC_STABLE_FRAME_TARGET
        ) {
          boundsBurstFrameRef.current = window.requestAnimationFrame(tick);
          return;
        }
        boundsBurstFrameRef.current = null;
        burstFramesRemainingRef.current = 0;
        burstStableFramesRef.current = 0;
      };

      boundsBurstFrameRef.current = window.requestAnimationFrame(tick);
    };

    const scheduleSyncBounds = () => {
      perfCountersRef.current.resizeSchedules += 1;
      if (resizeFrameRef.current !== null) {
        perfCountersRef.current.resizeScheduleSkips += 1;
        return;
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        syncBounds();
      });
    };

    const handleTransitionBounds = (event: TransitionEvent) => {
      if (!isNativeBrowserTransitionSignalTarget(event.target, element)) {
        perfCountersRef.current.ignoredTransitionSignals += 1;
        return;
      }

      if (
        event.propertyName.length > 0 &&
        !VIEWPORT_TRANSITION_PROPERTIES.has(event.propertyName)
      ) {
        perfCountersRef.current.ignoredTransitionSignals += 1;
        return;
      }

      perfCountersRef.current.transitionSignals += 1;
      scheduleSyncBounds();
      if (event.type === "transitionrun") {
        syncBoundsBurst();
      }
    };

    syncBounds();
    syncBoundsBurst();
    const observer = new ResizeObserver(() => {
      scheduleSyncBounds();
    });
    observer.observe(element);
    // A zoom change moves the slot on the DIP grid. It usually reflows the panel too
    // (so the observer above fires), but a slot with a fixed CSS px size keeps its
    // measured rect and would otherwise strand the native view at the old scale.
    const unsubscribeZoom = subscribeDesktopZoomFactor(scheduleSyncBounds);
    window.addEventListener("resize", scheduleSyncBounds);
    window.addEventListener(BROWSER_PANEL_BOUNDS_SYNC_EVENT, scheduleSyncBounds);
    window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, scheduleSyncBounds);
    document.addEventListener("transitionrun", handleTransitionBounds, true);
    document.addEventListener("transitionend", handleTransitionBounds, true);
    document.addEventListener("transitioncancel", handleTransitionBounds, true);

    return () => {
      setBrowserWebviewOverlayOcclusion(browserWebviewRef.current, false);
      observer.disconnect();
      unsubscribeZoom();
      window.removeEventListener("resize", scheduleSyncBounds);
      window.removeEventListener(BROWSER_PANEL_BOUNDS_SYNC_EVENT, scheduleSyncBounds);
      window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, scheduleSyncBounds);
      document.removeEventListener("transitionrun", handleTransitionBounds, true);
      document.removeEventListener("transitionend", handleTransitionBounds, true);
      document.removeEventListener("transitioncancel", handleTransitionBounds, true);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (boundsBurstFrameRef.current !== null) {
        cancelAnimationFrame(boundsBurstFrameRef.current);
        boundsBurstFrameRef.current = null;
      }
      burstFramesRemainingRef.current = 0;
      burstStableFramesRef.current = 0;
    };
  }, [
    api,
    browserPageError,
    isLiveRuntime,
    isFloatingMode,
    showBrowserAddressSuggestions,
    showLocalServersHome,
    sketchCoversPage,
    threadId,
    usesNativeRuntime,
    viewportPreset,
  ]);

  // Main creates a page's native view when the page starts loading, which can be after
  // this panel last sent its bounds (opening a server from the new-tab page, say). Send
  // them again whenever the shown page changes, so the view always lands in its slot.
  const activePageKey = activeTab
    ? `${activeTab.id}:${activeTab.runtimeSurface ?? ""}:${activeTab.status}:${activeTab.lastCommittedUrl ?? ""}`
    : "";
  useEffect(() => {
    if (!isLiveRuntime || activePageKey.length === 0) return;
    lastSentBoundsRef.current = null;
    requestBrowserPanelBoundsSync();
  }, [activePageKey, isLiveRuntime]);

  useEffect(() => {
    if (
      !api ||
      !isLiveRuntime ||
      !workspaceReady ||
      (!isFloatingMode && !isBrowserSurfaceOccluded) ||
      !usesNativeRuntime ||
      !activeTabId ||
      showLocalServersHome ||
      browserPageError !== null
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = async () => {
      try {
        if (!document.hidden) {
          const src = await api.browser.capturePreview?.({ threadId, tabId: activeTabId });
          if (!cancelled && typeof src === "string" && src) {
            setPreviewFrame({ tabId: activeTabId, src });
          }
        }
      } catch {
        // A navigation or closing tab can invalidate a frame; retry without
        // disturbing the live page or surfacing a transient capture error.
      } finally {
        if (!cancelled) timer = setTimeout(capture, 500);
      }
    };
    void capture();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    api,
    isLiveRuntime,
    workspaceReady,
    isFloatingMode,
    isBrowserSurfaceOccluded,
    usesNativeRuntime,
    activeTabId,
    threadId,
    showLocalServersHome,
    browserPageError,
  ]);

  // Resting stills: while the page is on screen, keep a recent still of it (Claude keeps a
  // "warm" frame the same way). A menu opening over the page then shows that still at once
  // instead of an empty slot. Main answers null when nothing changed, so a quiet page costs
  // a pixel compare every few seconds.
  const restingFrameActive =
    api !== null &&
    isLiveRuntime &&
    workspaceReady &&
    usesNativeRuntime &&
    !isFloatingMode &&
    !isBrowserSurfaceOccluded &&
    activeTabId !== null &&
    !showLocalServersHome &&
    browserPageError === null;
  useEffect(() => {
    if (!restingFrameActive || !api || !activeTabId) {
      requestRestingFrameRef.current = () => Promise.resolve(false);
      return;
    }
    const tabId = activeTabId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = BROWSER_RESTING_FRAME_FIRST_MS;
    let inFlight: Promise<boolean> | null = null;
    const captureNow = (force = false): Promise<boolean> => {
      if (inFlight && !force) return inFlight;
      const request = (async () => {
        try {
          const src = await api.browser.capturePreview?.({
            threadId,
            tabId,
            ifChanged: true,
            ...(force ? { force: true } : {}),
          });
          if (cancelled || typeof src !== "string" || !src) {
            markBrowserPerf("moss-browser-resting-still-unchanged");
            return false;
          }
          markBrowserPerf("moss-browser-resting-still");
          setPreviewFrame({ tabId, src });
          return true;
        } catch {
          return false;
        }
      })();
      inFlight = request;
      void request.finally(() => {
        if (inFlight === request) inFlight = null;
      });
      return request;
    };
    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(() => void tick(), BROWSER_RESTING_FRAME_IDLE_MAX_MS);
        return;
      }
      // Main only answers "unchanged" against its own last still; without a still of this
      // tab here (a reload, another tab) ask for one outright.
      const changed = await captureNow(previewFrameRef.current?.tabId !== tabId);
      if (cancelled) return;
      delay = changed
        ? BROWSER_RESTING_FRAME_ACTIVE_MS
        : Math.min(delay * 2, BROWSER_RESTING_FRAME_IDLE_MAX_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    requestRestingFrameRef.current = (force) => captureNow(force === true);
    timer = setTimeout(() => void tick(), BROWSER_RESTING_FRAME_FIRST_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      requestRestingFrameRef.current = () => Promise.resolve(false);
    };
  }, [activePageKey, activeTabId, api, restingFrameActive, threadId]);

  // The pointer reaching the panel's own bar (on its way to a menu) refreshes the still,
  // so what shows under the menu is the page as it is now.
  const markStillPainted = useCallback((element: HTMLImageElement | null) => {
    if (element) window.requestAnimationFrame(() => markBrowserPerf("moss-browser-still-painted"));
  }, []);

  const refreshRestingFrameSoon = useCallback(() => {
    void requestRestingFrameRef.current(previewFrameRef.current?.tabId !== activeTabIdRef.current);
  }, []);

  useEffect(() => {
    if (isBrowserSurfaceOccluded) {
      setHoldingPreviewFrame(true);
      return;
    }
    if (!holdingPreviewFrame) return;
    const timer = window.setTimeout(
      () => setHoldingPreviewFrame(false),
      BROWSER_PREVIEW_FRAME_HOLD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [holdingPreviewFrame, isBrowserSurfaceOccluded]);

  const onSubmitAddress = useCallback(() => {
    if (!ensureLiveRuntime()) {
      return;
    }
    if (!api || !activeTab) {
      return;
    }
    isAddressEditingRef.current = false;
    setIsAddressFocused(false);
    // Hand focus back to the page, as a browser does once an address is entered.
    addressInputRef.current?.blur();
    // A local page shows as its short name; submitting that unchanged reloads the page
    // rather than searching the web for the name.
    const shownValue = browserAddressEditValue(activeTab.url, workspaceRoot);
    const pageUnchanged =
      browserAddressDisplay(activeTab.url).kind === "file" && addressValue.trim() === shownValue;
    const normalizedAddress = pageUnchanged
      ? activeTab.url
      : normalizeBrowserAddressInput(addressValue);
    addressDraftsByTabIdRef.current.set(
      activeTab.id,
      pageUnchanged ? shownValue : normalizedAddress,
    );
    setAddressValue(pageUnchanged ? shownValue : normalizedAddress);
    void runBrowserAction(() =>
      pageUnchanged
        ? api.browser.reload({ threadId, tabId: activeTab.id })
        : api.browser.navigate({
            threadId,
            tabId: activeTab.id,
            url: normalizedAddress,
          }),
    ).then((state) => {
      if (state) {
        upsertThreadState(state);
      }
    });
  }, [
    activeTab,
    addressValue,
    api,
    ensureLiveRuntime,
    runBrowserAction,
    threadId,
    upsertThreadState,
    workspaceRoot,
  ]);

  const onReloadActiveTab = useCallback(() => {
    if (!ensureLiveRuntime() || !api || !activeTab) {
      return;
    }
    void runBrowserAction(() => api.browser.reload({ threadId, tabId: activeTab.id })).then(
      (state) => {
        if (state) {
          upsertThreadState(state);
        }
      },
    );
  }, [activeTab, api, ensureLiveRuntime, runBrowserAction, threadId, upsertThreadState]);

  const onSelectTab = useCallback(
    (tabId: string): Promise<ThreadBrowserState | null> => {
      if (!ensureLiveRuntime() || !api) {
        return Promise.resolve(null);
      }
      return runBrowserAction(() => api.browser.selectTab({ threadId, tabId })).then((state) => {
        if (state) {
          upsertThreadState(state);
        }
        return state;
      });
    },
    [api, ensureLiveRuntime, runBrowserAction, threadId, upsertThreadState],
  );

  const onChooseSuggestion = useCallback(
    (suggestion: BrowserAddressSuggestion) => {
      if (!api) {
        return;
      }
      if (!ensureLiveRuntime()) {
        return;
      }

      isAddressEditingRef.current = false;
      setIsAddressFocused(false);
      setAddressValue(suggestion.url);

      const tabId = suggestion.tabId;
      if (suggestion.kind === "tab" && typeof tabId === "string") {
        void onSelectTab(tabId).then(() => {
          window.requestAnimationFrame(() => {
            addressInputRef.current?.focus();
            addressInputRef.current?.select();
          });
        });
        return;
      }

      if (activeTab) {
        addressDraftsByTabIdRef.current.set(activeTab.id, suggestion.url);
      }

      void runBrowserAction(() =>
        api.browser.navigate({
          threadId,
          url: suggestion.url,
          ...(activeTab ? { tabId: activeTab.id } : {}),
        }),
      ).then((state) => {
        if (state) {
          upsertThreadState(state);
        }
      });
    },
    [activeTab, api, ensureLiveRuntime, onSelectTab, runBrowserAction, threadId, upsertThreadState],
  );

  const onCreateTab = useCallback(() => {
    if (!api) {
      return;
    }
    // Creating a tab never needs a live renderer: main records it (suspended when this
    // thread's panel is not attached) and the next bounds sync shows it. Wake a preview
    // pane instead of silently dropping the action until the user clicks twice.
    if (!isLiveRuntime) {
      requestLiveRuntime();
    }
    void runBrowserAction(() => api.browser.newTab({ threadId, activate: true })).then((state) => {
      if (!state) {
        return;
      }
      upsertThreadState(state);
      setAddressSuggestionsSuppressed(true);
      window.requestAnimationFrame(() => {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      });
    });
  }, [api, isLiveRuntime, requestLiveRuntime, runBrowserAction, threadId, upsertThreadState]);

  const copyActiveTabLink = useCallback(() => {
    if (!activeTab) {
      return;
    }
    // Desktop: copy through the native Electron clipboard. navigator.clipboard can reject
    // with "Document is not focused" while the native browser view holds focus, so this
    // mirrors the keyboard chord — main writes the URL and emits onCopyLink, which surfaces
    // the toast in the listener below.
    if (isElectron && api) {
      void runBrowserAction(() => api.browser.copyLink({ threadId, tabId: activeTab.id }));
      return;
    }
    const url = resolveCopyableBrowserTabUrl(activeTab);
    if (!url) {
      return;
    }
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      return;
    }
    void clipboard.writeText(url).then(
      () => {
        toastManager.add({ type: "success", title: BROWSER_COPY_LINK_TOAST_TITLE });
      },
      () => {
        // Clipboard writes can reject without user gesture; nothing actionable to surface.
      },
    );
  }, [activeTab, api, runBrowserAction, threadId]);

  // React chrome focus path: the native page handles the chord through the desktop main
  // process, so this only fires when the address bar/tab strip (not the page) is focused.
  useEffect(() => {
    if (!isLiveRuntime) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const matches = isBrowserCopyLinkChord(
        {
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          key: event.key,
        },
        isMacNavigatorPlatform(),
      );
      if (!matches) {
        return;
      }
      event.preventDefault();
      copyActiveTabLink();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [copyActiveTabLink, isLiveRuntime]);

  // Native page focus path: main already wrote the URL to the clipboard, so just toast.
  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }
    return api.browser.onCopyLink((event) => {
      if (event.threadId !== threadId) {
        return;
      }
      toastManager.add({ type: "success", title: BROWSER_COPY_LINK_TOAST_TITLE });
    });
  }, [api, isLiveRuntime, threadId]);

  // The dock's "+" (or the standalone header's) asks for a new tab with the address field
  // focused, the same as the panel's own new-tab action.
  useEffect(() => {
    const onNewTabRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId === threadId) onCreateTab();
    };
    window.addEventListener(BROWSER_NEW_TAB_REQUEST_EVENT, onNewTabRequest);
    return () => window.removeEventListener(BROWSER_NEW_TAB_REQUEST_EVENT, onNewTabRequest);
  }, [onCreateTab, threadId]);

  // A local page tried to leave for a site that is not allowed; offer to allow it.
  useEffect(() => {
    const panelApi = api?.browser.panel;
    if (!panelApi || !isLiveRuntime) return;
    return panelApi.onBlockedNavigation((event) => {
      if (event.threadId !== threadId) return;
      setBlockedNavigation({ tabId: event.tabId, url: event.url });
    });
  }, [api, isLiveRuntime, threadId]);
  const visibleBlockedNavigation =
    blockedNavigation && blockedNavigation.tabId === activeTabId ? blockedNavigation : null;
  const blockedSite = (() => {
    if (!visibleBlockedNavigation) return "";
    try {
      return new URL(visibleBlockedNavigation.url).host || visibleBlockedNavigation.url;
    } catch {
      return visibleBlockedNavigation.url;
    }
  })();

  const runTabAction = (action: (tabId: string) => Promise<ThreadBrowserState>) => {
    if (!ensureLiveRuntime()) return;
    if (!api || !activeTab) return;
    void runBrowserAction(() => action(activeTab.id)).then((state) => {
      if (state) {
        upsertThreadState(state);
      }
    });
  };

  const addressDisplay = browserAddressDisplay(activeTab?.url, workspaceRoot);
  const showAddressOverlay =
    !isAddressFocused &&
    addressDisplay.kind !== "blank" &&
    addressValue === browserAddressEditValue(activeTab?.url, workspaceRoot);
  const addressOverlay = showAddressOverlay ? (
    <span
      aria-hidden
      data-browser-address-display=""
      className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-3 text-ui whitespace-nowrap"
    >
      <span className="flex min-w-0 max-w-full items-baseline" data-translation-skip="true">
        {addressDisplay.kind === "file" ? (
          <>
            <span className="min-w-0 shrink truncate text-muted-foreground">
              {addressDisplay.secondary}
            </span>
            <span className="shrink-0 text-foreground">{addressDisplay.primary}</span>
          </>
        ) : (
          <>
            <span className="shrink-0 text-foreground">{addressDisplay.primary}</span>
            <span className="min-w-0 shrink truncate text-muted-foreground">
              {addressDisplay.secondary}
            </span>
          </>
        )}
      </span>
    </span>
  ) : null;

  const addressRow = (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-1", mode === "floating" && "cursor-grab")}
      data-floating-browser-header={mode === "floating" ? "true" : undefined}
      data-browser-address-row=""
    >
      {/* Keep the browser chrome interactive inside Electron's draggable titlebar. */}
      <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.nav.back")}
          tooltip={t("browser.nav.back")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          disabled={!activeTab?.canGoBack}
          onClick={() => runTabAction((tabId) => api!.browser.goBack({ threadId, tabId }))}
        >
          <ArrowLeftIcon className="size-4" />
        </IconButton>
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.nav.forward")}
          tooltip={t("browser.nav.forward")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          disabled={!activeTab?.canGoForward}
          onClick={() => runTabAction((tabId) => api!.browser.goForward({ threadId, tabId }))}
        >
          <ArrowRightIcon className="size-4" />
        </IconButton>
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.nav.reload")}
          tooltip={t("browser.nav.reload")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          disabled={!activeTab}
          onClick={() => runTabAction((tabId) => api!.browser.reload({ threadId, tabId }))}
        >
          <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
        </IconButton>
      </div>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        <form
          className="relative min-w-0"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitAddress();
          }}
        >
          <input
            ref={addressInputRef}
            value={addressValue}
            aria-label={t("browser.address.label")}
            data-browser-address-input=""
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              if (!isLiveRuntime) {
                requestLiveRuntime();
              }
              const nextValue = event.target.value;
              isAddressEditingRef.current = true;
              setAddressSuggestionsSuppressed(false);
              setAddressValue(nextValue);
              if (activeTab) {
                addressDraftsByTabIdRef.current.set(activeTab.id, nextValue);
              }
            }}
            onFocus={(event) => {
              if (!isLiveRuntime) {
                requestLiveRuntime();
              }
              isAddressEditingRef.current = true;
              setIsAddressFocused(true);
              event.currentTarget.select();
            }}
            onBlur={() => {
              isAddressEditingRef.current = false;
              setIsAddressFocused(false);
              setAddressSuggestionsSuppressed(false);
            }}
            onMouseDown={() => {
              setAddressSuggestionsSuppressed(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                setAddressSuggestionsSuppressed(false);
              }
              if (event.key === "Escape") {
                event.currentTarget.blur();
              }
            }}
            placeholder={t("browser.address.placeholder")}
            className={cn(
              "h-7 w-full min-w-0 rounded-control border border-[color:var(--color-border)] bg-transparent px-3 text-ui text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-[color:var(--color-border-heavy)] focus:border-[color:var(--color-border-focus)] focus:bg-[var(--color-background-surface)]",
              showAddressOverlay ? "text-transparent caret-transparent" : "text-left",
            )}
          />
          {addressOverlay}
        </form>
        {showBrowserAddressSuggestions ? (
          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-popover border border-border bg-popover shadow-xl [-webkit-app-region:no-drag]">
            <div className="max-h-64 overflow-auto p-1">
              {browserAddressSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-ui leading-snug text-foreground transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onChooseSuggestion(suggestion);
                  }}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-background/80">
                    {suggestion.kind === "navigate" ? (
                      <ExternalLinkIcon className="size-3 text-muted-foreground" />
                    ) : suggestion.faviconUrl ? (
                      <img alt="" src={suggestion.faviconUrl} className="size-3 rounded-[2px]" />
                    ) : (
                      <GlobeIcon className="size-3 text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{suggestion.title}</span>
                    <span className="block truncate text-ui-sm text-muted-foreground">
                      {suggestion.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
        <BrowserAnnotationButton
          controller={sketchButtonController}
          disabled={!annotationAvailable}
        />
      </div>
    </div>
  );

  // The panel's own header row, as on the desktop: page tabs with "+", then the servers
  // button, "…", expand and close. The address row sits under it.
  const expandLabel = layout?.expanded ? t("rightDock.restorePanel") : t("rightDock.expandPanel");
  const panelTabRow = !isFloatingMode ? (
    <div
      className="flex min-w-0 flex-1 items-center gap-1"
      data-browser-tab-row=""
      data-browser-chrome={chrome}
      onPointerEnter={refreshRestingFrameSoon}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden">
        <BrowserPageTabs threadId={threadId} active onLastTabClosed={onClosePanel} />
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.tabs.newTab")}
          tooltip={t("browser.tabs.newTab")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          data-browser-new-tab=""
          onClick={onCreateTab}
        >
          <PlusIcon className="size-4" />
        </IconButton>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <BrowserServersMenu
          projectId={projectId}
          workspaceRoot={workspaceRoot}
          onOpen={openInThisBrowser}
          onEditFile={onViewSource}
        />
        <BrowserPanelMenu threadId={threadId} onViewSource={onViewSource} />
        {layout ? (
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={expandLabel}
            tooltip={expandLabel}
            tooltipSide="bottom"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            aria-pressed={layout.expanded}
            data-browser-expand=""
            onClick={layout.onToggleExpanded}
          >
            {layout.expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </IconButton>
        ) : null}
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.panel.close")}
          tooltip={t("browser.panel.close")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          data-browser-close=""
          onClick={onClosePanel}
        >
          <XIcon className="size-4" />
        </IconButton>
      </div>
    </div>
  ) : null;

  const shellHeader = isFloatingMode ? null : (panelTabRow ?? addressRow);
  const seamBesideChat = chrome === "dock" && !isFloatingMode && layout?.expanded !== true;
  const stillStandsInForPage = isFloatingMode || isBrowserSurfaceOccluded || holdingPreviewFrame;
  const viewportFrameActive = viewportPreset !== null && !isFloatingMode;

  if (!api && isLiveRuntime) {
    return (
      <div className="contents" data-browser-panel="true">
        <DiffPanelShell mode={mode} header={shellHeader}>
          <DiffPanelLoadingState label={t("browser.unavailable")} />
        </DiffPanelShell>
      </div>
    );
  }

  return (
    <div className="contents" data-browser-panel="true">
      <DiffPanelShell mode={mode} header={shellHeader}>
        <div className="flex min-h-0 flex-1 flex-col">
          {panelTabRow ? (
            <div
              className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "gap-1.5 px-1.5")}
              onPointerEnter={refreshRestingFrameSoon}
            >
              {addressRow}
            </div>
          ) : null}
          {localError ? (
            // Why the last browser action did not happen (a failed capture, a tab that
            // could not open). Page load errors show over the page instead.
            <div
              role="alert"
              data-browser-action-error=""
              className="flex shrink-0 items-center gap-2 border-border/70 border-b bg-[color-mix(in_srgb,var(--destructive)_6%,var(--background))] px-3 py-1.5 text-ui"
            >
              <CircleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={localError}>
                {localError}
              </span>
              <IconButton
                variant="ghost"
                size="icon-xs"
                label={t("browser.blocked.dismiss")}
                onClick={() => setLocalError(null)}
              >
                <XIcon className="size-4" />
              </IconButton>
            </div>
          ) : null}
          {visibleBlockedNavigation ? (
            // A strip above the page, not over it: a native page view paints above any
            // web content laid over it.
            <div
              role="status"
              data-browser-blocked-navigation=""
              className="flex shrink-0 items-center gap-2 border-border/70 border-b bg-[color-mix(in_srgb,var(--warning)_8%,var(--background))] px-3 py-1.5 text-ui"
            >
              <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1 truncate" data-translation-skip="true">
                {format("browser.blocked.message", { site: blockedSite })}
              </span>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  const panelApi = api?.browser.panel;
                  const target = visibleBlockedNavigation;
                  setBlockedNavigation(null);
                  if (!panelApi) return;
                  void runBrowserAction(() =>
                    panelApi.allowNavigation({
                      threadId,
                      tabId: target.tabId,
                      url: target.url,
                    }),
                  ).then((state) => {
                    if (state) upsertThreadState(state);
                  });
                }}
              >
                {t("browser.blocked.allow")}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setBlockedNavigation(null)}>
                {t("browser.blocked.dismiss")}
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              "relative min-h-0 flex-1 bg-transparent",
              // Beside the chat the page leaves a hairline strip free at the divider: a native
              // page view takes every pointer event over it, and the divider's grip must be
              // reachable from this side too.
              seamBesideChat && "ml-[6px]",
            )}
            data-browser-page-area=""
          >
            {!isLiveRuntime ? (
              <BrowserRuntimePreview
                title={activeTab?.title || t("browser.sleeping")}
                detail={activeTab?.lastCommittedUrl ?? activeTab?.url ?? t("browser.restoring")}
              />
            ) : !workspaceReady ? (
              <div className="absolute inset-0 z-10">
                <DiffPanelLoadingState label={t("browser.starting")} />
              </div>
            ) : null}
            {isLiveRuntime ? (
              <div
                ref={browserViewportRef}
                data-browser-viewport=""
                data-floating-browser-viewport={isFloatingMode ? "true" : undefined}
                data-browser-viewport-preset={viewportPreset?.id}
                className={cn(
                  "absolute overflow-hidden",
                  // Paper behind the page: what shows while it loads, or while a menu
                  // over it makes the native view step aside.
                  isFloatingMode
                    ? "bg-transparent"
                    : viewportFrameActive
                      ? "bg-[color-mix(in_srgb,var(--foreground)_6%,var(--background))]"
                      : "bg-[var(--color-background-surface)]",
                  isFloatingMode && "rounded-card [clip-path:inset(0_round_10px)]",
                  "inset-0",
                )}
              />
            ) : null}
            {isLiveRuntime && browserPageError ? (
              <BrowserRuntimeError message={browserPageError} onReload={onReloadActiveTab} />
            ) : null}
            {/* The page's latest still sits under the live page all the time (the native view
                paints above it), so a menu that covers the page uncovers that still on the very
                frame the page steps aside — no render to wait for, nothing empty in between. */}
            {(isFloatingMode ||
              isBrowserSurfaceOccluded ||
              holdingPreviewFrame ||
              restingFrameActive) &&
            usesNativeRuntime &&
            !showLocalServersHome &&
            !browserPageError &&
            previewFrame?.tabId === activeTabId ? (
              <BrowserViewportFrameBox
                viewportRef={browserViewportRef}
                preset={isFloatingMode ? null : viewportPreset}
                className="pointer-events-none"
              >
                <img
                  src={previewFrame.src}
                  // Under the live page it is decoration; it stands in for the page only
                  // while something covers the page.
                  alt={stillStandsInForPage ? t("browser.previewAlt") : ""}
                  aria-hidden={stillStandsInForPage ? undefined : true}
                  draggable={false}
                  data-browser-page-still=""
                  ref={markStillPainted}
                  className="h-full w-full select-none object-contain"
                />
              </BrowserViewportFrameBox>
            ) : null}
            {showLocalServersHome ? (
              <LaunchServersPage servers={launchServers} onEditFile={onViewSource} />
            ) : null}
            {sketch.coversPage ? (
              <BrowserViewportFrameBox
                viewportRef={browserViewportRef}
                preset={viewportPreset}
                className="z-20"
              >
                <BrowserSketchOverlay
                  pageImageUrl={sketch.pageImageUrl}
                  tool={sketch.tool}
                  style={sketch.style}
                  marks={sketch.marks}
                  onAddMark={sketch.addMark}
                />
              </BrowserViewportFrameBox>
            ) : null}
          </div>
          {sketch.open && !isFloatingMode ? (
            // A strip under the page, not over it: a native page view paints above any
            // web content laid over it.
            <div
              data-browser-sketch-strip=""
              className="flex h-12 shrink-0 items-center justify-center bg-[color-mix(in_srgb,var(--foreground)_3%,var(--background))] px-3"
            >
              <BrowserSketchToolbar
                tool={sketch.tool}
                onToolChange={sketch.setTool}
                selectAvailable={elementPickAvailable}
                canUndo={sketch.canUndo}
                canRedo={sketch.canRedo}
                hasMarks={sketch.marks.length > 0}
                expanded={sketch.expanded}
                style={sketch.style}
                onStyleChange={sketch.setStyle}
                adding={sketch.adding}
                confirmingDiscard={sketch.confirmingDiscard}
                onUndo={sketch.undo}
                onRedo={sketch.redo}
                onClear={sketch.clear}
                onAddToChat={sketch.addToChat}
                onRequestClose={sketch.requestClose}
                onCancelDiscard={sketch.cancelDiscard}
                onDiscard={sketch.close}
              />
            </div>
          ) : null}
        </div>
      </DiffPanelShell>
    </div>
  );
}

/**
 * Lays its child over the page itself: the whole page area, or the device frame while a
 * viewport preset is set.
 */
function BrowserViewportFrameBox(props: {
  readonly viewportRef: { readonly current: HTMLDivElement | null };
  readonly preset: ReturnType<typeof findBrowserViewportPreset>;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [slot, setSlot] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = props.viewportRef.current;
    if (!element || !props.preset) return;
    const measure = () => setSlot({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.preset, props.viewportRef]);
  const frame = resolveBrowserViewportFrame(slot, props.preset);
  return (
    <div
      className={cn("absolute", props.className)}
      style={
        frame
          ? { left: frame.x, top: frame.y, width: frame.width, height: frame.height }
          : { inset: 0 }
      }
    >
      {props.children}
    </div>
  );
}

export default BrowserPanel;
