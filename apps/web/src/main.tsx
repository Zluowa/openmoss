import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "./index.css";
import "./phoneShell.css";

import { appHistory } from "./appNavigation";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { waitForBootstrapPaint } from "./bootstrapPaint";
import { isElectron } from "./env";
import { installZhCnUiLocalization } from "./localization/zhCN";
import { isMacPlatform } from "./lib/utils";
import { installGlassOverlayCutout } from "./lib/glassOverlayCutout";
import { installRendererErrorDiagnostics } from "./lib/rendererErrorDiagnostics";
import { installMossSelfReportIfEnabled } from "./lib/selfReport/install";
import { getSentryReactRootOptions, initializeSentry, SentryErrorBoundary } from "./observability";

const disposeRendererDiagnostics = installRendererErrorDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(() => disposeRendererDiagnostics?.());
// Self-report tools for agents checking Moss's own screen: development builds, or a desktop app
// started with self-report enabled in an isolated profile. Nothing is installed otherwise.
const disposeSelfReport = installMossSelfReportIfEnabled();
if (import.meta.hot) import.meta.hot.dispose(() => disposeSelfReport?.());

const sentryEnabled = initializeSentry();

const router = getRouter(appHistory);
const rootElement = document.getElementById("root") as HTMLElement;

function BootstrapSplashDismissal() {
  React.useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;

    let cancelled = false;
    let scheduled = false;
    let observer: MutationObserver | null = null;
    const scheduleDismissal = () => {
      if (cancelled || scheduled || root.childElementCount === 0) return;
      scheduled = true;
      observer?.disconnect();
      void waitForBootstrapPaint().then(() => {
        if (!cancelled) document.getElementById("app-boot-splash")?.remove();
      });
    };
    observer = new MutationObserver(scheduleDismissal);
    observer.observe(root, { childList: true });
    scheduleDismissal();

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, []);
  return null;
}

document.title = APP_DISPLAY_NAME;
installZhCnUiLocalization();

if (isElectron) {
  document.documentElement.dataset.runtime = "electron";
  // macOS desktop windows are transparent vibrancy windows (see getWindowMaterialOptions
  // in apps/desktop). A `backdrop-filter` cannot hide page content over a see-through
  // region there, so floating overlays get the page cut out from under them instead.
  if (isMacPlatform(navigator.platform)) {
    document.documentElement.dataset.windowTransparent = "true";
    const disposeGlassOverlayCutout = installGlassOverlayCutout(rootElement);
    if (import.meta.hot) import.meta.hot.dispose(disposeGlassOverlayCutout);
  }
}

const app = (
  <React.StrictMode>
    <BootstrapSplashDismissal />
    <RouterProvider router={router} />
  </React.StrictMode>
);

ReactDOM.createRoot(rootElement, getSentryReactRootOptions()).render(
  sentryEnabled ? (
    <SentryErrorBoundary
      fallback={
        <div className="flex min-h-screen items-center justify-center p-8 text-ui-lg text-muted-foreground">
          Moss 遇到显示错误，请重启应用后重试。
        </div>
      }
    >
      {app}
    </SentryErrorBoundary>
  ) : (
    app
  ),
);
