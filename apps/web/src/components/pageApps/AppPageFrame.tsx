// FILE: AppPageFrame.tsx
// Purpose: Shows one 应用页: a calm Moss shell (title dropdown pill, capsule install
//          action, and `···` overflow menu) around the page, which runs in a
//          sandboxed iframe on its own origin.
// Modes: "full" (its own view), "embed" (inside a page; sizes to content),
//        "guest" (shared view; reduced capabilities), and standalone (`chrome="none"`).
// Layer: Web pageApps

import type {
  DesktopPageAppMenuOffer,
  DesktopPageAppsBridge,
  InstalledDesktopPageApp,
  PageAppFrameMode,
  PageAppId,
  PageAppsOpenFrameResult,
  PageAppShellMessage,
  PageAppStoredConsent,
  PageAppVersion,
  ThreadId,
} from "@moss/contracts";
import type {
  PageAppConfirmRequest,
  PageAppConfirmResult,
} from "@moss/shared/pageAppCapabilityPlugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BrowserAnnotationButton } from "~/components/BrowserPanel";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { PageCommentsLayer } from "~/components/chat/pageComments/PageComments";
import { MarkupCanvas } from "~/components/markup/MarkupCanvas";
import { MarkupToolbar } from "~/components/markup/MarkupToolbar";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import type { SpaceCanvasDockController } from "~/components/space/spaceCanvasDockContract";
import { SpaceInlineRename } from "~/components/space/SpaceInlineRename";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { StatusDot } from "~/components/ui/status-chip";
import { useComposerDraftStore } from "~/composerDraftStore";
import { createPastedTextDraft } from "~/lib/composerPastedText";
import {
  AppsIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderOpenIcon,
  HistoryIcon,
  LockIcon,
  MoreHorizontalIcon,
  PageCommentIcon,
  PencilIcon,
  PinIcon,
  PopOutIcon,
  RefreshCwIcon,
  SlidersIcon,
  SparklesIcon,
  StarFilledIcon,
  StarIcon,
  TrashCanIcon,
  WindowAppIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { newPageCommentId, usePageComments, usePageCommentsStore } from "~/pageCommentsStore";
import { useThreadSendRequestStore } from "~/threadSendRequestStore";

import { PageAppBroker, type PageAppConsentPrompt, type PageAppFrameSelection } from "./broker";
import { PAGE_APP_SHELL_PLUGINS } from "./capabilities";
import {
  getDesktopNativePane,
  getDesktopPageAppsBridge,
  readDeclaredDesktopPermissions,
  readTransparentFromWindowPayload,
} from "./capabilities/desktop";
import { openPageAppCommentComposer, PageAppSelectionBubble } from "./PageAppCommentComposer";
import { generateAndSavePageAppCover } from "./pageAppCover";
import { pageAppsClient } from "./pageAppsClient";
import { createPageAppThumbnailCapture } from "./pageAppThumbnailCapture";
import { usePageAppMarkup } from "./usePageAppMarkup";

export interface AppPageFrameProps {
  readonly appPageId: string;
  readonly mode: "full" | "embed" | "guest";
  readonly height?: number;
  readonly className?: string;
  /**
   * The frame is its own route, so its header is the window's top bar: it takes the shared
   * route top bar, which drags the window and clears the window buttons and traffic lights.
   */
  readonly topBar?: boolean;
  /** Standalone desktop window runtime: hides Moss chrome and keeps only a dismissible attribution pill. */
  readonly standalone?: boolean;
  readonly chrome?: "default" | "none";
  readonly transparent?: boolean;
  readonly dock?: SpaceCanvasDockController | null | undefined;
  readonly hostThreadId?: ThreadId | null | undefined;
  readonly onTitleChange?: ((title: string) => void) | undefined;
  readonly onCloseTab?: (() => void) | undefined;
  readonly onDeleted?: (() => void) | undefined;
}

const EMBED_MIN_HEIGHT = 120;
const EMBED_MAX_HEIGHT = 1_600;
const STANDALONE_SYNC_POLL_MS = 4_000;
const DECLINED: PageAppConfirmResult = { confirmed: false, remember: false };

interface ActiveMenuOfferEntry {
  readonly appId: string;
  readonly priority: number;
  readonly offer: DesktopPageAppMenuOffer;
}

const activeMenuOffers = new Map<symbol, ActiveMenuOfferEntry>();

function flushActiveMenuOffers(bridge: DesktopPageAppsBridge): void {
  const deduped = new Map<
    string,
    { readonly priority: number; readonly offer: DesktopPageAppMenuOffer }
  >();
  for (const entry of activeMenuOffers.values()) {
    const existing = deduped.get(entry.appId);
    if (!existing || entry.priority >= existing.priority) {
      deduped.set(entry.appId, { priority: entry.priority, offer: entry.offer });
    }
  }
  const offers = Array.from(deduped.values(), (item) => item.offer);
  void bridge.offerInMenu(offers).catch(() => undefined);
}

function isPrimaryMenuOfferOwner(key: symbol, appId: string): boolean {
  let winner: symbol | null = null;
  let winnerPriority = -1;
  for (const [entryKey, entry] of activeMenuOffers) {
    if (entry.appId !== appId) continue;
    if (winner === null || entry.priority > winnerPriority) {
      winner = entryKey;
      winnerPriority = entry.priority;
    }
  }
  return winner === null || winner === key;
}

type Pending<T, R> = { readonly request: T; readonly resolve: (value: R) => void } | null;

export function pageAppIframeSandbox(ownOrigin: boolean): string {
  // On its own origin the page may keep storage there; it still cannot reach
  // Moss's origin. On the opaque fallback it must never share Moss's origin.
  return ownOrigin
    ? "allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
    : "allow-scripts allow-forms allow-modals allow-popups";
}

export function formatStandaloneAttributionLabel(
  title: string | undefined,
  untitled: string,
  brand: string,
): string {
  const trimmed = title?.trim() || untitled;
  if (/\bmoss\b/i.test(trimmed) || trimmed.toLowerCase().startsWith(brand.toLowerCase())) {
    return trimmed;
  }
  return `${brand} · ${trimmed}`;
}

export function formatEditedCaption(
  updatedAt: string | undefined,
  locale: string,
  editedJustNow: string,
  formatEditedAgo: (when: string) => string,
  now = Date.now(),
): string | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  const minutes = Math.max(0, Math.round((now - parsed) / 60_000));
  if (minutes < 1) return editedJustNow;
  const isZh = locale.toLowerCase().startsWith("zh");
  if (minutes < 60) {
    return formatEditedAgo(
      isZh ? `${minutes} 分钟前` : `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`,
    );
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return formatEditedAgo(
      isZh ? `${hours} 小时前` : `${hours} ${hours === 1 ? "hour" : "hours"} ago`,
    );
  }
  const days = Math.round(hours / 24);
  return formatEditedAgo(isZh ? `${days} 天前` : `${days} ${days === 1 ? "day" : "days"} ago`);
}

export function AppPageFrame({
  appPageId,
  mode,
  height,
  className,
  topBar = false,
  standalone = false,
  chrome,
  transparent = false,
  dock = null,
  hostThreadId = null,
  onTitleChange,
  onCloseTab,
  onDeleted,
}: AppPageFrameProps) {
  const { locale, t, format } = useTranslation();
  const nativePane = getDesktopNativePane();
  const isStandalone = Boolean(standalone || chrome === "none" || nativePane?.chrome === "none");
  const paneTransparent = Boolean((nativePane as { transparent?: boolean } | null)?.transparent);
  const [liveTransparent, setLiveTransparent] = useState(
    Boolean(isStandalone && (transparent || paneTransparent)),
  );
  const isTransparent = Boolean(
    isStandalone && (transparent || paneTransparent || liveTransparent),
  );
  const desktopBridge = getDesktopPageAppsBridge();
  const [frame, setFrame] = useState<PageAppsOpenFrameResult | null>(null);
  // `message: null` is a failure without its own message; the frame names it in the UI language.
  const [failure, setFailure] = useState<{ readonly message: string | null } | null>(null);
  const error = failure ? (failure.message ?? t("pageApps.frame.openFailed")) : null;
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [consentPrompt, setConsentPrompt] = useState<Pending<PageAppConsentPrompt, boolean>>(null);
  const [confirmPrompt, setConfirmPrompt] =
    useState<Pending<PageAppConfirmRequest, PageAppConfirmResult>>(null);
  const [confirmRemember, setConfirmRemember] = useState(false);
  // Last shown requests, kept while a dialog animates closed so its text stays put.
  const [consentView, setConsentView] = useState<PageAppConsentPrompt | null>(null);
  const [confirmView, setConfirmView] = useState<PageAppConfirmRequest | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState<(() => void) | null>(null);
  const [consent, setConsent] = useState<Readonly<Record<string, PageAppStoredConsent>>>({});
  const [favorite, setFavorite] = useState(false);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [installedApp, setInstalledApp] = useState<InstalledDesktopPageApp | null>(null);
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const installingDesktop = installingAppId === appPageId;
  const [renaming, setRenaming] = useState(false);
  const [attributionDismissed, setAttributionDismissed] = useState(false);
  const [frameSelection, setFrameSelection] = useState<PageAppFrameSelection | null>(null);
  const [hasTopHeading, setHasTopHeading] = useState(false);
  const [versions, setVersions] = useState<readonly PageAppVersion[]>([]);
  const [pinningRevision, setPinningRevision] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [loadedFrameGen, setLoadedFrameGen] = useState(0);
  const [commentMode, setCommentMode] = useState(false);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [commentMarkersVisible, setCommentMarkersVisible] = useState(true);
  const [commentsMenuOpen, setCommentsMenuOpen] = useState(false);
  const frameBodyRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const brokerRef = useRef<PageAppBroker | null>(null);
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const hostThreadIdRef = useRef(hostThreadId);
  hostThreadIdRef.current = hostThreadId;
  const capturedFrameKey = useRef<string | null>(null);
  const appPageIdRef = useRef(appPageId);
  appPageIdRef.current = appPageId;
  const frameRef = useRef<PageAppsOpenFrameResult | null>(null);
  frameRef.current = frame;
  const failureRef = useRef<{ readonly message: string | null } | null>(null);
  failureRef.current = failure;
  const installedAppRef = useRef<InstalledDesktopPageApp | null>(null);
  installedAppRef.current = installedApp;
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const lastSyncedRevisionRef = useRef<number | null>(null);
  const reportedGoneRef = useRef<boolean>(false);
  const menuOfferKeyRef = useRef<symbol>(Symbol("page-app-menu-offer"));

  useEffect(() => {
    if (
      !frame ||
      frame.app.id !== appPageId ||
      !iframeRef.current ||
      frame.app.thumbnail !== null
    ) {
      return;
    }
    const key = `${appPageId}:${reloadKey}:${frame.frameUrl}`;
    if (loadedFrameKey !== key || capturedFrameKey.current === key) return;
    capturedFrameKey.current = key;
    const capture = createPageAppThumbnailCapture({
      element: iframeRef.current,
      frame,
      mode,
      save: (thumbnail, signal) =>
        pageAppsClient.mutate(
          {
            op: "set-thumbnail",
            requestId: crypto.randomUUID(),
            appId: frame.app.id,
            expectedRevision: frame.app.revision,
            thumbnail,
          },
          signal,
        ),
    });
    capture.loaded();
    return capture.dispose;
  }, [frame, appPageId, mode, reloadKey, loadedFrameKey]);

  useEffect(() => {
    let cancelled = false;
    setFrame(null);
    setLoadedFrameKey(null);
    setFailure(null);
    setFrameSelection(null);
    setCommentMode(false);
    setCommentsPanelOpen(false);
    pageAppsClient
      .openFrame({
        appId: appPageId as never,
        mode: mode as PageAppFrameMode,
        parentOrigin: window.location.origin,
      })
      .then((result) => {
        if (cancelled) return;
        setFrame(result);
        setConsent(result.consent);
        setFavorite(result.app.favorite);
        onTitleChangeRef.current?.(result.app.title);
      })
      .catch((cause: { message?: string }) => {
        if (!cancelled) setFailure({ message: cause?.message ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [appPageId, mode, reloadKey]);

  const askConsent = useCallback(
    (request: PageAppConsentPrompt) =>
      new Promise<boolean>((resolve) => {
        setConsentView(request);
        setConsentPrompt({ request, resolve });
      }),
    [],
  );
  const confirmChoice = useCallback(
    (request: PageAppConfirmRequest) =>
      new Promise<PageAppConfirmResult>((resolve) => {
        setConfirmView(request);
        setConfirmRemember(false);
        setConfirmPrompt({ request, resolve });
      }),
    [],
  );
  const confirm = useCallback(
    (request: PageAppConfirmRequest) => confirmChoice(request).then((result) => result.confirmed),
    [confirmChoice],
  );
  const openPermissions = useCallback(
    () => new Promise<void>((resolve) => setPermissionsOpen(() => resolve)),
    [],
  );

  const routeToMossConversation = useCallback(
    async (input: {
      readonly prompt?: string;
      readonly prefillOnly?: boolean;
      readonly quote?: string;
      readonly label?: string;
      readonly origin: "comment-mention" | "selection-bar" | "editor-bridge";
    }) => {
      const activeFrame = frameRef.current;
      const activeDock = dockRef.current;
      if (activeDock && activeFrame) {
        const selectionContext = input.quote
          ? {
              kind: "app" as const,
              itemId: activeFrame.app.id,
              title: activeFrame.app.title,
              quote: input.quote,
              summary: input.label ?? input.quote.slice(0, 60),
            }
          : null;
        await activeDock.ask({
          ...(input.prompt ? { prompt: input.prompt } : {}),
          prefillOnly: Boolean(input.prefillOnly),
          autoRun: !input.prefillOnly && Boolean(input.prompt?.trim()),
          keepItemOpen: true,
          preferredState: "pip",
          selection: selectionContext,
          origin: input.origin,
        });
        return {
          opened: true,
          mode: "sidechat" as const,
          ...(activeDock.activeThreadId ? { threadId: activeDock.activeThreadId } : {}),
        };
      }
      const tid = hostThreadIdRef.current;
      if (tid && activeFrame) {
        const quoteLine = input.quote ? `「${input.quote}」\n` : "";
        const formatted = input.prompt?.trim()
          ? `关于应用「${activeFrame.app.title}」${quoteLine ? `中的${quoteLine}` : "："}${input.prompt.trim()}`
          : "";
        if (!input.prefillOnly && formatted) {
          useThreadSendRequestStore.getState().request(tid, formatted);
        } else {
          const drafts = useComposerDraftStore.getState();
          if (input.quote) {
            drafts.addPastedTexts(tid, [
              createPastedTextDraft({
                id: `page-app:${activeFrame.app.id}:${Date.now()}`,
                createdAt: new Date().toISOString(),
                text: `引用自「${activeFrame.app.title}」：\n${input.quote}`,
              }),
            ]);
          }
          if (formatted) drafts.setPrompt(tid, formatted);
        }
        return { opened: true, mode: "sidechat" as const, threadId: tid };
      }
      return { opened: false, mode: "inline" as const };
    },
    [],
  );

  const openSelectionCommentComposer = useCallback(
    (sel: PageAppFrameSelection) => {
      const activeFrame = frameRef.current;
      const bodyEl = frameBodyRef.current;
      if (!activeFrame || !bodyEl) return;
      const box = bodyEl.getBoundingClientRect();
      const target = {
        left: box.left + sel.rect.x,
        top: box.top + sel.rect.y,
        width: sel.rect.width,
        height: sel.rect.height,
      };
      const anchor = {
        target: sel.anchor?.target || "selection",
        label: sel.anchor?.label || sel.text.slice(0, 48),
        x:
          box.width > 0 ? Math.min(1, Math.max(0, (sel.rect.x + sel.rect.width) / box.width)) : 0.5,
        y: box.height > 0 ? Math.min(1, Math.max(0, sel.rect.y / box.height)) : 0.5,
        quote: sel.text,
      };
      const pageKey = `page-app:${activeFrame.app.id}`;
      const canSendToMoss = Boolean(dockRef.current || hostThreadIdRef.current);
      const controller = new AbortController();
      void openPageAppCommentComposer({
        pageTitle: activeFrame.app.title,
        pageKey,
        anchor,
        target,
        canSendToMoss,
        defaultSendToAgent: canSendToMoss,
        signal: controller.signal,
        post: async (body, opts) => {
          const now = new Date().toISOString();
          const author = {
            name: activeFrame.viewer.name || "我",
            initials: (activeFrame.viewer.name || "我").slice(0, 1),
          };
          usePageCommentsStore.getState().addComment({
            id: newPageCommentId(),
            pageKey,
            threadId: hostThreadIdRef.current ?? dockRef.current?.activeThreadId ?? "",
            anchor: {
              selector: anchor.target,
              label: anchor.label,
              text: sel.text,
            },
            author,
            body,
            createdAt: now,
            sentToAgentAt: opts.sendToAgent ? now : null,
            replies: [],
            read: true,
          });
          if ("comments" in activeFrame.capabilities) {
            void pageAppsClient
              .call({
                appId: activeFrame.app.id,
                revision: activeFrame.revision,
                capability: "comments",
                method: "add",
                args: { anchor, body },
              })
              .catch(() => undefined);
          }
          if (opts.sendToAgent) {
            await routeToMossConversation({
              prompt: `关于「${sel.text}」：${body}`,
              quote: sel.text,
              label: anchor.label,
              origin: "comment-mention",
            });
          }
          return true;
        },
      });
    },
    [routeToMossConversation],
  );

  useEffect(() => {
    setHasTopHeading(false);
  }, [appPageId, reloadKey]);

  const loadVersions = useCallback(async (id: string) => {
    if (typeof pageAppsClient.versions !== "function") return;
    try {
      const result = await pageAppsClient.versions({ appId: id as PageAppId, limit: 20 });
      if (appPageIdRef.current === id) {
        setVersions(result.versions);
      }
    } catch {
      // Versions remain best-effort.
    }
  }, []);

  useEffect(() => {
    if (!frame || mode !== "full" || !frame.viewer.isOwner) {
      setVersions([]);
      return;
    }
    void loadVersions(frame.app.id);
  }, [frame?.app.id, frame?.app.revision, frame?.viewer.isOwner, loadVersions, mode]);

  const commentsAvailable = mode === "full" && !isStandalone && !isTransparent;
  const activeCommentsThreadId = hostThreadId ?? dock?.activeThreadId ?? "";
  const commentsPageKey = frame ? `page-app:${frame.app.id}` : "";
  const pageComments = usePageComments(commentsPageKey);
  const hasUnreadComments = commentsPageKey !== "" && pageComments.some((comment) => !comment.read);

  const markup = usePageAppMarkup({
    enabled: mode === "full" && !isStandalone && !isTransparent && frame !== null,
    appId: frame?.app.id ?? appPageId,
    appTitle: frame?.app.title ?? t("pageApps.frame.untitled"),
    revision: frame?.revision ?? 1,
    frameOrigin: frame?.frameOrigin ?? "null",
    iframeRef,
    frameBodyRef,
    brokerRef,
    threadId: (hostThreadId ?? dock?.activeThreadId ?? null) as ThreadId | null,
    onOpen: () => {
      setCommentMode(false);
      setCommentsPanelOpen(false);
      setFrameSelection(null);
    },
    onFallbackRoute: ({ quote, label }) => {
      void routeToMossConversation({
        prefillOnly: true,
        ...(quote ? { quote } : {}),
        ...(label ? { label } : {}),
        origin: "selection-bar",
      });
    },
  });
  const markupRef = useRef(markup);
  markupRef.current = markup;

  useEffect(() => {
    if (!frame) return;
    const broker = new PageAppBroker(
      {
        appId: frame.app.id,
        revision: frame.revision,
        title: frame.app.title,
        mode,
        viewer: frame.viewer,
        capabilities: frame.capabilities,
        consent: frame.consent,
      },
      {
        post: (message: PageAppShellMessage) => {
          const target = iframeRef.current?.contentWindow;
          // The opaque fallback has origin "null", which postMessage cannot name.
          target?.postMessage(message, frame.frameOrigin === "null" ? "*" : frame.frameOrigin);
        },
        client: pageAppsClient,
        plugins: PAGE_APP_SHELL_PLUGINS,
        askConsent,
        confirm,
        confirmChoice,
        frameElement: () => iframeRef.current,
        openPermissions,
        onOpenSidechat: (input) =>
          routeToMossConversation({
            ...(input.prompt ? { prompt: input.prompt } : {}),
            prefillOnly: !input.prompt,
            ...(input.selectionText ? { quote: input.selectionText } : {}),
            origin: "editor-bridge",
          }),
        onSelectionChange: (next) => {
          setFrameSelection(next);
          dockRef.current?.setSelection(
            next
              ? {
                  kind: "app",
                  itemId: frame.app.id,
                  title: frame.app.title,
                  anchorBlockId: next.anchor?.target ?? null,
                  quote: next.text,
                  summary: next.anchor?.label ?? next.text.slice(0, 60),
                }
              : null,
          );
        },
        onResize: (next) => setContentHeight(next),
        onTopHeadingChange: (hasHeading) => setHasTopHeading(hasHeading),
        onElementPicked: (element) => markupRef.current.handleElementPicked(element),
        onPickEnded: () => markupRef.current.handlePickEnded(),
        onConsentChange: setConsent,
      },
    );
    brokerRef.current = broker;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== frame.frameOrigin) return;
      broker.handleMessage(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      broker.dispose();
      if (brokerRef.current === broker) brokerRef.current = null;
    };
  }, [frame, mode, askConsent, confirm, confirmChoice, openPermissions]);

  // Unanswered prompts resolve "no" when the frame goes away.
  useEffect(
    () => () => {
      setConsentPrompt((pending) => (pending?.resolve(false), null));
      setConfirmPrompt((pending) => (pending?.resolve(DECLINED), null));
    },
    [frame],
  );

  const installFromDesktop = useCallback(async () => {
    const activeFrame = frameRef.current;
    if (!desktopBridge || !activeFrame) return;
    const targetAppId = activeFrame.app.id;
    const rect = iframeRef.current?.getBoundingClientRect();
    setInstallingAppId(targetAppId);
    try {
      const result = await desktopBridge.installFromPage({
        appId: targetAppId,
        title: activeFrame.app.title,
        revision: activeFrame.revision,
        scopeSpaceId: activeFrame.app.scopeSpaceId,
        thumbnail: activeFrame.app.thumbnail,
        frameUrl: activeFrame.frameUrl,
        capabilities: activeFrame.capabilities,
        ...(rect
          ? {
              sourceRect: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              },
            }
          : {}),
      });
      if (
        result.app &&
        appPageIdRef.current === targetAppId &&
        frameRef.current?.app.id === targetAppId
      ) {
        setInstalledApp(result.app);
      }
    } finally {
      setInstallingAppId((current) => (current === targetAppId ? null : current));
    }
  }, [desktopBridge]);

  const openInDesktopApp = useCallback(async () => {
    const activeFrame = frameRef.current;
    const installed = installedAppRef.current;
    if (!desktopBridge || !activeFrame) return;
    await desktopBridge.openInstalled({
      appId: activeFrame.app.id,
      ...(installed ? { installId: installed.installId } : {}),
      title: activeFrame.app.title,
      revision: activeFrame.revision,
      frameUrl: activeFrame.frameUrl,
      capabilities: activeFrame.capabilities,
    });
  }, [desktopBridge]);

  const openDesktopPermissions = useCallback(() => {
    const activeFrame = frameRef.current;
    const installed = installedAppRef.current;
    if (!desktopBridge || !activeFrame) return;
    void desktopBridge
      .openPermissions({
        appId: activeFrame.app.id,
        ...(installed ? { installId: installed.installId } : {}),
        title: activeFrame.app.title,
        revision: activeFrame.revision,
        permissions: readDeclaredDesktopPermissions(activeFrame.capabilities),
      })
      .catch(() => undefined);
  }, [desktopBridge]);

  const showInstalledInFolder = useCallback(async () => {
    const activeFrame = frameRef.current;
    const installed = installedAppRef.current;
    if (!desktopBridge || !activeFrame || !installed) return;
    await desktopBridge
      .showInFolder({
        appId: activeFrame.app.id,
        installId: installed.installId,
      })
      .catch(() => false);
  }, [desktopBridge]);

  const toggleDesktopShortcut = useCallback(async () => {
    const activeFrame = frameRef.current;
    const installed = installedAppRef.current;
    if (!desktopBridge?.setDesktopShortcut || !activeFrame || !installed) return;
    const enabled = !installed.places.includes("desktop");
    const result = await desktopBridge
      .setDesktopShortcut({
        appId: activeFrame.app.id,
        installId: installed.installId,
        enabled,
      })
      .catch(() => null);
    if (result?.updated && appPageIdRef.current === activeFrame.app.id) {
      setInstalledApp(result.app);
    }
  }, [desktopBridge]);

  const pinAppVersion = useCallback(
    async (revision: number | null) => {
      const activeFrame = frameRef.current;
      if (!activeFrame || pinningRevision) return;
      setPinningRevision(true);
      try {
        await pageAppsClient.mutate({
          op: "pin-version",
          requestId: crypto.randomUUID(),
          appId: activeFrame.app.id,
          expectedRevision: activeFrame.app.revision,
          revision,
        });
        const nextFrame = await pageAppsClient.openFrame({
          appId: activeFrame.app.id,
          mode: mode as PageAppFrameMode,
          parentOrigin: window.location.origin,
        });
        if (appPageIdRef.current === activeFrame.app.id) {
          setFrame(nextFrame);
          setConsent(nextFrame.consent);
          setReloadKey((k) => k + 1);
        }
      } catch {
        // Ignore transient version pin failure.
      } finally {
        setPinningRevision(false);
      }
    },
    [mode, pinningRevision],
  );

  const generateAiCover = useCallback(async () => {
    const activeFrame = frameRef.current;
    if (!activeFrame || generatingCover) return;
    setGeneratingCover(true);
    try {
      const updated = await generateAndSavePageAppCover(activeFrame.app);
      setFrame((current) =>
        current && current.app.id === updated.id ? { ...current, app: updated } : current,
      );
    } catch {
      // Ignore transient AI cover failure from title menu.
    } finally {
      setGeneratingCover(false);
    }
  }, [generatingCover]);

  const uninstallDesktopApp = useCallback(async () => {
    const activeFrame = frameRef.current;
    const installed = installedAppRef.current;
    if (!desktopBridge || !activeFrame || !installed) return;
    const targetAppId = activeFrame.app.id;
    const result = await desktopBridge
      .uninstall({
        appId: targetAppId,
        installId: installed.installId,
      })
      .catch(() => null);
    if (
      result?.uninstalled &&
      appPageIdRef.current === targetAppId &&
      frameRef.current?.app.id === targetAppId
    ) {
      setInstalledApp(null);
    }
  }, [desktopBridge]);

  useEffect(() => {
    lastSyncedRevisionRef.current = null;
    reportedGoneRef.current = false;
    setAttributionDismissed(false);
    setLiveTransparent(Boolean(isStandalone && (transparent || paneTransparent)));
  }, [appPageId, isStandalone, paneTransparent, transparent]);

  useEffect(() => {
    if (!isStandalone || !desktopBridge) return;
    let cancelled = false;
    if (typeof desktopBridge.invokeDesktopApi === "function") {
      void desktopBridge
        .invokeDesktopApi({
          appId: appPageId as PageAppId,
          revision: frameRef.current?.revision ?? 1,
          namespace: "window",
          method: "getOptions",
          args: null,
        })
        .then((opts) => {
          const next = readTransparentFromWindowPayload(opts);
          if (!cancelled && next !== null) {
            setLiveTransparent(next);
          }
        })
        .catch(() => undefined);
    }
    const unsub =
      typeof desktopBridge.onDesktopApiEvent === "function"
        ? desktopBridge.onDesktopApiEvent((event) => {
            if (event.appId && event.appId !== appPageId) return;
            if (event.namespace === "window") {
              const next = readTransparentFromWindowPayload(event.payload);
              if (next !== null) setLiveTransparent(next);
            }
          })
        : () => undefined;
    return () => {
      cancelled = true;
      unsub();
    };
  }, [appPageId, desktopBridge, isStandalone]);

  useEffect(() => {
    setInstalledApp(null);
    if (!desktopBridge) {
      setDesktopAvailable(false);
      return;
    }
    let cancelled = false;
    const refreshInstalled = async () => {
      const available = await desktopBridge.isAvailable().catch(() => false);
      if (cancelled) return;
      setDesktopAvailable(available);
      if (!available) {
        setInstalledApp(null);
        return;
      }
      const record =
        typeof desktopBridge.getInstalled === "function"
          ? await desktopBridge.getInstalled(appPageId as PageAppId).catch(() => null)
          : await desktopBridge
              .listInstalled()
              .then((apps) => apps.find((item) => item.appId === appPageId) ?? null)
              .catch(() => null);
      if (!cancelled) {
        setInstalledApp(record);
      }
    };
    void refreshInstalled();

    const unsubInstalled =
      typeof desktopBridge.onInstalledChanged === "function"
        ? desktopBridge.onInstalledChanged((apps) => {
            setInstalledApp(apps.find((item) => item.appId === appPageId) ?? null);
          })
        : () => undefined;

    const unsubPicked =
      typeof desktopBridge.onPickedInMenu === "function"
        ? desktopBridge.onPickedInMenu((event) => {
            if (event.appId !== appPageId || isStandalone) return;
            if (!isPrimaryMenuOfferOwner(menuOfferKeyRef.current, appPageId)) return;
            if (event.action === "install" && !installedAppRef.current) {
              void installFromDesktop();
            } else if (installedAppRef.current || event.action === "open") {
              void openInDesktopApp();
            } else {
              void installFromDesktop();
            }
          })
        : () => undefined;

    return () => {
      cancelled = true;
      unsubInstalled();
      unsubPicked();
    };
  }, [appPageId, desktopBridge, installFromDesktop, isStandalone, openInDesktopApp]);

  useEffect(() => {
    if (
      !desktopBridge ||
      !desktopAvailable ||
      isStandalone ||
      (mode !== "full" && mode !== "embed") ||
      !frame
    ) {
      return;
    }
    const offerKey = menuOfferKeyRef.current;
    activeMenuOffers.set(offerKey, {
      appId: frame.app.id,
      priority: mode === "full" ? 2 : 1,
      offer: {
        appId: frame.app.id,
        title: frame.app.title,
        revision: frame.revision,
        isInstalled: Boolean(installedApp),
        thumbnail: frame.app.thumbnail,
      },
    });
    flushActiveMenuOffers(desktopBridge);
    return () => {
      activeMenuOffers.delete(offerKey);
      flushActiveMenuOffers(desktopBridge);
    };
  }, [desktopAvailable, desktopBridge, frame, installedApp, isStandalone, mode]);

  useEffect(() => {
    if (!desktopBridge || !frame) return;
    if (!isStandalone && !installedApp) return;
    const nextRevision = frame.app.revision;
    if (lastSyncedRevisionRef.current === nextRevision) return;
    lastSyncedRevisionRef.current = nextRevision;
    void desktopBridge
      .syncAppVersion({
        appId: frame.app.id,
        revision: nextRevision,
        title: frame.app.title,
        capabilities: frame.capabilities,
      })
      .catch(() => undefined);
  }, [desktopBridge, frame, installedApp, isStandalone]);

  useEffect(() => {
    if (!isStandalone || !desktopBridge || typeof pageAppsClient.read !== "function") return;
    let cancelled = false;
    const checkLatestAppState = async () => {
      if (cancelled) return;
      try {
        const result = await pageAppsClient.read({ appId: appPageId as PageAppId });
        if (cancelled) return;
        const latest = result.app;
        const current = frameRef.current;
        if (latest.trashedAt !== null) {
          setFrame((prev) => (prev ? { ...prev, app: latest } : prev));
          return;
        }
        if (failureRef.current !== null || current?.app.trashedAt !== null) {
          setFailure(null);
          setReloadKey((key) => key + 1);
          return;
        }
        if (
          current &&
          (latest.revision !== current.app.revision ||
            latest.title !== current.app.title ||
            latest.trashedAt !== current.app.trashedAt)
        ) {
          setFrame((prev) =>
            prev
              ? {
                  ...prev,
                  app: latest,
                  revision: latest.revision,
                  capabilities: latest.capabilities,
                }
              : prev,
          );
        }
      } catch (cause) {
        if (cancelled) return;
        const code = (cause as { code?: unknown } | null)?.code;
        if (code === "not_found") {
          const message = (cause as { message?: unknown } | null)?.message;
          setFailure({ message: typeof message === "string" ? message : null });
        }
      }
    };
    const onFocusOrVisible = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void checkLatestAppState();
    };
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void checkLatestAppState();
    }, STANDALONE_SYNC_POLL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
      clearInterval(timer);
    };
  }, [appPageId, desktopBridge, isStandalone]);

  useEffect(() => {
    if (!desktopBridge || !isStandalone) return;
    const isGone = failure !== null || (frame !== null && frame.app.trashedAt !== null);
    if (isGone && !reportedGoneRef.current) {
      reportedGoneRef.current = true;
      void desktopBridge
        .reportAppGone({
          appId: appPageId as PageAppId,
          gone: true,
          ...(frame?.app.title ? { title: frame.app.title } : {}),
          ...(error ? { reason: error } : {}),
        })
        .catch(() => undefined);
    } else if (!isGone && frame !== null && reportedGoneRef.current) {
      reportedGoneRef.current = false;
      void desktopBridge
        .reportAppGone({
          appId: appPageId as PageAppId,
          gone: false,
          ...(frame.app.title ? { title: frame.app.title } : {}),
        })
        .catch(() => undefined);
    }
  }, [appPageId, desktopBridge, error, failure, frame, isStandalone]);

  const toggleFavorite = async () => {
    if (!frame) return;
    const next = !favorite;
    setFavorite(next);
    try {
      const result = await pageAppsClient.mutate({
        op: "favorite",
        requestId: crypto.randomUUID(),
        appId: frame.app.id,
        expectedRevision: frame.app.revision,
        favorite: next,
      });
      setFrame((current) => (current ? { ...current, app: result.app } : current));
    } catch {
      setFavorite(!next);
    }
  };

  const renameApp = useCallback(
    async (nextTitle: string) => {
      const activeFrame = frameRef.current;
      if (!activeFrame) return;
      const trimmed = nextTitle.trim().slice(0, 256);
      if (!trimmed || trimmed === activeFrame.app.title) return;
      try {
        const result = await pageAppsClient.mutate({
          op: "rename",
          requestId: crypto.randomUUID(),
          appId: activeFrame.app.id,
          expectedRevision: activeFrame.app.revision,
          title: trimmed,
        });
        setFrame((current) =>
          current && current.app.id === activeFrame.app.id
            ? { ...current, app: result.app }
            : current,
        );
        if (desktopBridge && installedAppRef.current) {
          void desktopBridge
            .syncAppVersion({
              appId: result.app.id,
              revision: result.app.revision,
              title: result.app.title,
              capabilities: result.app.capabilities,
            })
            .catch(() => undefined);
        }
        onTitleChangeRef.current?.(result.app.title);
      } catch {
        // Leave current title untouched if rename fails.
      }
    },
    [desktopBridge],
  );

  const exportHtml = useCallback(async () => {
    const activeFrame = frameRef.current;
    if (!activeFrame || typeof pageAppsClient.read !== "function") return;
    try {
      const detail = await pageAppsClient.read({ appId: activeFrame.app.id });
      const blob = new Blob([detail.html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const safeName =
        (activeFrame.app.title || t("pageApps.frame.untitled"))
          .trim()
          .replace(/[\\/:*?"<>|]/g, "-") || "page-app";
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeName}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      // Ignore export errors gracefully.
    }
  }, [t]);

  const trashApp = useCallback(async () => {
    const activeFrame = frameRef.current;
    if (!activeFrame || !onDeleted) return;
    try {
      await pageAppsClient.mutate({
        op: "trash",
        requestId: crypto.randomUUID(),
        appId: activeFrame.app.id,
        expectedRevision: activeFrame.app.revision,
      });
      if (desktopBridge && installedAppRef.current) {
        await desktopBridge
          .uninstall({
            appId: activeFrame.app.id,
            installId: installedAppRef.current.installId,
            skipConfirm: true,
          })
          .catch(() => undefined);
      }
      onDeleted();
    } catch {
      // Ignore trash failure gracefully.
    }
  }, [desktopBridge, onDeleted]);

  const frameHeight =
    mode === "embed"
      ? (height ??
        Math.min(
          EMBED_MAX_HEIGHT,
          Math.max(EMBED_MIN_HEIGHT, contentHeight ?? EMBED_MIN_HEIGHT * 3),
        ))
      : undefined;

  const standingCapabilities = useMemo(
    () =>
      frame
        ? PAGE_APP_SHELL_PLUGINS.filter(
            (plugin) => plugin.consent === "standing" && plugin.name in frame.capabilities,
          )
        : [],
    [frame],
  );

  const titleLabel =
    frame?.app.title ?? (error ? t("pageApps.frame.untitled") : t("pageApps.frame.opening"));
  const attributionLabel = formatStandaloneAttributionLabel(
    frame?.app.title,
    t("pageApps.frame.untitled"),
    t("pageApps.frame.standaloneBrand"),
  );
  const editedCaption = useMemo(
    () =>
      formatEditedCaption(frame?.app.updatedAt, locale, t("pageApps.frame.editedJustNow"), (when) =>
        format("pageApps.frame.editedAgo", { when }),
      ),
    [format, frame?.app.updatedAt, locale, t],
  );
  const hasDesktopInstalledFooter = mode === "full" && desktopAvailable && Boolean(installedApp);
  const canDeleteApp = mode === "full" && Boolean(onDeleted);

  const headerContent = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {renaming && mode === "full" && frame ? (
          <div className="flex h-7 max-w-[min(22rem,100%)] min-w-0 items-center px-1">
            <SpaceInlineRename
              value={frame.app.title}
              label={t("pageApps.frame.renameLabel")}
              onCommit={(nextTitle) => void renameApp(nextTitle)}
              onDone={() => setRenaming(false)}
              className="h-6 w-56 px-1.5 text-ui-sm"
            />
          </div>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-7 max-w-[min(22rem,100%)] min-w-0 shrink gap-1 rounded-control px-2 text-ui-sm font-normal text-foreground hover:bg-accent data-[popup-open]:bg-accent"
                  aria-label={`${titleLabel} ${t("pageApps.frame.menuLabel")}`}
                  onDoubleClick={() => {
                    if (mode === "full" && frame) setRenaming(true);
                  }}
                  data-testid="page-app-title-menu-trigger"
                  data-space-title-pill
                />
              }
            >
              <span className="min-w-0 truncate">{titleLabel}</span>
              <ChevronDownIcon
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground opacity-60"
              />
            </MenuTrigger>
            <ComposerPickerMenuPopup
              align="start"
              sideOffset={4}
              className="w-60 min-w-60 bg-popover! text-popover-foreground backdrop-blur-none!"
              data-testid="page-app-title-menu-popup"
            >
              {editedCaption ? (
                <div
                  data-testid="page-app-title-menu-about"
                  className="px-2.5 pt-1.5 pb-1 text-ui-xs text-muted-foreground"
                >
                  {editedCaption}
                </div>
              ) : null}
              <MenuItem
                disabled={!frame}
                onClick={() => void exportHtml()}
                data-testid="page-app-title-menu-export-item"
              >
                <DownloadIcon aria-hidden className="size-4" />
                <span>{t("pageApps.frame.exportHtml")}</span>
              </MenuItem>
              {mode === "full" && desktopAvailable && installedApp ? (
                <>
                  <MenuItem
                    disabled={!frame}
                    onClick={() => void openInDesktopApp()}
                    data-testid="page-app-title-menu-open-item"
                  >
                    <PopOutIcon aria-hidden className="size-4" />
                    <span>{t("pageApps.frame.openStandaloneApp")}</span>
                  </MenuItem>
                  <MenuItem
                    disabled={!frame}
                    onClick={() => void showInstalledInFolder()}
                    data-testid="page-app-title-menu-folder-item"
                  >
                    <FolderOpenIcon aria-hidden className="size-4" />
                    <span>{t("pageApps.frame.showInFolder")}</span>
                  </MenuItem>
                  {desktopBridge?.setDesktopShortcut ? (
                    <MenuItem
                      disabled={!frame}
                      onClick={() => void toggleDesktopShortcut()}
                      data-testid="page-app-title-menu-desktop-shortcut-item"
                    >
                      <AppsIcon aria-hidden className="size-4" />
                      <span>
                        {installedApp.places.includes("desktop") ? "从桌面移除" : "添加到桌面"}
                      </span>
                    </MenuItem>
                  ) : null}
                </>
              ) : null}
              <MenuSeparator />
              {mode === "full" ? (
                <MenuItem disabled={!frame} onClick={() => void toggleFavorite()}>
                  {favorite ? (
                    <StarFilledIcon aria-hidden className="size-4" />
                  ) : (
                    <StarIcon aria-hidden className="size-4" />
                  )}
                  <span>
                    {favorite ? t("pageApps.frame.unfavorite") : t("pageApps.frame.favorite")}
                  </span>
                </MenuItem>
              ) : null}
              {mode === "full" && desktopAvailable && !installedApp ? (
                <MenuItem
                  disabled={!frame || installingDesktop}
                  onClick={() => void installFromDesktop()}
                  data-testid="page-app-title-menu-install-item"
                >
                  <WindowAppIcon aria-hidden className="size-4" />
                  <span className="flex-1 truncate">{t("pageApps.frame.installAsApp")}</span>
                  <Badge size="sm" variant="default" className="ms-auto">
                    {t("pageApps.frame.betaBadge")}
                  </Badge>
                </MenuItem>
              ) : null}
              {mode === "full" && frame?.viewer.isOwner ? (
                <MenuItem
                  disabled={!frame || generatingCover}
                  onClick={() => void generateAiCover()}
                  data-testid="page-app-title-menu-generate-cover-item"
                >
                  <SparklesIcon aria-hidden className="size-4" />
                  <span>
                    {locale.toLowerCase().startsWith("zh")
                      ? generatingCover
                        ? "正在生成封面…"
                        : "AI 生成封面"
                      : generatingCover
                        ? "Generating cover…"
                        : "Generate AI cover"}
                  </span>
                </MenuItem>
              ) : null}
              {mode === "full" ? (
                <MenuItem
                  disabled={!frame}
                  onClick={() => setRenaming(true)}
                  data-testid="page-app-title-menu-rename-item"
                >
                  <PencilIcon aria-hidden className="size-4" />
                  <span>{t("pageApps.frame.rename")}</span>
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => setReloadKey((key) => key + 1)}>
                <RefreshCwIcon aria-hidden className="size-4" />
                <span>{t("pageApps.frame.reload")}</span>
              </MenuItem>
              {mode === "full" && desktopAvailable ? (
                <MenuItem
                  disabled={!frame}
                  onClick={openDesktopPermissions}
                  data-testid="page-app-title-menu-desktop-perms-item"
                >
                  <LockIcon aria-hidden className="size-4" />
                  <span>{t("pageApps.frame.desktopPermissions")}</span>
                </MenuItem>
              ) : null}
              <MenuItem disabled={!frame} onClick={() => setPermissionsOpen(() => () => undefined)}>
                <SlidersIcon aria-hidden className="size-4" />
                <span>{t("pageApps.frame.capabilityPermissions")}</span>
              </MenuItem>
              {onCloseTab ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={onCloseTab} data-testid="page-app-title-menu-close-tab-item">
                    <XIcon aria-hidden className="size-4" />
                    <span>{t("pageApps.frame.closeTab")}</span>
                  </MenuItem>
                </>
              ) : null}
              {hasDesktopInstalledFooter || canDeleteApp ? (
                <>
                  {!onCloseTab ? <MenuSeparator /> : null}
                  {hasDesktopInstalledFooter ? (
                    <MenuItem
                      variant="destructive"
                      disabled={!frame}
                      onClick={() => void uninstallDesktopApp()}
                      data-testid="page-app-title-menu-uninstall-item"
                    >
                      <TrashCanIcon aria-hidden className="size-4" />
                      <span>{t("pageApps.frame.uninstallApp")}</span>
                    </MenuItem>
                  ) : null}
                  {canDeleteApp ? (
                    <MenuItem
                      variant="destructive"
                      disabled={!frame}
                      onClick={() => void trashApp()}
                      data-testid="page-app-title-menu-delete-item"
                    >
                      <TrashCanIcon aria-hidden className="size-4" />
                      <span>{t("pageApps.frame.delete")}</span>
                    </MenuItem>
                  ) : null}
                </>
              ) : null}
            </ComposerPickerMenuPopup>
          </Menu>
        )}
        {mode === "full" && frame && frame.viewer.isOwner && !renaming ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-7 shrink-0 gap-1 rounded-control px-2 text-ui-xs font-normal text-muted-foreground hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent"
                  disabled={pinningRevision}
                  onClick={() => void loadVersions(frame.app.id)}
                  data-testid="page-app-version-menu-trigger"
                />
              }
            >
              {frame.app.pinnedRevision != null ? (
                <PinIcon aria-hidden className="size-3 text-[var(--color-text-accent)]" />
              ) : (
                <HistoryIcon aria-hidden className="size-3" />
              )}
              <span>v{frame.revision}</span>
              {frame.app.pinnedRevision != null ? (
                <Badge size="sm" variant="secondary" data-testid="page-app-version-pinned-badge">
                  已锁定
                </Badge>
              ) : null}
            </MenuTrigger>
            <ComposerPickerMenuPopup
              align="start"
              sideOffset={4}
              className="w-60 min-w-60 bg-popover! text-popover-foreground backdrop-blur-none!"
              data-testid="page-app-version-menu-popup"
            >
              <MenuItem
                disabled={pinningRevision}
                onClick={() => void pinAppVersion(null)}
                data-testid="page-app-version-follow-latest"
              >
                <CheckIcon
                  aria-hidden
                  className={cn(
                    "size-4",
                    frame.app.pinnedRevision == null ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="flex-1 truncate">跟随最新 (v{frame.app.revision})</span>
              </MenuItem>
              {versions.length > 0 ? <MenuSeparator /> : null}
              {versions.map((ver) => {
                const isPinned = frame.app.pinnedRevision === ver.revision;
                return (
                  <MenuItem
                    key={ver.revision}
                    disabled={pinningRevision}
                    onClick={() => void pinAppVersion(ver.revision)}
                    data-testid={`page-app-version-item-${ver.revision}`}
                  >
                    <PinIcon
                      aria-hidden
                      className={cn(
                        "size-4",
                        isPinned ? "text-[var(--color-text-accent)] opacity-100" : "opacity-35",
                      )}
                    />
                    <span className="flex-1 truncate">
                      v{ver.revision} · {ver.title}
                    </span>
                    {isPinned ? (
                      <Badge size="sm" variant="secondary">
                        锁定
                      </Badge>
                    ) : null}
                  </MenuItem>
                );
              })}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1" data-testid="page-app-header-actions">
        {mode === "full" && !isStandalone && !isTransparent ? (
          <>
            <BrowserAnnotationButton controller={markup.buttonController} disabled={!frame} />
            <div className="flex shrink-0 items-center" data-page-comments-control="">
              <Button
                aria-label={
                  locale.toLowerCase().startsWith("zh")
                    ? commentMode
                      ? "退出评论模式"
                      : "在页面上评论"
                    : commentMode
                      ? "Leave comment mode"
                      : "Comment on the page"
                }
                aria-pressed={commentMode}
                disabled={!frame}
                size="icon-sm"
                title={
                  locale.toLowerCase().startsWith("zh")
                    ? commentMode
                      ? "退出评论模式 (Esc)"
                      : "在页面上评论"
                    : commentMode
                      ? "Leave comment mode (Esc)"
                      : "Comment on the page"
                }
                variant="ghost"
                className={cn(
                  "relative size-7 rounded-e-none text-foreground/80 hover:text-foreground",
                  commentMode &&
                    "bg-[color-mix(in_srgb,var(--color-text-accent)_13%,transparent)]! text-[var(--color-text-accent)]!",
                )}
                data-page-comments-toggle=""
                onClick={() => {
                  if (!commentMode && markup.open) {
                    markup.close();
                  }
                  setFrameSelection(null);
                  setCommentMode((on) => !on);
                  setCommentsPanelOpen((open) => (commentMode ? false : open));
                }}
              >
                <PageCommentIcon />
                {hasUnreadComments ? (
                  <StatusDot
                    aria-hidden
                    data-page-comments-unread=""
                    className="absolute top-1 right-1 bg-[var(--color-text-accent)] ring-1 ring-background"
                  />
                ) : null}
              </Button>
              <Menu modal={false} open={commentsMenuOpen} onOpenChange={setCommentsMenuOpen}>
                <MenuTrigger
                  render={
                    <Button
                      aria-label={
                        locale.toLowerCase().startsWith("zh") ? "评论选项" : "Comment options"
                      }
                      disabled={!frame}
                      title={locale.toLowerCase().startsWith("zh") ? "评论选项" : "Comment options"}
                      size="icon-sm"
                      variant="ghost"
                      className="h-7 w-4 rounded-s-none text-muted-foreground [&_[data-slot=central-icon]]:size-3"
                    >
                      <ChevronDownIcon />
                    </Button>
                  }
                />
                <ComposerPickerMenuPopup
                  align="end"
                  side="bottom"
                  className="bg-popover! text-popover-foreground backdrop-blur-none!"
                >
                  <MenuItem
                    data-page-comments-menu="all"
                    onClick={() => setCommentsPanelOpen((open) => !open)}
                  >
                    {locale.toLowerCase().startsWith("zh")
                      ? commentsPanelOpen
                        ? "隐藏全部评论"
                        : "全部评论"
                      : commentsPanelOpen
                        ? "Hide all comments"
                        : "All comments"}
                  </MenuItem>
                  <MenuItem
                    data-page-comments-menu="markers"
                    onClick={() => setCommentMarkersVisible((visible) => !visible)}
                  >
                    {locale.toLowerCase().startsWith("zh")
                      ? commentMarkersVisible
                        ? "隐藏评论标记"
                        : "显示评论标记"
                      : commentMarkersVisible
                        ? "Hide comment markers"
                        : "Show comment markers"}
                  </MenuItem>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>
          </>
        ) : null}
        {mode === "full" && desktopAvailable && installedApp ? (
          <IconButton
            variant="chrome"
            size="icon-sm"
            label={t("pageApps.frame.openStandaloneApp")}
            tooltip={t("pageApps.frame.openStandaloneApp")}
            disabled={!frame}
            onClick={() => void openInDesktopApp()}
            data-testid="page-app-open-standalone-btn"
          >
            <PopOutIcon />
          </IconButton>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <IconButton
                variant="chrome"
                size="icon-sm"
                label={t("pageApps.frame.moreActions")}
                data-testid="page-app-more-menu-trigger"
              >
                <MoreHorizontalIcon />
              </IconButton>
            }
          />
          <ComposerPickerMenuPopup
            align="end"
            className="w-56 min-w-56 bg-popover! text-popover-foreground backdrop-blur-none!"
            data-testid="page-app-more-menu-popup"
          >
            {mode === "full" && desktopAvailable ? (
              <>
                {!installedApp ? (
                  <MenuItem
                    disabled={!frame || installingDesktop}
                    onClick={() => void installFromDesktop()}
                    data-testid="page-app-more-install-item"
                  >
                    <WindowAppIcon aria-hidden className="size-4" />
                    <span className="flex-1 truncate">{t("pageApps.frame.installAsApp")}</span>
                    <Badge size="sm" variant="default" className="ms-auto">
                      {t("pageApps.frame.betaBadge")}
                    </Badge>
                  </MenuItem>
                ) : (
                  <MenuItem
                    disabled={!frame}
                    onClick={() => void openInDesktopApp()}
                    data-testid="page-app-more-open-item"
                  >
                    <PopOutIcon aria-hidden className="size-4" />
                    <span>{t("pageApps.frame.openStandaloneApp")}</span>
                  </MenuItem>
                )}
                <MenuItem
                  disabled={!frame}
                  onClick={openDesktopPermissions}
                  data-testid="page-app-desktop-permissions-btn"
                >
                  <LockIcon aria-hidden className="size-4" />
                  <span>{t("pageApps.frame.desktopPermissions")}</span>
                </MenuItem>
                {installedApp ? (
                  <>
                    <MenuItem
                      disabled={!frame}
                      onClick={() => void showInstalledInFolder()}
                      data-testid="page-app-desktop-show-in-folder-btn"
                    >
                      <FolderOpenIcon aria-hidden className="size-4" />
                      <span>{t("pageApps.frame.showInFolder")}</span>
                    </MenuItem>
                    {desktopBridge?.setDesktopShortcut ? (
                      <MenuItem
                        disabled={!frame}
                        onClick={() => void toggleDesktopShortcut()}
                        data-testid="page-app-more-desktop-shortcut-toggle"
                      >
                        <AppsIcon aria-hidden className="size-4" />
                        <span>
                          {installedApp.places.includes("desktop") ? "从桌面移除" : "添加到桌面"}
                        </span>
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      variant="destructive"
                      disabled={!frame}
                      onClick={() => void uninstallDesktopApp()}
                      data-testid="page-app-desktop-uninstall-btn"
                    >
                      <TrashCanIcon aria-hidden className="size-4" />
                      <span>{t("pageApps.frame.uninstallApp")}</span>
                    </MenuItem>
                  </>
                ) : null}
                <MenuSeparator />
              </>
            ) : null}
            <MenuItem disabled={!frame} onClick={() => setPermissionsOpen(() => () => undefined)}>
              <SlidersIcon aria-hidden className="size-4" />
              <span>{t("pageApps.frame.capabilityPermissions")}</span>
            </MenuItem>
            {mode === "full" ? (
              <MenuItem disabled={!frame} onClick={() => void toggleFavorite()}>
                {favorite ? (
                  <StarFilledIcon aria-hidden className="size-4" />
                ) : (
                  <StarIcon aria-hidden className="size-4" />
                )}
                <span>
                  {favorite ? t("pageApps.frame.unfavorite") : t("pageApps.frame.favorite")}
                </span>
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCwIcon aria-hidden className="size-4" />
              <span>{t("pageApps.frame.reload")}</span>
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
    </>
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        mode === "embed"
          ? "rounded-panel border border-[color:var(--color-border-light)] bg-[var(--color-background-surface)]"
          : isTransparent
            ? "h-full flex-1 bg-transparent"
            : "h-full flex-1 bg-[var(--color-background-surface)]",
        className,
      )}
      data-page-app-mode={mode}
      data-page-app-standalone={isStandalone ? "true" : undefined}
      data-page-app-transparent={isTransparent ? "true" : undefined}
      data-testid="app-page-frame"
    >
      {!isStandalone && mode !== "embed" && topBar ? (
        <RouteSurfaceHeader>{headerContent}</RouteSurfaceHeader>
      ) : !isStandalone && mode !== "embed" ? (
        <header
          data-testid="page-app-dock-subheader"
          className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-[color:var(--app-surface-divider)] bg-transparent px-2 select-none"
        >
          {headerContent}
        </header>
      ) : null}

      {frame?.offlineReady === false ? (
        <p
          role="status"
          className="shrink-0 border-b border-[color:var(--color-border-light)] px-3 py-1 text-ui-sm text-[var(--color-text-foreground-secondary)]"
        >
          {t("pageApps.frame.offlineWarning")}
        </p>
      ) : null}
      <div
        ref={frameBodyRef}
        className="relative min-h-0 flex-1"
        style={frameHeight ? { height: frameHeight } : undefined}
      >
        {frame ? (
          <iframe
            key={`${frame.frameUrl}#${reloadKey}`}
            ref={iframeRef}
            title={frame.app.title}
            src={frame.frameUrl}
            onLoad={() => {
              setLoadedFrameKey(`${appPageId}:${reloadKey}:${frame.frameUrl}`);
              setLoadedFrameGen((gen) => gen + 1);
            }}
            sandbox={pageAppIframeSandbox(frame.ownOrigin)}
            allow="clipboard-write"
            referrerPolicy="no-referrer"
            className={cn(
              "absolute inset-0 size-full border-0",
              isTransparent ? "bg-transparent" : "bg-[var(--color-background-surface)]",
            )}
          />
        ) : (
          <div className="flex size-full min-h-[120px] items-center justify-center text-ui text-[var(--color-text-foreground-tertiary)]">
            {error ?? t("pageApps.frame.openingPage")}
          </div>
        )}
        {markup.open && markup.coversPage ? (
          <div data-testid="page-app-markup-canvas" className="absolute inset-0 z-20">
            <MarkupCanvas
              pageImageUrl={markup.pageImageUrl}
              tool={markup.tool}
              style={markup.style}
              marks={markup.marks}
              onAddMark={markup.addMark}
              className="size-full"
            />
          </div>
        ) : null}
        {frameSelection && frame && mode === "full" && frame.viewer.isOwner && !isTransparent ? (
          <PageAppSelectionBubble
            rect={frameSelection.rect}
            containerWidth={frameBodyRef.current?.clientWidth ?? 800}
            containerHeight={frameBodyRef.current?.clientHeight ?? 600}
            onComment={() => {
              const sel = frameSelection;
              setFrameSelection(null);
              openSelectionCommentComposer(sel);
            }}
            onAskMoss={() => {
              const sel = frameSelection;
              setFrameSelection(null);
              void routeToMossConversation({
                prefillOnly: true,
                quote: sel.text,
                ...(sel.anchor?.label ? { label: sel.anchor.label } : {}),
                origin: "selection-bar",
              });
            }}
          />
        ) : null}
        {commentsAvailable && frame ? (
          <PageCommentsLayer
            frame={iframeRef.current}
            frameGeneration={loadedFrameGen}
            threadId={activeCommentsThreadId}
            pageKey={`page-app:${frame.app.id}`}
            pageTitle={frame.app.title}
            zoom={1}
            commentMode={commentMode}
            onCommentModeChange={(next) => {
              if (next && markup.open) markup.close();
              setFrameSelection(null);
              setCommentMode(next);
            }}
            panelOpen={commentsPanelOpen}
            onPanelOpenChange={setCommentsPanelOpen}
            markersVisible={commentMarkersVisible}
            onSendToAgent={
              activeCommentsThreadId
                ? undefined
                : (message) => {
                    void routeToMossConversation({
                      prompt: message,
                      origin: "comment-mention",
                    });
                  }
            }
          />
        ) : null}
        {mode === "full" && !isStandalone && !isTransparent && markup.open ? (
          <div
            data-testid="page-app-markup-strip"
            className="pointer-events-none absolute inset-x-0 bottom-3 z-30 px-3"
          >
            <MarkupToolbar
              tool={markup.tool}
              onToolChange={markup.setTool}
              selectAvailable
              canUndo={markup.canUndo}
              canRedo={markup.canRedo}
              hasMarks={markup.marks.length > 0}
              expanded={markup.expanded}
              style={markup.style}
              onStyleChange={markup.setStyle}
              action={{
                label: t("browser.sketch.addToChat"),
                busyLabel: t("browser.sketch.adding"),
                busy: markup.adding,
                onClick: markup.addToChat,
              }}
              confirmingDiscard={markup.confirmingDiscard}
              onUndo={markup.undo}
              onRedo={markup.redo}
              onClear={markup.clear}
              onRequestClose={markup.requestClose}
              onCancelDiscard={markup.cancelDiscard}
              onDiscard={markup.close}
            />
          </div>
        ) : null}
        {isStandalone &&
        !isTransparent &&
        !attributionDismissed &&
        frame !== null &&
        !frame.viewer.isOwner ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
            <div
              data-testid="standalone-attribution-pill"
              className="pointer-events-auto flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-ui-xs text-muted-foreground shadow-xl"
            >
              <SparklesIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{attributionLabel}</span>
              <IconButton
                variant="chrome"
                size="icon-chip"
                label={t("pageApps.frame.dismissAttribution")}
                onClick={() => setAttributionDismissed(true)}
              >
                <XIcon />
              </IconButton>
            </div>
          </div>
        ) : null}
      </div>

      {mode === "embed" ? (
        <div
          data-has-top-heading={hasTopHeading ? "true" : undefined}
          className="flex h-7 shrink-0 items-center gap-1 border-t border-[color:var(--color-border-light)] px-2 text-ui-sm text-[var(--color-text-foreground-tertiary)]"
        >
          <SparklesIcon className="size-3" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {hasTopHeading
              ? t("pageApps.frame.byline")
              : `${frame?.app.title ?? t("pageApps.frame.untitled")} · ${t("pageApps.frame.byline")}`}
          </span>
          <Button
            variant="chrome"
            size="icon-chip"
            aria-label={t("pageApps.frame.permissions")}
            disabled={!frame}
            onClick={() => setPermissionsOpen(() => () => undefined)}
          >
            <SlidersIcon />
          </Button>
        </div>
      ) : null}

      <Dialog
        open={consentPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setConsentPrompt((pending) => (pending?.resolve(false), null));
        }}
      >
        <DialogPopup
          showCloseButton={false}
          className="max-w-[400px]"
          data-testid="page-app-consent"
        >
          <DialogHeader>
            <DialogTitle>
              {format("pageApps.frame.consent.title", { title: consentView?.appTitle ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("pageApps.frame.consent.description")}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="flex flex-col gap-2">
              {consentView?.capabilities.map((capability) => (
                <li
                  key={capability.name}
                  className="rounded-control border border-[color:var(--color-border-light)] px-3 py-2"
                >
                  <div className="text-ui font-medium text-[var(--color-text-foreground)]">
                    {capability.label}
                  </div>
                  <div className="text-ui-sm text-[var(--color-text-foreground-secondary)]">
                    {capability.purpose}
                  </div>
                </li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConsentPrompt((pending) => (pending?.resolve(false), null))}
            >
              {t("pageApps.frame.deny")}
            </Button>
            <Button onClick={() => setConsentPrompt((pending) => (pending?.resolve(true), null))}>
              {t("pageApps.frame.allow")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={confirmPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmPrompt((pending) => (pending?.resolve(DECLINED), null));
        }}
      >
        <DialogPopup
          showCloseButton={false}
          className="max-w-[400px]"
          data-testid="page-app-confirm"
        >
          <DialogHeader>
            <DialogTitle>{confirmView?.title}</DialogTitle>
            <DialogDescription>{confirmView?.body}</DialogDescription>
          </DialogHeader>
          {confirmView?.details?.length || confirmView?.rememberLabel ? (
            <DialogPanel className="flex flex-col gap-3">
              {confirmView.details?.length ? (
                <div className="rounded-control bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-ui">
                  {confirmView.details.map((line) => (
                    <div key={line} className="truncate first:font-medium">
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}
              {confirmView.rememberLabel ? (
                <label className="flex cursor-interaction items-center gap-2 text-ui text-foreground">
                  <Checkbox
                    checked={confirmRemember}
                    onCheckedChange={(checked) => setConfirmRemember(checked === true)}
                    data-testid="page-app-confirm-remember"
                  />
                  <span>{confirmView.rememberLabel}</span>
                </label>
              ) : null}
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmPrompt((pending) => (pending?.resolve(DECLINED), null))}
            >
              {t("pageApps.frame.cancel")}
            </Button>
            <Button
              variant={confirmView?.tone === "danger" ? "destructive" : "default"}
              onClick={() =>
                setConfirmPrompt(
                  (pending) => (
                    pending?.resolve({
                      confirmed: true,
                      remember: Boolean(pending.request.rememberLabel) && confirmRemember,
                    }),
                    null
                  ),
                )
              }
            >
              {confirmView?.confirmLabel ?? t("pageApps.frame.confirm")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={permissionsOpen !== null}
        onOpenChange={(open) => {
          if (!open)
            setPermissionsOpen((done) => {
              done?.();
              return null;
            });
        }}
      >
        <DialogPopup className="max-w-[420px]" data-testid="page-app-permissions">
          <DialogHeader>
            <DialogTitle>{t("pageApps.frame.permissions")}</DialogTitle>
            <DialogDescription>
              {format("pageApps.frame.permissions.description", { title: frame?.app.title ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {standingCapabilities.length === 0 ? (
              <p className="text-ui text-[var(--color-text-foreground-secondary)]">
                {t("pageApps.frame.permissions.none")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {standingCapabilities.map((plugin) => {
                  const state = consent[plugin.name] ?? null;
                  const choose = (next: PageAppStoredConsent | null) =>
                    void brokerRef.current?.setConsent(plugin.name, next).catch(() => undefined);
                  return (
                    <li
                      key={plugin.name}
                      className="flex items-center gap-3 rounded-control border border-[color:var(--color-border-light)] px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-ui font-medium">{plugin.label}</div>
                        <div className="text-ui-sm text-[var(--color-text-foreground-secondary)]">
                          {plugin.purpose}
                        </div>
                      </div>
                      <div
                        className="flex shrink-0 gap-1"
                        role="radiogroup"
                        aria-label={plugin.label}
                      >
                        {(
                          [
                            ["granted", t("pageApps.frame.allow")],
                            [null, t("pageApps.frame.ask")],
                            ["denied", t("pageApps.frame.deny")],
                          ] as const
                        ).map(([value, label]) => (
                          <Button
                            key={label}
                            size="sm"
                            variant={state === value ? "secondary" : "ghost"}
                            role="radio"
                            aria-checked={state === value}
                            onClick={() => choose(value)}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
