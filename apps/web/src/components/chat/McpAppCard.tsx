// FILE: McpAppCard.tsx
// Purpose: Inline MCP App transcript enhancement. The surrounding MCP tool row
// supplies the only header; this component owns only the bounded app surface.

import { useTranslation } from "~/localization";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import {
  CODEX_BROWSER_MCP_IFRAME_ALLOW,
  CODEX_BROWSER_MCP_IFRAME_REFERRER_POLICY,
  CODEX_BROWSER_MCP_IFRAME_SANDBOX,
} from "~/lib/mcpAppBrowserFrame";
import { McpAppHostController, type McpAppHostPhase } from "~/lib/mcpAppHost";
import {
  makeMcpAppDockEntryId,
  registerMcpAppDockEntry,
  resolveMcpAppDockTitle,
  requestMcpAppDisplayMode,
  updateMcpAppDockEntryNavigation,
  updateMcpAppDockEntryTitle,
  useMcpAppDockEntries,
} from "~/lib/mcpAppDockRegistry";
import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { CircleAlertIcon } from "~/lib/icons";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { McpAppNavigationControls } from "./McpAppNavigationControls";

export interface McpAppCardProps {
  readonly projection: WorkLogMcpToolResult;
  readonly threadId: string;
  readonly compact?: boolean;
  readonly theme?: "light" | "dark";
  readonly onPresentation?: (presentation: {
    phase: McpAppHostPhase;
    prefersBorder: boolean;
    isCollapsible: boolean;
  }) => void;
}

function currentTheme(fallback: "light" | "dark"): "light" | "dark" {
  if (typeof document === "undefined") return fallback;
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return document.documentElement.classList.contains("dark") ? "dark" : fallback;
}

function ErrorSurface(props: { message: string; retry?: (() => void) | undefined }) {
  return (
    <Alert
      variant="error"
      className="flex max-h-48 min-w-0 flex-wrap items-start gap-2 px-3.5 py-3"
      data-mcp-app-error={props.retry ? "sandbox" : "resource"}
    >
      <CircleAlertIcon className="mt-0.5 shrink-0" />
      <AlertDescription className="max-h-48 min-w-0 flex-1 overflow-auto text-ui-lg text-destructive">
        {props.message}
      </AlertDescription>
      {props.retry ? (
        <AlertAction className="items-center">
          <Button size="xs" variant="secondary" onClick={props.retry}>
            Try again
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

function LoadingSurface({ height }: { height: number }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { t } = useTranslation();
  return (
    <div
      className="relative w-full min-w-0 overflow-hidden bg-surface"
      style={{ height: `${height}px`, minHeight: `${height}px` }}
      role="status"
      aria-label={t("codex.mcpTool.mcpAppLoading")}
      data-mcp-app-expanding-placeholder="true"
      data-animate={reducedMotion ? "false" : "true"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-mcp-app-loading="true"
    >
      <motion.div
        className="pointer-events-none absolute inset-0 bg-codex-description/7 dark:bg-codex-description/14"
        initial={{ opacity: 0 }}
        animate={reducedMotion ? { opacity: 0 } : { opacity: [0, 1, 0] }}
        data-mcp-app-loading-animation={reducedMotion ? "none" : "pulse-3s"}
        transition={
          reducedMotion ? { duration: 0 } : { duration: 3, ease: "easeInOut", repeat: Infinity }
        }
      />
    </div>
  );
}

function errorCopy(message: string | undefined): string {
  if (message?.startsWith("Failed to load MCP app:")) return message;
  return `Failed to load MCP app: ${message ?? "Unable to start MCP app sandbox."}`;
}

export function McpAppCard(props: McpAppCardProps) {
  const { t } = useTranslation();
  const { projection, threadId } = props;
  const app = projection.app;
  const hasApp = app !== undefined;
  const appName = app?.appName;
  const actionName = app?.actionName;
  const dockTitle = resolveMcpAppDockTitle(appName, actionName, projection.tool);
  const hostContainerRef = useRef<HTMLDivElement>(null);
  const presentationCallbackRef = useRef(props.onPresentation);
  const theme = props.theme ?? currentTheme("light");
  const entryId = useMemo(
    () => makeMcpAppDockEntryId(threadId, projection.callId, app?.resourceUri ?? ""),
    [app?.resourceUri, projection.callId, threadId],
  );
  // Keep the controller lifetime bound to every provider identity field while
  // retaining only a fixed-size opaque key in the controller identity.
  const controllerIdentityKey = useMemo(
    () =>
      makeMcpAppDockEntryId(
        threadId,
        `${projection.callId}\u0000${projection.server}\u0000${app?.source ?? ""}\u0000${app?.connectorId ?? ""}`,
        app?.resourceUri ?? "",
      ),
    [
      app?.connectorId,
      app?.resourceUri,
      app?.source,
      projection.callId,
      projection.server,
      threadId,
    ],
  );
  const projectionForControllerRef = useRef(projection);
  const themeForControllerRef = useRef(theme);
  const controllerRef = useRef<McpAppHostController | null>(null);
  const unregisterEntryRef = useRef<(() => Promise<void>) | null>(null);
  const dockTitleRef = useRef(dockTitle);
  const controllerIdentity = useMemo(
    () => ({
      callId: projection.callId,
      lifecycleKey: controllerIdentityKey,
      resourceUri: app?.resourceUri ?? "",
      threadId,
    }),
    [app?.resourceUri, controllerIdentityKey, projection.callId, threadId],
  );
  presentationCallbackRef.current = props.onPresentation;
  projectionForControllerRef.current = projection;
  themeForControllerRef.current = theme;
  dockTitleRef.current = dockTitle;
  const registerDockEntry = useCallback(() => {
    const activeController = controllerRef.current;
    if (!hasApp || !activeController || unregisterEntryRef.current) return;
    unregisterEntryRef.current = registerMcpAppDockEntry({
      id: entryId,
      threadId,
      title: dockTitleRef.current,
      getInlineContainer: () => hostContainerRef.current,
      layoutFrameTo: (target, displayMode) => activeController.layoutFrameTo(target, displayMode),
      navigate: (delta) => activeController.navigate(delta),
      setFrameVisibility: (visible) => activeController.setFrameVisibility(visible),
      onUnregistered: () => {
        unregisterEntryRef.current = null;
      },
    });
    const currentSnapshot = activeController.getSnapshot();
    updateMcpAppDockEntryNavigation(
      entryId,
      currentSnapshot.canGoBack,
      currentSnapshot.canGoForward,
    );
  }, [entryId, hasApp, threadId]);
  const controller = useMemo(
    () =>
      new McpAppHostController({
        identity: controllerIdentity,
        projection: projectionForControllerRef.current,
        theme: themeForControllerRef.current,
        onRequestDisplayMode: (mode) => {
          registerDockEntry();
          return requestMcpAppDisplayMode(entryId, mode).then((result) => result.mode);
        },
      }),
    [controllerIdentity, entryId, registerDockEntry],
  );
  controllerRef.current = controller;
  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    controller.getSnapshot.bind(controller),
  );
  const dockEntry = useMcpAppDockEntries(threadId).find((entry) => entry.id === entryId);

  useEffect(() => {
    const container = hostContainerRef.current;
    if (!container || !hasApp) return;
    registerDockEntry();
    void controller.start(container).catch(() => undefined);
    return () => {
      const unregister = unregisterEntryRef.current;
      unregisterEntryRef.current = null;
      void unregister?.().catch(() => undefined);
      void controller.teardown().catch(() => undefined);
    };
  }, [controller, entryId, hasApp, registerDockEntry, threadId]);

  useEffect(() => {
    if (!hasApp) return;
    updateMcpAppDockEntryTitle(entryId, dockTitle);
  }, [dockTitle, entryId, hasApp]);

  useEffect(() => {
    if (!hasApp) return;
    updateMcpAppDockEntryNavigation(entryId, snapshot.canGoBack, snapshot.canGoForward);
  }, [entryId, hasApp, snapshot.canGoBack, snapshot.canGoForward]);

  useEffect(() => {
    if (!hasApp) return;
    controller.updateProjection(projection);
    controller.updateTheme(theme);
  }, [controller, hasApp, projection, theme]);

  useEffect(() => {
    if (!hasApp) return;
    presentationCallbackRef.current?.({
      phase: snapshot.phase,
      prefersBorder: snapshot.prefersBorder,
      isCollapsible: snapshot.isCollapsible,
    });
  }, [hasApp, snapshot.isCollapsible, snapshot.phase, snapshot.prefersBorder]);

  if (!app) return null;

  const loading = snapshot.phase === "loading";
  const browserUnavailable = snapshot.phase === "browser_unavailable";
  const resourceError = snapshot.phase === "resource_error" || snapshot.phase === "too_large";
  const sandboxError = snapshot.phase === "sandbox_error";
  const noContent = snapshot.phase === "no_content";
  const ready = snapshot.phase === "ready";
  const inline =
    snapshot.displayMode === "inline" && dockEntry?.requestedDisplayMode !== "fullscreen";
  const hostStyle =
    ready && inline
      ? { height: `${snapshot.height}px`, minHeight: `${snapshot.height}px` }
      : { height: "0px", minHeight: "0px" };
  const navigationPortalTarget = controller.getNavigationPortalTarget();
  const hasNavigationHistory = snapshot.canGoBack || snapshot.canGoForward;
  const inlineNavigation =
    inline && hasNavigationHistory && navigationPortalTarget
      ? createPortal(
          <div className="absolute top-2 left-2 z-50 rounded-md border border-default bg-surface/95 p-0.5 shadow-sm">
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
    <div
      className={cn("w-full min-w-0", props.compact && "text-ui-lg")}
      data-mcp-app-card="true"
      data-mcp-app-phase={snapshot.phase}
      data-mcp-app-display-mode={snapshot.displayMode}
    >
      {inlineNavigation}
      <div className="relative w-full min-w-0" data-mcp-app-content="true">
        {loading ? <LoadingSurface height={snapshot.height} /> : null}
        <div
          ref={hostContainerRef}
          className={cn(
            "relative flex min-h-0 w-full min-w-0 flex-col overflow-hidden",
            // widget.js inline surface: rounded-lg + outline/shadow. Browser
            // srcdoc is the resource itself, so it is visible immediately
            // (desktop webview stays opacity-0 until sandbox-resource-ready).
            ready && snapshot.browserHtml && "mcp-app-card-sandbox bg-surface",
          )}
          style={hostStyle}
          data-mcp-app-frame="true"
          data-mcp-app-inline-surface="card"
          data-mcp-app-ready={ready ? "true" : undefined}
          data-mcp-app-border={snapshot.prefersBorder ? "true" : undefined}
          aria-hidden={!ready}
        >
          {ready && snapshot.browserHtml ? (
            <iframe
              title={dockTitle}
              srcDoc={snapshot.browserHtml}
              sandbox={CODEX_BROWSER_MCP_IFRAME_SANDBOX}
              referrerPolicy={CODEX_BROWSER_MCP_IFRAME_REFERRER_POLICY}
              allow={CODEX_BROWSER_MCP_IFRAME_ALLOW}
              className="h-full w-full border-0 bg-surface"
              data-mcp-app-browser-frame="true"
            />
          ) : null}
        </div>
        {browserUnavailable ? (
          <p
            className="w-full px-4 py-3 text-ui-lg text-muted-foreground"
            data-mcp-app-desktop-only="true"
          >
            {t("codex.mcpTool.desktopOnly")}
          </p>
        ) : null}
        {resourceError ? <ErrorSurface message={errorCopy(snapshot.errorMessage)} /> : null}
        {sandboxError ? (
          <ErrorSurface
            message={errorCopy(snapshot.errorMessage)}
            retry={
              snapshot.canRetry
                ? () => void controller.retry(hostContainerRef.current ?? undefined)
                : undefined
            }
          />
        ) : null}
        {noContent ? (
          <div className="w-full min-w-0 rounded-lg border border-border bg-surface-muted px-4 py-3 text-ui-lg text-muted-foreground">
            {snapshot.errorMessage ?? "MCP app returned no HTML content"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
