// Remote pages receive only a credential-free transport URL through the narrow
// preload. Authentication is scoped to this window's private network session.
import { BrowserWindow, shell } from "electron";
import { randomUUID } from "node:crypto";
import { remoteComputerOrigin } from "./remoteComputers";
import { sshWorkspaceHeaders } from "./sshWorkspacePolicy";

export interface RemoteComputerWorkspaceInput {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly onClosed: (reason?: "workspace-load") => void;
  readonly kind: "ssh" | "paired";
}
export interface RemoteComputerWorkspaceOptions {
  readonly preloadPath: string;
  /** Asks the person before a remote page opens a link in their own browser. */
  readonly confirmExternalLink: (input: {
    readonly window: BrowserWindow;
    readonly name: string;
    readonly url: string;
  }) => Promise<boolean>;
  readonly icon?: string;
  readonly workspaceUrls: Map<number, string>;
  /** Lets the page name the other computer correctly (SSH device or paired computer). */
  readonly workspaceKinds?: Map<number, "ssh" | "paired">;
}
export interface RemoteComputerWorkspace {
  readonly close: () => void;
  readonly ready: Promise<void>;
}

/** Remote pages run code from another computer. The only permission they keep is the
 * sanitized clipboard write behind copy buttons, from their own top-level origin. Camera,
 * microphone, clipboard reads, location, notifications and devices stay local-only. */
export function remoteWorkspacePermissionAllowed(
  origin: string,
  permission: string,
  details: { readonly isMainFrame?: boolean; readonly requestingUrl?: string },
  requestingOrigin?: string,
): boolean {
  if (permission !== "clipboard-sanitized-write" || details.isMainFrame === false) return false;
  try {
    return [requestingOrigin, details.requestingUrl].every(
      (value) => !value || new URL(value).origin === origin,
    );
  } catch {
    return false;
  }
}

export function openRemoteComputerWorkspace(
  input: RemoteComputerWorkspaceInput,
  options: RemoteComputerWorkspaceOptions,
): RemoteComputerWorkspace {
  if (input.signal?.aborted) throw new Error("cancelled");
  const origin = remoteComputerOrigin(input.origin);
  const wsOrigin = origin.replace(/^http/u, "ws");
  const workspaceUrl = `${wsOrigin}/`;
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    title: `Moss — ${input.name}`,
    show: false,
    autoHideMenuBar: true,
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `moss-${input.kind}-${input.id}-${randomUUID()}`,
    },
  });
  const contentsId = window.webContents.id;
  const workspaceSession = window.webContents.session;
  let closing = false;
  let closed = false;
  let settled = false;
  let closeReason: "workspace-load" | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectReady(error);
    else resolveReady();
  };
  const close = () => {
    closing = true;
    if (!window.isDestroyed()) window.destroy();
  };
  const cancel = () => {
    closeReason = undefined;
    settle(new Error("cancelled"));
    close();
  };
  const failLoad = () => {
    // A load rejection caused by an earlier close/cancel is not a new failure.
    if (closing || input.signal?.aborted) return;
    closeReason = "workspace-load";
    settle(new Error("connection-failed"));
    close();
  };

  options.workspaceUrls.set(contentsId, workspaceUrl);
  options.workspaceKinds?.set(contentsId, input.kind);
  // A private partition has no handler of its own, and Electron grants every request
  // without one. Install the deny-by-default policy before any remote document loads.
  workspaceSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      contents?.id === contentsId && remoteWorkspacePermissionAllowed(origin, permission, details),
    ),
  );
  workspaceSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    Boolean(
      contents?.id === contentsId &&
      remoteWorkspacePermissionAllowed(origin, permission, details, requestingOrigin),
    ),
  );
  workspaceSession.setDevicePermissionHandler(() => false);
  workspaceSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`, `${wsOrigin}/*`] },
    (details, callback) =>
      callback({
        requestHeaders: sshWorkspaceHeaders(
          origin,
          input.token,
          details.url,
          details.requestHeaders,
        ),
      }),
  );
  window.once("ready-to-show", () => {
    if (!closing && !input.signal?.aborted && !window.isDestroyed()) window.show();
  });
  window.once("closed", () => {
    if (closed) return;
    closed = true;
    closing = true;
    input.signal?.removeEventListener("abort", cancel);
    options.workspaceUrls.delete(contentsId);
    options.workspaceKinds?.delete(contentsId);
    workspaceSession.webRequest.onBeforeSendHeaders(null);
    void workspaceSession.clearStorageData().catch(() => undefined);
    settle(new Error(input.signal?.aborted ? "cancelled" : "connection-failed"));
    if (closeReason) input.onClosed(closeReason);
    else input.onClosed();
  });
  input.signal?.addEventListener("abort", cancel, { once: true });
  // A remote page cannot open the local browser on its own: every link waits for
  // the person's answer, and a page cannot queue a second prompt behind the first.
  let linkPromptOpen = false;
  window.webContents.setWindowOpenHandler(({ url }) => {
    let external: string | null = null;
    try {
      const parsed = new URL(url);
      if (["https:", "http:"].includes(parsed.protocol)) external = parsed.toString();
    } catch {
      /* Invalid external link. */
    }
    if (external && !linkPromptOpen && !closing && !window.isDestroyed()) {
      linkPromptOpen = true;
      void options
        .confirmExternalLink({ window, name: input.name, url: external })
        .then((open) => {
          if (open && !closing && !window.isDestroyed()) return shell.openExternal(external);
        })
        .catch(() => undefined)
        .finally(() => {
          linkPromptOpen = false;
        });
    }
    return { action: "deny" };
  });
  const keepSameOrigin = (event: { preventDefault: () => void }, url: string) => {
    try {
      if (new URL(url).origin !== origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", keepSameOrigin);
  // loadURL does not emit will-navigate; a server redirect must obey the same boundary.
  window.webContents.on("will-redirect", keepSameOrigin);

  if (input.signal?.aborted) {
    cancel();
  } else {
    const target =
      input.kind === "paired" ? `${origin}/#/settings?section=computer&connectionTab=this` : origin;
    timeout = setTimeout(failLoad, 20_000);
    try {
      void window.loadURL(target).then(() => settle(), failLoad);
    } catch {
      failLoad();
    }
  }
  return { close, ready };
}
