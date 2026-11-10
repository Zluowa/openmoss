// FILE: browserPanelIpc.ts
// Purpose: IPC for the browser panel's "…" menu: allowed sites for local pages, cookie
//   retention, clearing browsing data, the default browser's name, saving a screenshot,
//   picking an HTML file, and the push when a local page was stopped from leaving.
// Layer: Desktop IPC adapter

import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  app,
  dialog,
  session,
  shell,
  type BrowserWindow,
  type IpcMain,
  type WebContents,
} from "electron";
import type {
  BrowserAllowNavigationInput,
  BrowserBlockedNavigationEvent,
  BrowserCookieRetention,
  BrowserTabInput,
} from "@moss/contracts";

import type { DesktopBrowserManager } from "./browserManager";
import type { BrowserPanelPreferenceStore } from "./browserPanelPreferences";
import { BROWSER_SESSION_PARTITION } from "./browserSessionPolicy";
import { BROWSER_IPC_CHANNELS } from "./ipcChannels";
import { registerSentryIpcHandler } from "./observability/sentry";

const PANEL_CHANNELS = BROWSER_IPC_CHANNELS.panel;
const HTML_FILE_EXTENSIONS = ["html", "htm", "xhtml"];

export function sendBrowserBlockedNavigation(
  webContents: WebContents | null | undefined,
  event: BrowserBlockedNavigationEvent,
): void {
  webContents?.send(PANEL_CHANNELS.blockedNavigation, event);
}

/** Cookies, storage, cache and saved HTTP auth of the browser panel's session. */
export async function clearBrowserPanelData(): Promise<void> {
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  await Promise.allSettled([
    browserSession.clearStorageData(),
    browserSession.clearCache(),
    browserSession.clearAuthCache(),
    browserSession.clearHostResolverCache(),
  ]);
}

/** A file name for a screenshot of `title`: no path characters, never empty. */
export function browserScreenshotFileName(title: string, now = new Date()): string {
  const stem =
    title
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Screenshot";
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${stem} ${stamp}.png`;
}

/**
 * Opens `url` in the default web browser. A web page goes through the system; a local page's
 * file is handed to the browser program itself, because the system would open an `.html`
 * file with whatever app its extension is set to (often an editor).
 */
export async function openInDefaultBrowser(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That page address is not valid.");
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    await shell.openExternal(parsed.href);
    return;
  }
  if (parsed.protocol !== "file:") throw new Error("Only web pages and local files can open.");
  const filePath = fileURLToPath(parsed);
  const browser = await app.getApplicationInfoForProtocol("https://").catch(() => null);
  const program = browser?.path?.trim() ?? "";
  if (/\.exe$/i.test(program) || (process.platform === "darwin" && program.endsWith(".app"))) {
    const launched = await new Promise<boolean>((resolve) => {
      const child =
        process.platform === "darwin"
          ? spawn("open", ["-a", program, filePath], { detached: true, stdio: "ignore" })
          : spawn(program, [filePath], { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
    if (launched) return;
  }
  const failure = await shell.openPath(filePath);
  if (failure) throw new Error(failure);
}

export function registerBrowserPanelIpcHandlers(
  ipcMain: IpcMain,
  input: {
    readonly browserManager: DesktopBrowserManager;
    readonly preferences: BrowserPanelPreferenceStore;
    readonly getWindow: () => BrowserWindow | null;
  },
): void {
  const { browserManager, preferences, getWindow } = input;
  const register = (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void => {
    ipcMain.removeHandler(channel);
    registerSentryIpcHandler(ipcMain, channel, handler);
  };
  const requireTrustedRenderer = (senderId: number): void => {
    if (!browserManager.isTrustedRenderer(senderId)) {
      throw new Error("Browser panel IPC rejected an untrusted renderer.");
    }
  };

  register(PANEL_CHANNELS.getPreferences, (event) => {
    requireTrustedRenderer(event.sender.id);
    return preferences.get();
  });
  register(PANEL_CHANNELS.addAllowedSite, (event, site: string) => {
    requireTrustedRenderer(event.sender.id);
    return preferences.addAllowedSite(String(site));
  });
  register(PANEL_CHANNELS.removeAllowedSite, (event, site: string) => {
    requireTrustedRenderer(event.sender.id);
    return preferences.removeAllowedSite(String(site));
  });
  register(PANEL_CHANNELS.setCookieRetention, (event, value: BrowserCookieRetention) => {
    requireTrustedRenderer(event.sender.id);
    return preferences.setCookieRetention(value);
  });
  register(PANEL_CHANNELS.clearBrowsingData, async (event) => {
    requireTrustedRenderer(event.sender.id);
    await clearBrowserPanelData();
  });
  register(PANEL_CHANNELS.getDefaultBrowserName, (event) => {
    requireTrustedRenderer(event.sender.id);
    try {
      const name = app.getApplicationNameForProtocol("https://example.com").trim();
      return name.length > 0 ? name.replace(/\.exe$/i, "") : null;
    } catch {
      return null;
    }
  });
  register(PANEL_CHANNELS.openInBrowser, async (event, url: unknown) => {
    requireTrustedRenderer(event.sender.id);
    if (typeof url !== "string") throw new Error("A page address is required.");
    await openInDefaultBrowser(url);
  });
  register(PANEL_CHANNELS.saveScreenshot, async (event, tab: BrowserTabInput) => {
    requireTrustedRenderer(event.sender.id);
    const screenshot = await browserManager.captureScreenshot(tab);
    const title =
      browserManager
        .getState({ threadId: tab.threadId })
        .tabs.find((entry) => entry.id === tab.tabId)?.title ?? "";
    const window = getWindow();
    const options: Electron.SaveDialogOptions = {
      defaultPath: Path.join(app.getPath("downloads"), browserScreenshotFileName(title)),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await FS.writeFile(result.filePath, screenshot.bytes);
    return result.filePath;
  });
  register(PANEL_CHANNELS.pickHtmlFile, async (event) => {
    requireTrustedRenderer(event.sender.id);
    const window = getWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile"],
      filters: [{ name: "Web page", extensions: HTML_FILE_EXTENSIONS }],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  register(PANEL_CHANNELS.allowNavigation, (event, request: BrowserAllowNavigationInput) => {
    requireTrustedRenderer(event.sender.id);
    preferences.addAllowedSite(request.url);
    // A programmatic load, so the page's own navigation guard does not apply to it.
    return browserManager.navigate({
      threadId: request.threadId,
      tabId: request.tabId,
      url: request.url,
    });
  });
}
