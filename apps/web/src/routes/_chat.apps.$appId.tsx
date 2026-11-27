// FILE: _chat.apps.$appId.tsx
// Purpose: Full view of one 应用页, supporting standalone desktop window mode
//          when `?standalone=1` or `?chrome=none` is set.
// Layer: Routing

import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { AppPageFrame } from "~/components/pageApps/AppPageFrame";
import {
  getDesktopNativePane,
  getDesktopPageAppsBridge,
  readTransparentFromWindowPayload,
} from "~/components/pageApps/capabilities/desktop";
import {
  SpaceCanvasChatDockHost,
  type SpaceCanvasActiveArtifact,
} from "~/components/space/SpaceCanvasChatDock";
import { useOptionalSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

export function isStandaloneAppPageSearch(search: Record<string, unknown> | undefined): boolean {
  if (!search) return false;
  if (search.chrome === "none") return true;
  const standalone = search.standalone;
  return standalone === 1 || standalone === "1" || standalone === true || standalone === "true";
}

export function isTransparentAppPageSearch(search: Record<string, unknown> | undefined): boolean {
  if (!search) return false;
  const transparent = search.transparent;
  return transparent === 1 || transparent === "1" || transparent === true || transparent === "true";
}

function AppPageRoute() {
  const { appId } = Route.useParams();
  const navigate = useNavigate();
  const search = useLocation({
    select: (location) => location.search as Record<string, unknown> | undefined,
  });
  const nativePane = getDesktopNativePane();
  const isStandalone = isStandaloneAppPageSearch(search) || nativePane?.chrome === "none";
  const initialTransparent = Boolean(
    isStandalone &&
    (isTransparentAppPageSearch(search) ||
      Boolean((nativePane as { transparent?: boolean } | null)?.transparent)),
  );
  const [liveTransparent, setLiveTransparent] = useState(initialTransparent);
  const [appTitle, setAppTitle] = useState("应用页");
  const dockHostRef = useRef<HTMLDivElement | null>(null);
  const isTransparent = Boolean(isStandalone && (initialTransparent || liveTransparent));
  const appArtifact = useMemo<SpaceCanvasActiveArtifact>(
    () => ({
      kind: "app",
      itemId: appId,
      title: appTitle,
      scopeSpaceId: null,
      account: "default",
    }),
    [appId, appTitle],
  );
  const sidebar = useOptionalSidebar();
  const setSidebarOpen = sidebar?.setOpen;

  useEffect(() => {
    setLiveTransparent(initialTransparent);
  }, [appId, initialTransparent]);

  useEffect(() => {
    if (!isStandalone) return;
    const bridge = getDesktopPageAppsBridge();
    if (!bridge) return;
    let cancelled = false;
    if (typeof bridge.invokeDesktopApi === "function") {
      void bridge
        .invokeDesktopApi({
          appId: appId as never,
          revision: 1,
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
      typeof bridge.onDesktopApiEvent === "function"
        ? bridge.onDesktopApiEvent((event) => {
            if (event.appId && event.appId !== appId) return;
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
  }, [appId, isStandalone]);

  useEffect(() => {
    if (isStandalone) {
      setSidebarOpen?.(false);
    }
  }, [isStandalone, setSidebarOpen]);

  useEffect(() => {
    if (!isTransparent || typeof document === "undefined") return;
    const prevHtmlBg = document.documentElement.style.backgroundColor;
    const prevBodyBg = document.body.style.backgroundColor;
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    return () => {
      document.documentElement.style.backgroundColor = prevHtmlBg;
      document.body.style.backgroundColor = prevBodyBg;
    };
  }, [isTransparent]);

  if (isStandalone) {
    return (
      <div
        ref={dockHostRef}
        data-testid="standalone-app-page-shell"
        data-standalone="true"
        data-transparent={isTransparent ? "true" : undefined}
        className={
          isTransparent
            ? "fixed inset-0 z-40 flex h-svh w-screen flex-col bg-transparent"
            : "fixed inset-0 z-40 flex h-svh w-screen flex-col bg-[var(--color-background-surface)]"
        }
      >
        {isTransparent ? (
          <AppPageFrame
            key={appId}
            appPageId={appId}
            mode="full"
            standalone
            chrome="none"
            transparent
            onTitleChange={setAppTitle}
          />
        ) : (
          <SpaceCanvasChatDockHost
            artifact={appArtifact}
            containerRef={dockHostRef}
            floatingLauncher="minimized"
            keepItemOpen
          >
            {(dock) => (
              <AppPageFrame
                key={appId}
                appPageId={appId}
                mode="full"
                standalone
                chrome="none"
                dock={dock}
                onTitleChange={setAppTitle}
              />
            )}
          </SpaceCanvasChatDockHost>
        )}
      </div>
    );
  }

  return (
    <div
      ref={dockHostRef}
      className={cn(
        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      <SpaceCanvasChatDockHost
        artifact={appArtifact}
        containerRef={dockHostRef}
        floatingLauncher="compact"
        keepItemOpen
      >
        {(dock) => (
          <>
            {/* Nothing sits above this view, so the frame's header is the window's top bar. */}
            <AppPageFrame
              key={appId}
              appPageId={appId}
              mode="full"
              topBar
              dock={dock}
              onTitleChange={setAppTitle}
              onDeleted={() => void navigate({ to: "/apps" })}
            />
          </>
        )}
      </SpaceCanvasChatDockHost>
    </div>
  );
}

export const Route = createFileRoute("/_chat/apps/$appId")({
  component: AppPageRoute,
});
