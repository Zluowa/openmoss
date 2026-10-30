import {
  ipcMain,
  net,
  session,
  type BrowserWindow,
  type Session,
  type WebContents,
} from "electron";
import type { HtmlPreviewDescriptor } from "@synara/contracts";
import { DESKTOP_IPC_CHANNELS } from "../ipcChannels";
import { LOCAL_HTML_PREVIEW_SCHEME } from "../localHtmlPreviewProtocol";
import { registerSentryIpcHandler } from "../observability/sentry";
import {
  HtmlPreviewDocument,
  HTML_PREVIEW_PARTITION_PREFIX,
  isAllowedHtmlPreviewRequest,
} from "./document";

export const HTML_PREVIEW_ATTACH_TIMEOUT_MS = 30_000;
const MAX_PREVIEWS = 32;
const MAX_PREVIEWS_PER_OWNER = 8;

function isSamePreviewDocument(value: string, expected: string): boolean {
  try {
    const actual = new URL(value);
    const source = new URL(expected);
    return (
      actual.protocol === source.protocol &&
      actual.host === source.host &&
      actual.pathname === source.pathname &&
      actual.search === source.search &&
      !actual.username &&
      !actual.password &&
      !actual.port
    );
  } catch {
    return false;
  }
}

interface Registration {
  ownerId: number;
  document: HtmlPreviewDocument;
  session: Session;
  consumed: boolean;
  timer: ReturnType<typeof setTimeout>;
  guest?: WebContents;
  readonly downloadHandler: (event: Electron.Event) => void;
}

/** Host authority for previews; the guest receives no preload or message bridge. */
export class HtmlPreviewRuntime {
  private readonly owners = new Set<number>();
  private readonly registrations = new Map<string, Registration>();

  attachOwner(window: BrowserWindow): void {
    const id = window.webContents.id;
    this.owners.add(id);
    window.webContents.once("destroyed", () => {
      this.owners.delete(id);
      for (const [key, registration] of this.registrations) {
        if (registration.ownerId === id) this.release(key);
      }
    });
  }

  async register(ownerId: number, input: unknown): Promise<HtmlPreviewDescriptor> {
    this.assertCapacity(ownerId);
    const document = await HtmlPreviewDocument.create(input);
    try {
      // Owner destruction or concurrent requests can race file resolution.
      this.assertCapacity(ownerId);
      const { descriptor } = document;
      const partitionSession = session.fromPartition(descriptor.partition);
      partitionSession.setPermissionCheckHandler(() => false);
      partitionSession.setPermissionRequestHandler((_guest, _permission, callback) =>
        callback(false),
      );
      partitionSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !isAllowedHtmlPreviewRequest(details.url, descriptor.src) });
      });
      const downloadHandler = (event: Electron.Event) => event.preventDefault();
      partitionSession.on("will-download", downloadHandler);
      partitionSession.protocol.handle(LOCAL_HTML_PREVIEW_SCHEME, (request) =>
        document.respond(request, (url) => net.fetch(url)),
      );
      const registration: Registration = {
        ownerId,
        document,
        session: partitionSession,
        consumed: false,
        timer: setTimeout(() => this.release(descriptor.id), HTML_PREVIEW_ATTACH_TIMEOUT_MS),
        downloadHandler,
      };
      this.registrations.set(descriptor.id, registration);
      return descriptor;
    } catch (error) {
      document.dispose();
      throw error;
    }
  }

  unregister(ownerId: number, input: unknown): boolean {
    if (!input || typeof input !== "object" || !("id" in input) || typeof input.id !== "string")
      return false;
    const registration = this.registrations.get(input.id);
    if (!registration || registration.ownerId !== ownerId) return false;
    this.release(input.id);
    return true;
  }

  handleWillAttachWebview(
    ownerId: number,
    event: { preventDefault(): void },
    webPreferences: object,
    params: { readonly partition?: string; readonly src?: string },
  ): boolean {
    if (!params.partition?.startsWith(HTML_PREVIEW_PARTITION_PREFIX)) return false;
    const id = params.partition.slice(HTML_PREVIEW_PARTITION_PREFIX.length);
    const registration = this.registrations.get(id);
    if (
      !registration ||
      registration.ownerId !== ownerId ||
      registration.consumed ||
      params.partition !== registration.document.descriptor.partition ||
      params.src !== registration.document.descriptor.src
    ) {
      event.preventDefault();
      return true;
    }
    registration.consumed = true;
    clearTimeout(registration.timer);
    // The pre-attach lease is consumed by will-attach. Keep a second short
    // lease until Electron confirms did-attach, otherwise a rejected attach
    // would leave the custom session registered indefinitely.
    registration.timer = setTimeout(() => this.release(id), HTML_PREVIEW_ATTACH_TIMEOUT_MS);
    // Never accept a renderer-supplied preload, Session, or permissive flag.
    const preferences = webPreferences as Record<string, unknown>;
    delete preferences.preload;
    Object.assign(preferences, {
      session: registration.session,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
    });
    return true;
  }

  handleDidAttachWebview(ownerId: number, guest: WebContents): boolean {
    const match = [...this.registrations.entries()].find(
      ([, value]) => value.session === guest.session,
    );
    if (!match) return false;
    const [id, registration] = match;
    let src = "";
    try {
      src = guest.getURL();
    } catch {
      /* Guest teardown may race attachment. */
    }
    if (
      registration.ownerId !== ownerId ||
      !registration.consumed ||
      registration.guest ||
      (src !== "" && src !== registration.document.descriptor.src)
    ) {
      if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
      return true;
    }
    clearTimeout(registration.timer);
    registration.guest = guest;
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-attach-webview", (event) => event.preventDefault());
    const navigationHandler = (event: { preventDefault(): void }, url: string) => {
      // Keep the guest's main frame on the registered document. Links may
      // still open through the host's normal external-browser affordance.
      if (!isSamePreviewDocument(url, registration.document.descriptor.src)) event.preventDefault();
    };
    guest.on("will-navigate", navigationHandler);
    guest.on("will-redirect", (event: { preventDefault(): void }) => event.preventDefault());
    guest.on(
      "will-frame-navigate",
      (event: { preventDefault(): void; url?: string; isMainFrame?: boolean }) => {
        if (
          typeof event.url !== "string" ||
          (event.isMainFrame !== false &&
            !isSamePreviewDocument(event.url, registration.document.descriptor.src)) ||
          (event.isMainFrame === false &&
            !isAllowedHtmlPreviewRequest(event.url, registration.document.descriptor.src))
        ) {
          event.preventDefault();
        }
      },
    );
    guest.on(
      "did-fail-load",
      (
        _event: Electron.Event,
        _code: number,
        _description: string,
        _url: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) this.release(id);
      },
    );
    guest.on(
      "did-navigate-in-page",
      (_event: Electron.Event, url: string, isMainFrame: boolean) => {
        if (isMainFrame && !isSamePreviewDocument(url, registration.document.descriptor.src))
          this.release(id);
      },
    );
    guest.once("destroyed", () => this.release(id));
    guest.once("render-process-gone", () => this.release(id));
    return true;
  }

  registerIpcHandlers(): void {
    const channels = DESKTOP_IPC_CHANNELS.htmlPreview;
    ipcMain.removeHandler(channels.register);
    registerSentryIpcHandler(ipcMain, channels.register, (event, input: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame)
        throw new Error("HTML previews require the main application frame.");
      return this.register(event.sender.id, input);
    });
    ipcMain.removeHandler(channels.unregister);
    registerSentryIpcHandler(ipcMain, channels.unregister, (event, input: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame) return false;
      return this.unregister(event.sender.id, input);
    });
  }

  private assertCapacity(ownerId: number): void {
    if (!this.owners.has(ownerId)) throw new Error("HTML preview owner is no longer available.");
    const owned = [...this.registrations.values()].filter(
      (value) => value.ownerId === ownerId,
    ).length;
    if (owned >= MAX_PREVIEWS_PER_OWNER || this.registrations.size >= MAX_PREVIEWS) {
      throw new Error("Too many HTML previews are open. Close a preview and retry.");
    }
  }

  private release(id: string): void {
    const registration = this.registrations.get(id);
    if (!registration) return;
    this.registrations.delete(id);
    clearTimeout(registration.timer);
    registration.document.dispose();
    try {
      registration.session.webRequest.onBeforeRequest(null);
    } catch {
      /* Electron may be shutting down. */
    }
    try {
      registration.session.removeListener("will-download", registration.downloadHandler);
    } catch {
      /* Session already disposed. */
    }
    try {
      registration.session.setPermissionCheckHandler(null);
    } catch {
      /* Session already disposed. */
    }
    try {
      registration.session.setPermissionRequestHandler(null);
    } catch {
      /* Session already disposed. */
    }
    try {
      registration.session.protocol.unhandle(LOCAL_HTML_PREVIEW_SCHEME);
    } catch {
      /* Session already disposed. */
    }
    if (registration.guest && !registration.guest.isDestroyed()) {
      try {
        registration.guest.close({ waitForBeforeUnload: false });
      } catch {
        /* Guest already disposed. */
      }
    }
    void registration.session.clearStorageData().catch(() => undefined);
    void registration.session.closeAllConnections().catch(() => undefined);
  }
}
