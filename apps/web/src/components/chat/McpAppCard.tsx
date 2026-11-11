// FILE: McpAppCard.tsx
// Purpose: A connector widget's transcript block, wired to its host: one McpAppHostController
//          per widget, the side-panel registry, per-device preferences, the composer (for
//          `ui/message`) and toasts. It sits under the normal tool row; McpAppBlockView draws it.
// Layer: Chat transcript UI
// Exports: McpAppCard

import type { ThreadId } from "@moss/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useComposerDraftStore } from "../../composerDraftStore";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useTheme } from "~/hooks/useTheme";
import { McpAppHostController } from "~/lib/mcpAppHost";
import {
  hasMcpAppDockHost,
  makeMcpAppDockEntryId,
  registerMcpAppDockEntry,
  requestMcpAppDisplayMode,
  showMcpAppDockEntry,
  updateMcpAppDockEntryNavigation,
  updateMcpAppDockEntryTitle,
  useMcpAppDockEntries,
} from "~/lib/mcpAppDockRegistry";
import { resolveMcpAppBinding } from "~/lib/mcpApps/binding";
import type { McpAppBinding } from "~/lib/mcpApps/contracts";
import { mcpAppStylesForThemePacks } from "~/lib/mcpApps/hostStyles";
import {
  hashMcpAppKey,
  setMcpAppConnectorHidden,
  setMcpAppToolClosed,
  useMcpAppPreferences,
} from "~/lib/mcpApps/preferences";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { useTranslation } from "~/localization";
import { toastManager } from "../ui/toast";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { McpAppBlockView } from "./McpAppBlockView";
import { McpAppNavigationControls } from "./McpAppNavigationControls";

export interface McpAppCardProps {
  readonly projection: WorkLogMcpToolResult;
  readonly threadId: string;
  readonly theme?: "light" | "dark";
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function askReplaceWithToast(
  threadId: string,
  title: string,
  action: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let id: ReturnType<typeof toastManager.add> | null = null;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (id !== null) toastManager.close(id);
      resolve(value);
    };
    const timer = window.setTimeout(() => settle(false), timeoutMs);
    id = toastManager.add({
      title,
      timeout: timeoutMs,
      actionProps: { children: action, onClick: () => settle(true) },
      data: { threadId: threadId as ThreadId, onClose: () => settle(false) },
    });
  });
}

function McpAppBlock(props: McpAppCardProps & { readonly binding: McpAppBinding }) {
  const { t, format, locale } = useTranslation();
  const navigate = useNavigate();
  const { projection, threadId, binding } = props;
  const { lightTheme, darkTheme, resolvedTheme } = useTheme();
  const theme = props.theme ?? resolvedTheme;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const styles = useMemo(
    () => mcpAppStylesForThemePacks(lightTheme, darkTheme),
    [darkTheme, lightTheme],
  );
  const preferences = useMcpAppPreferences();
  const hideOffered = !binding.isFirstParty;
  const hidden =
    hideOffered && preferences.hiddenConnectors.includes(hashMcpAppKey(binding.serverKey));
  const toolClosed = preferences.closedTools.includes(binding.toolName);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [peek, setPeek] = useState(false);
  const open = hidden ? peek : (openOverride ?? !toolClosed);
  // A widget starts the first time its block is open, and keeps running when collapsed.
  const [started, setStarted] = useState(open);
  useEffect(() => {
    if (open) setStarted(true);
  }, [open]);

  const hostContainerRef = useRef<HTMLDivElement>(null);
  const entryId = useMemo(
    () => makeMcpAppDockEntryId(threadId, projection.callId, binding.resourceUri),
    [binding.resourceUri, projection.callId, threadId],
  );
  const dockTitle = binding.toolTitle ?? binding.serverLabel;
  const latest = useRef({ projection, theme, locale, styles, format, t, open, navigate });
  latest.current = { projection, theme, locale, styles, format, t, open, navigate };
  const registryVisibleRef = useRef(true);
  const unregisterEntryRef = useRef<(() => Promise<void>) | null>(null);
  const controllerRef = useRef<McpAppHostController | null>(null);

  const registerDockEntry = useCallback(() => {
    const active = controllerRef.current;
    if (!active || unregisterEntryRef.current) return;
    unregisterEntryRef.current = registerMcpAppDockEntry({
      id: entryId,
      threadId,
      title: binding.toolTitle ?? binding.serverLabel,
      getInlineContainer: () => hostContainerRef.current,
      layoutFrameTo: (target, displayMode) => active.layoutFrameTo(target, displayMode),
      navigate: (delta) => active.navigate(delta),
      setFrameVisibility: (visible) => {
        registryVisibleRef.current = visible;
        active.setFrameVisibility(visible && latest.current.open);
      },
      onUnregistered: () => {
        unregisterEntryRef.current = null;
      },
    });
  }, [binding.serverLabel, binding.toolTitle, entryId, threadId]);

  // One controller per widget identity; theme, locale and style changes are pushed below.
  const controller = useMemo(() => {
    const created = new McpAppHostController({
      projection: latest.current.projection,
      binding,
      identity: {
        threadId,
        callId: projection.callId,
        resourceUri: binding.resourceUri,
        lifecycleKey: entryId,
      },
      theme: latest.current.theme,
      locale: latest.current.locale,
      styles: latest.current.styles,
      paneAvailable: () => hasMcpAppDockHost(threadId),
      onRequestDisplayMode: (mode) => {
        registerDockEntry();
        return requestMcpAppDisplayMode(entryId, mode).then((result) => result.mode);
      },
      message: {
        readComposer: () =>
          useComposerDraftStore.getState().draftsByThreadId[threadId as ThreadId]?.prompt ?? "",
        writeComposer: (text) =>
          useComposerDraftStore.getState().setPrompt(threadId as ThreadId, text),
        askReplace: (serverLabel, timeoutMs) =>
          askReplaceWithToast(
            threadId,
            latest.current.format("mcpApp.message.replacePrompt", { serverName: serverLabel }),
            latest.current.t("mcpApp.message.replaceAction"),
            timeoutMs,
          ),
        // No thread surface sends a widget's message by itself yet (no first-party widget
        // tools this round, SPEC §12), so every message lands in the composer.
        sendNow: null,
        notifySent: (serverLabel) =>
          toastManager.add({
            title: latest.current.format("mcpApp.message.sent", { serverName: serverLabel }),
            data: { threadId: threadId as ThreadId },
          }),
      },
      openInApp: (path) => void latest.current.navigate({ href: path }),
    });
    controllerRef.current = created;
    return created;
  }, [binding, entryId, projection.callId, registerDockEntry, threadId]);

  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    controller.getSnapshot.bind(controller),
  );
  const dockEntry = useMcpAppDockEntries(threadId).find((entry) => entry.id === entryId);
  const dockState = useRightDockStore(
    useMemo(() => selectRightDockState(threadId as ThreadId), [threadId]),
  );
  const docked =
    dockEntry !== undefined &&
    (dockEntry.displayMode === "fullscreen" || dockEntry.requestedDisplayMode === "fullscreen");
  const dockShowing = docked && dockState.open && dockEntry?.selected === true;

  useEffect(() => {
    const container = hostContainerRef.current;
    if (!container || !started) return;
    registerDockEntry();
    void controller.start(container).catch(() => undefined);
    return () => {
      const unregister = unregisterEntryRef.current;
      unregisterEntryRef.current = null;
      void unregister?.().catch(() => undefined);
      void controller.teardown().catch(() => undefined);
    };
  }, [controller, registerDockEntry, started]);

  useEffect(() => {
    controller.updateProjection(projection);
  }, [controller, projection]);
  useEffect(() => {
    controller.updateTheme(theme);
    controller.updateLocale(locale);
    controller.updateStyles(styles);
  }, [controller, locale, styles, theme]);
  useEffect(() => {
    controller.setFrameVisibility(registryVisibleRef.current && (open || docked));
  }, [controller, docked, open]);
  useEffect(() => {
    updateMcpAppDockEntryTitle(entryId, dockTitle);
  }, [dockTitle, entryId]);
  useEffect(() => {
    updateMcpAppDockEntryNavigation(entryId, snapshot.canGoBack, snapshot.canGoForward);
  }, [entryId, snapshot.canGoBack, snapshot.canGoForward]);

  const phase = snapshot.phase;
  const canOpenPane =
    open &&
    !docked &&
    phase === "ready" &&
    !snapshot.fullscreenDeclined &&
    hasMcpAppDockHost(threadId);
  const navigationPortalTarget = controller.getNavigationPortalTarget();
  const inlineNavigation =
    open && !docked && (snapshot.canGoBack || snapshot.canGoForward) && navigationPortalTarget
      ? createPortal(
          <div className="absolute top-2 left-2 z-50 rounded-control border border-border bg-surface/95 p-0.5 shadow-sm">
            <McpAppNavigationControls
              canGoBack={snapshot.canGoBack}
              canGoForward={snapshot.canGoForward}
              onNavigate={(delta) => controller.navigate(delta)}
            />
          </div>,
          navigationPortalTarget,
        )
      : null;

  return (
    <McpAppBlockView
      binding={binding}
      projection={projection}
      phase={phase}
      loading={started && (phase === "idle" || phase === "loading")}
      open={open}
      hidden={hidden}
      hideOffered={hideOffered}
      height={snapshot.height}
      prefersBorder={snapshot.prefersBorder}
      docked={docked}
      dockShowing={dockShowing}
      canOpenPane={canOpenPane}
      prompt={snapshot.prompt}
      dialog={snapshot.dialog}
      reducedMotion={reducedMotion}
      frameRef={hostContainerRef}
      overlay={inlineNavigation}
      onToggle={() => {
        if (hidden) {
          setPeek((current) => !current);
          return;
        }
        const next = !open;
        setOpenOverride(next);
        setMcpAppToolClosed(binding.toolName, !next);
      }}
      onToggleHidden={() => {
        setMcpAppConnectorHidden(binding.serverKey, !hidden);
        setPeek(false);
      }}
      onOpenPane={() => {
        registerDockEntry();
        void requestMcpAppDisplayMode(entryId, "fullscreen");
      }}
      onDockAction={() => {
        if (dockShowing) void requestMcpAppDisplayMode(entryId, "inline");
        else showMcpAppDockEntry(entryId);
      }}
      onPromptAnswer={(answer) => controller.respondPrompt(answer)}
      onConnect={() => {
        void navigate({ to: "/plugins" });
        controller.respondPrompt(true);
      }}
      onDialogAnswer={(answer) => controller.respondDialog(answer)}
      onImageExpand={props.onImageExpand}
    />
  );
}

export function McpAppCard(props: McpAppCardProps) {
  // Projection updates arrive as new objects; keep the binding stable while its fields are.
  const resolved = resolveMcpAppBinding(props.projection);
  const bindingKey = resolved ? JSON.stringify(resolved) : "";
  const binding = useMemo(
    () => (bindingKey ? (JSON.parse(bindingKey) as McpAppBinding) : null),
    [bindingKey],
  );
  if (!binding) return null;
  return (
    <McpAppBlock
      key={`${binding.serverKey}\u0000${binding.resourceUri}`}
      {...props}
      binding={binding}
    />
  );
}
