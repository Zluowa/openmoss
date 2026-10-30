import * as path from "node:path";

import { app, BrowserWindow, ipcMain, session } from "electron";
import type { BrowserAnnotationEvent, ThreadBrowserState, ThreadId } from "@synara/contracts";

import {
  BROWSER_SESSION_PARTITION,
  DesktopBrowserManager,
} from "../../../desktop/src/browserManager";
import { BrowserUsePipeServer } from "../../../desktop/src/browserUsePipeServer";
import { BROWSER_IPC_CHANNELS } from "../../../desktop/src/ipcChannels";
import { hardenBrowserAnnotationWebviewPreferences } from "../../../desktop/src/browserAnnotations/webviewSecurity";
import { isClipboardWritePermission } from "../../../desktop/src/clipboardPermissions";
import { createBrowserPanelHideScheduler } from "../../src/components/BrowserPanel.logic";

const pipePath = process.env.MOSS_BROWSER_HOST_PIPE_PATH;
const capability = process.env.MOSS_BROWSER_HOST_CAPABILITY;
const shellPath = process.env.MOSS_E2E_SHELL_PATH;
const threadId = process.env.MOSS_E2E_THREAD_ID as ThreadId | undefined;
const mossHome = process.env.MOSS_HOME;
const annotationPreloadPath = process.env.MOSS_E2E_BROWSER_ANNOTATION_PRELOAD;

if (!pipePath || !capability || !shellPath || !threadId || !mossHome || !annotationPreloadPath) {
  throw new Error("The visible-browser Electron fixture requires its isolated E2E environment.");
}

app.setPath("userData", path.join(mossHome, "electron-userdata"));

// Mirror production configureMediaPermissions for the browser partition: agent
// clipboard writes land on the system clipboard, but guest pages must never
// read it back. Electron's default would grant reads in this fixture window.
// Sessions only exist once the app is ready, so this lives inside whenReady.
function configureBrowserSessionPermissions(): void {
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    isClipboardWritePermission(webContents, permission, details, requestingOrigin),
  );
  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(isClipboardWritePermission(webContents, permission, details)),
  );
}

const browserManager = new DesktopBrowserManager({ annotationPreloadPath });
let mainWindow: BrowserWindow | null = null;
let latestState: ThreadBrowserState | null = null;
let shellReady = false;
let panelRevealEnabled = true;
const annotationEvents: BrowserAnnotationEvent[] = [];
const rendererLifecycleHide = createBrowserPanelHideScheduler();
const PANEL_VISIBLE_BOUNDS = { x: 0, y: 34, width: 1_000, height: 726 } as const;
let panelVisible = false;
let panelSurface: "native" | "renderer" = "native";
let previewEnabled = false;
let pageZoomFactor = 1;
function syncPanelBounds(): void {
  browserManager.setPanelBounds({
    threadId,
    surface: panelSurface,
    bounds: panelVisible ? { ...PANEL_VISIBLE_BOUNDS } : null,
    pageZoomFactor,
    // Pass the flag explicitly both ways: setPanelBounds deletes the preview
    // lease whenever it is not === true.
    preview: previewEnabled,
  });
}
function setPanelVisible(visible: boolean): void {
  panelVisible = visible;
  syncPanelBounds();
  if (!visible) {
    browserManager.hide({ threadId });
    return;
  }
  pushState();
  mainWindow?.webContents.send("moss-e2e:open-panel");
}
function pushState(): void {
  if (shellReady && latestState && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("moss-e2e:browser-state", latestState);
  }
}

browserManager.subscribe((state) => {
  latestState = state;
  pushState();
});

ipcMain.on("moss-e2e:shell-ready", () => {
  shellReady = true;
  pushState();
});

ipcMain.handle(
  "moss-e2e:attach-webview",
  (event, input: { readonly tabId: string; readonly webContentsId: number }) =>
    browserManager.attachWebview({ threadId, ...input }, event.sender.id),
);
// The annotation/WebMCP guest preload sendSyncs here before installing its
// bridge; without a listener the renderer stalls for the full sync-IPC timeout
// (production registers the same handler in main.ts).
ipcMain.on(BROWSER_IPC_CHANNELS.webMcpCompatibilityPolicy, (event) => {
  event.returnValue = browserManager.isWebMcpCompatibilityAllowed(event.sender.id);
});
ipcMain.on(BROWSER_IPC_CHANNELS.annotations.guestMessage, (event, payload: unknown) => {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
  browserManager.handleAnnotationGuestMessage(event.sender, payload);
});
browserManager.subscribeAnnotationEvents((event) => {
  annotationEvents.push(event);
});

const pipeServer = new BrowserUsePipeServer(browserManager, {
  pipePath,
  capability,
  requestOpenPanel: (requestedThreadId) => {
    if (requestedThreadId !== threadId) throw new Error("Unexpected E2E thread scope.");
    // Exercise React development's setup/cleanup/setup sequence against the
    // real desktop human-control boundary. The remount must cancel the passive
    // cleanup before it can masquerade as a user takeover.
    rendererLifecycleHide.schedule(threadId, () => browserManager.hide({ threadId }));
    rendererLifecycleHide.cancel(threadId);
    if (panelRevealEnabled) setPanelVisible(true);
  },
});

Object.assign(globalThis, {
  __mossVisibleBrowserE2E: {
    browserManager,
    annotationEvents,
    threadId,
    pipePath,
    setPanelRevealEnabled(enabled: boolean) {
      panelRevealEnabled = enabled;
      setPanelVisible(enabled);
    },
    // Mirrors BrowserPanel's floating-preview lease: the native page stays
    // hidden while capturePreview paints a thumbnail of it.
    setPreviewEnabled(enabled: boolean) {
      previewEnabled = enabled;
      syncPanelBounds();
    },
    // Mirrors BrowserPanel's zoom sync: panel bounds carry the factor.
    setPageZoomFactor(value: number) {
      pageZoomFactor = value;
      syncPanelBounds();
    },
    // Mirrors BrowserPanel's surface switch between the native WebContentsView
    // and the renderer <webview> binding.
    setSurface(surface: "native" | "renderer") {
      panelSurface = surface;
      panelVisible = true;
      syncPanelBounds();
      pushState();
      mainWindow?.webContents.send("moss-e2e:open-panel");
    },
  },
});

app.whenReady().then(async () => {
  configureBrowserSessionPermissions();
  mainWindow = new BrowserWindow({
    width: 1_000,
    height: 760,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  browserManager.setWindow(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (
      !hardenBrowserAnnotationWebviewPreferences({
        partition: params.partition,
        expectedPartition: BROWSER_SESSION_PARTITION,
        preloadPath: annotationPreloadPath,
        webPreferences,
      })
    ) {
      event.preventDefault();
    }
  });
  await mainWindow.loadFile(shellPath);
  await pipeServer.start();
});

app.on("before-quit", () => {
  browserManager.dispose();
  void pipeServer.dispose();
});
