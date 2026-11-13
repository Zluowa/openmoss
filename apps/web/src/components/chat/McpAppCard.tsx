// FILE: McpAppCard.tsx
// Purpose: A connector widget's transcript block, wired to its host. The live widget (host
//          controller + side-panel entry) is shared per tool call (`liveWidgets.ts`), so it
//          survives this row remounting; the row lends it a slot, per-device preferences, the
//          composer (for `ui/message`) and toasts. McpAppBlockView draws it.
// Layer: Chat transcript UI
// Exports: McpAppCard, McpAppTurnWidgets

import type { ThreadId } from "@moss/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { useComposerDraftStore } from "../../composerDraftStore";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useTheme } from "~/hooks/useTheme";
import { useResidentRuntime } from "~/lib/dockRuntimeResidency";
import { McpAppHostController, type McpAppHostSnapshot } from "~/lib/mcpAppHost";
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
import { useMcpAppCallAwaitingApproval } from "~/lib/mcpApps/awaitingApproval";
import { resolveMcpAppBinding } from "~/lib/mcpApps/binding";
import type { McpAppBinding } from "~/lib/mcpApps/contracts";
import { mcpAppStylesForThemePacks } from "~/lib/mcpApps/hostStyles";
import {
  acquireMcpAppWidget,
  mcpAppRowStartState,
  releaseMcpAppWidget,
  type McpAppLiveWidget,
} from "~/lib/mcpApps/liveWidgets";
import {
  hashMcpAppKey,
  setMcpAppConnectorHidden,
  setMcpAppToolClosed,
  useMcpAppPreferences,
} from "~/lib/mcpApps/preferences";
import { mcpAppHeightKey, readRememberedMcpAppHeight } from "~/lib/mcpApps/sizing";
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

interface WidgetContext {
  readonly format: ReturnType<typeof useTranslation>["format"];
  readonly t: ReturnType<typeof useTranslation>["t"];
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly open: boolean;
}

type LiveWidget = McpAppLiveWidget<WidgetContext>;

const IDLE_SNAPSHOT: McpAppHostSnapshot = {
  phase: "idle",
  height: 0,
  sized: false,
  displayMode: "inline",
  generation: 0,
  prefersBorder: true,
  fullscreenDeclined: false,
  canGoBack: false,
  canGoForward: false,
  prompt: null,
  dialog: null,
};
const noSubscription = () => () => undefined;

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

function createLiveWidget(
  widget: LiveWidget,
  input: {
    readonly id: string;
    readonly threadId: string;
    readonly binding: McpAppBinding;
    readonly projection: WorkLogMcpToolResult;
    readonly theme: "light" | "dark";
    readonly locale: string;
    readonly styles: ReturnType<typeof mcpAppStylesForThemePacks>;
  },
) {
  const { id, threadId, binding } = input;
  const controller = new McpAppHostController({
    projection: input.projection,
    binding,
    identity: {
      threadId,
      callId: input.projection.callId,
      resourceUri: binding.resourceUri,
      lifecycleKey: id,
    },
    theme: input.theme,
    locale: input.locale,
    styles: input.styles,
    paneAvailable: () => hasMcpAppDockHost(threadId),
    onRequestDisplayMode: (mode) => requestMcpAppDisplayMode(id, mode).then((r) => r.mode),
    message: {
      readComposer: () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId as ThreadId]?.prompt ?? "",
      writeComposer: (text) =>
        useComposerDraftStore.getState().setPrompt(threadId as ThreadId, text),
      askReplace: (serverLabel, timeoutMs) =>
        askReplaceWithToast(
          threadId,
          widget.context.format("mcpApp.message.replacePrompt", { serverName: serverLabel }),
          widget.context.t("mcpApp.message.replaceAction"),
          timeoutMs,
        ),
      // No thread surface sends a widget's message by itself yet (no first-party widget
      // tools this round, SPEC §12), so every message lands in the composer.
      sendNow: null,
      notifySent: (serverLabel) =>
        toastManager.add({
          title: widget.context.format("mcpApp.message.sent", { serverName: serverLabel }),
          data: { threadId: threadId as ThreadId },
        }),
    },
    openInApp: (path) => void widget.context.navigate({ href: path }),
  });
  const unregister = registerMcpAppDockEntry({
    id,
    threadId,
    title: binding.toolTitle ?? binding.serverLabel,
    getInlineContainer: () => controller.getInlineContainer(),
    layoutFrameTo: (target, displayMode) => controller.layoutFrameTo(target, displayMode),
    navigate: (delta) => controller.navigate(delta),
    setFrameVisibility: (visible) => {
      widget.registryVisible = visible;
      const docked = controller.getSnapshot().displayMode === "fullscreen";
      controller.setFrameVisibility(visible && (docked || widget.context.open));
    },
  });
  return {
    controller,
    dispose: () => {
      void unregister().catch(() => undefined);
      void controller.teardown().catch(() => undefined);
    },
  };
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
  // The widget starts the first time its block is open and its call is allowed to run; it
  // keeps running while collapsed. Nothing mounts while the call waits for approval.
  const awaitingApproval = useMcpAppCallAwaitingApproval(
    threadId,
    binding,
    projection.status === "inProgress",
  );
  const entryId = useMemo(
    () => makeMcpAppDockEntryId(threadId, projection.callId, binding.resourceUri),
    [binding.resourceUri, projection.callId, threadId],
  );
  // A row that remounts (its turn folded or finished) starts from the call's running widget, so
  // it keeps its height and takes the frame back before it paints (see mcpAppRowStartState).
  const [startState] = useState(() =>
    mcpAppRowStartState(
      entryId,
      readRememberedMcpAppHeight(mcpAppHeightKey(threadId, projection.callId)),
    ),
  );
  const [started, setStarted] = useState(startState.started);
  useEffect(() => {
    if (open && !awaitingApproval) setStarted(true);
  }, [awaitingApproval, open]);
  const dockTitle = binding.toolTitle ?? binding.serverLabel;
  const context: WidgetContext = { format, t, navigate, open };
  const createInput = useRef({ projection, theme, locale, styles });
  createInput.current = { projection, theme, locale, styles };
  const [widget, setWidget] = useState<LiveWidget | null>(null);
  const widgetRef = useRef<LiveWidget | null>(null);
  if (widgetRef.current) widgetRef.current.context = context;

  useLayoutEffect(() => {
    const acquired = acquireMcpAppWidget<WidgetContext>(entryId, context, (live) =>
      createLiveWidget(live, { id: entryId, threadId, binding, ...createInput.current }),
    );
    widgetRef.current = acquired;
    setWidget(acquired);
    return () => {
      widgetRef.current = null;
      releaseMcpAppWidget(entryId);
    };
    // The widget is shared per call id; the context above is refreshed on every render.
  }, [binding, entryId, threadId]);

  const controller = widget?.controller ?? null;
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(listener) ?? noSubscription(),
    [controller],
  );
  const startSnapshot = useMemo<McpAppHostSnapshot>(
    () => startState.snapshot ?? { ...IDLE_SNAPSHOT, height: startState.height },
    [startState],
  );
  const getSnapshot = useCallback(
    () => controller?.getSnapshot() ?? startSnapshot,
    [controller, startSnapshot],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const dockEntry = useMcpAppDockEntries(threadId).find((entry) => entry.id === entryId);
  const dockState = useRightDockStore(
    useMemo(() => selectRightDockState(threadId as ThreadId), [threadId]),
  );
  const docked =
    dockEntry !== undefined &&
    (dockEntry.displayMode === "fullscreen" || dockEntry.requestedDisplayMode === "fullscreen");
  const dockShowing = docked && dockState.open && dockEntry?.selected === true;

  // The side panel's shared residency policy (lib/dockRuntimeResidency.ts): an app collapsed out
  // of sight is told and unloaded after a while, or when the window holds too many, and starts
  // again from its tool result when it is shown. An app in the side panel, or one asking the
  // person something, counts as in use and stays.
  const residency = useResidentRuntime({
    active: started && controller !== null,
    key: `app:${entryId}`,
    owner: threadId,
    runtimeClass: "appWidget",
    visible: docked ? dockShowing : open,
    pinned: docked || snapshot.prompt !== null || snapshot.dialog !== null,
    suspend: async () => {
      await controller?.suspend();
      return true;
    },
  });

  // Lend this row's slot to the live widget (it starts there the first time, and again after
  // the residency policy unloaded it).
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!controller || !slot || !started || !residency.loaded) return;
    controller.attachInline(slot);
    return () => controller.detachInline(slot);
  }, [controller, slot, started, residency.loaded]);

  useEffect(() => {
    controller?.updateProjection(projection);
  }, [controller, projection]);
  useEffect(() => {
    controller?.updateTheme(theme);
    controller?.updateLocale(locale);
    controller?.updateStyles(styles);
  }, [controller, locale, styles, theme]);
  useEffect(() => {
    if (!controller || !widget) return;
    controller.setFrameVisibility(widget.registryVisible && (open || docked));
  }, [controller, docked, open, widget]);
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
  const navigationPortalTarget = controller?.getNavigationPortalTarget() ?? null;
  const inlineNavigation =
    controller &&
    open &&
    !docked &&
    (snapshot.canGoBack || snapshot.canGoForward) &&
    navigationPortalTarget
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
      frameRef={setSlot}
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
      onOpenPane={() => void requestMcpAppDisplayMode(entryId, "fullscreen")}
      onDockAction={() => {
        if (dockShowing) void requestMcpAppDisplayMode(entryId, "inline");
        else showMcpAppDockEntry(entryId);
      }}
      onPromptAnswer={(answer) => controller?.respondPrompt(answer)}
      onConnect={() => {
        void navigate({ to: "/plugins" });
        controller?.respondPrompt(true);
      }}
      onDialogAnswer={(answer) => controller?.respondDialog(answer)}
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

/**
 * The widgets of a folded turn, drawn after its 「已工作」 group so they stay visible (their tool
 * rows stay inside the group and draw no widget there).
 */
export function McpAppTurnWidgets(props: {
  readonly projections: readonly WorkLogMcpToolResult[];
  readonly threadId: string;
  readonly theme?: "light" | "dark";
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  if (props.projections.length === 0) return null;
  return (
    <div className="mb-3 flex min-w-0 flex-col gap-3" data-mcp-app-turn-widgets="true">
      {props.projections.map((projection) => (
        <McpAppCard
          key={projection.callId}
          projection={projection}
          threadId={props.threadId}
          {...(props.theme ? { theme: props.theme } : {})}
          onImageExpand={props.onImageExpand}
        />
      ))}
    </div>
  );
}
