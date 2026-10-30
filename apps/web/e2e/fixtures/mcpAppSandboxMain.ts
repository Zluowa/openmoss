import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  protocol,
  session,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import {
  MCP_APP_SANDBOX_PENDING_TTL_MS,
  MCP_APP_SANDBOX_SCHEME,
  type McpAppSandboxDescriptor,
  type McpAppSandboxRegisterInput,
} from "@synara/contracts";
import { MCP_APP_RESOURCE_READ_ROUTE_PATH } from "@synara/shared/mcpAppResource";

import { McpAppSandboxRuntime } from "../../../desktop/src/mcpAppSandbox/runtime";
import { DESKTOP_IPC_CHANNELS } from "../../../desktop/src/ipcChannels";

const mossHome = process.env.MOSS_HOME;
const trustedPreloadPath = process.env.MOSS_E2E_MCP_APP_TRUSTED_PRELOAD;
const guestPreloadPath = process.env.MOSS_E2E_MCP_APP_GUEST_PRELOAD;
const rendererBundlePath = process.env.MOSS_E2E_MCP_APP_RENDERER;
const guestBundlePath = process.env.MOSS_E2E_MCP_APP_GUEST;
const rendererCssPath = process.env.MOSS_E2E_MCP_APP_CSS;

if (
  !mossHome ||
  !trustedPreloadPath ||
  !guestPreloadPath ||
  !rendererBundlePath ||
  !guestBundlePath
) {
  throw new Error("The MCP App sandbox fixture requires its isolated build outputs.");
}

app.setPath("userData", join(mossHome, "electron-userdata"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: MCP_APP_SANDBOX_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      allowServiceWorkers: false,
    },
  },
]);

const rendererBundle = readFileSync(rendererBundlePath, "utf8").replaceAll(
  "</script",
  "<\\/script",
);
const rendererCss =
  rendererCssPath && existsSync(rendererCssPath) ? readFileSync(rendererCssPath, "utf8") : "";
const guestBundle = readFileSync(guestBundlePath, "utf8").replaceAll("</script", "<\\/script");
const guestHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moss MCP App fixture</title></head>
<body style="margin:0;overflow:hidden;background:#fff;color:#202020">
<script>${guestBundle}</script>
</body>
</html>`;

const diagnostics = {
  configuredGuestPreloadPath: basename(guestPreloadPath),
  configuredAnnotationPreloadPath: process.env.MOSS_E2E_BROWSER_ANNOTATION_PRELOAD
    ? basename(process.env.MOSS_E2E_BROWSER_ANNOTATION_PRELOAD)
    : "missing",
  rendererCssInjected: rendererCss.length > 0,
  willAttach: 0,
  didAttach: 0,
  guestMessage: 0,
  trustedMessage: 0,
  didAttachUrls: [] as string[],
  didAttachSessionMatches: [] as boolean[],
  didAttachSessionInfo: [] as Array<{
    guest: string;
    expected: string;
    guestUA: string;
    expectedUA: string;
  }>,
  willAttachPartitions: [] as string[],
  willAttachPreferences: [] as Array<{ preload: string; sandbox: boolean; partition: string }>,
  runtimeGuestPreloadPaths: [] as string[],
  preloadErrors: [] as string[],
  guestLifecycle: [] as string[],
  guestConsoleErrors: [] as string[],
  guestConsoleWarnings: [] as string[],
  guestConsoleSecurityDenials: [] as string[],
  guestSecurityDenials: [] as string[],
};
const runtime = new McpAppSandboxRuntime({
  onSecurityDenied: (event) => {
    diagnostics.guestSecurityDenials.push(`${event.kind}:${event.url ?? ""}`);
  },
});
const runtimeWithInternals = runtime as unknown as {
  activeGuests: Map<
    string,
    {
      readonly guest: WebContents;
      readonly registration: { readonly descriptor: McpAppSandboxDescriptor };
    }
  >;
  pendingAttach: Map<string, unknown>;
  registeredPartitions: Map<string, unknown>;
  partitionPolicies: Map<string, unknown>;
  register: (ownerId: number, input: unknown) => McpAppSandboxDescriptor | null;
  handleGuestPortMessage: (event: IpcMainEvent, payload: unknown) => void;
};
const originalRegister = runtime.register.bind(runtime);
let registerCount = 0;
let failNextRegistration = false;
let lastDescriptor: McpAppSandboxDescriptor | null = null;
runtimeWithInternals.register = (ownerId, input) => {
  registerCount += 1;
  if (failNextRegistration) {
    failNextRegistration = false;
    return null;
  }
  const descriptor = originalRegister(ownerId, input);
  if (descriptor) lastDescriptor = descriptor;
  return descriptor;
};
const originalGuestMessage = runtimeWithInternals.handleGuestPortMessage.bind(runtime);
runtimeWithInternals.handleGuestPortMessage = (event, payload) => {
  diagnostics.guestMessage += 1;
  originalGuestMessage(event, payload);
};
runtime.registerIpcHandlers();

let mainWindow: BrowserWindow | null = null;
let server: ReturnType<typeof createServer> | null = null;
let serverUrl = "";
let ownerId = 0;
const seenGuests = new Map<number, WebContents>();
const processErrors: string[] = [];
process.on("unhandledRejection", () => {
  processErrors.push("unhandled-rejection");
});
process.on("uncaughtException", () => {
  processErrors.push("uncaught-exception");
});

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function fixtureCsp() {
  return {
    baseUriDomains: [],
    connectDomains: [],
    frameDomains: [],
    includeDefaultDomains: false,
    isTrusted: true,
    resourceDomains: [],
  };
}

function fixtureInput(
  overrides: Partial<McpAppSandboxRegisterInput> = {},
): McpAppSandboxRegisterInput {
  return {
    callId: "fixture-call",
    containerDimensions: { height: 240, width: 640 },
    csp: fixtureCsp(),
    generation: 0,
    isCollapsible: true,
    prefersBorder: true,
    resourceUri: "ui://fixture/mcp-app",
    server: "fixture-server",
    theme: "light",
    threadId: "thread-mcp-app-e2e",
    ...overrides,
  };
}

function readRequest(request: import("node:http").IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 100_000) request.destroy(new Error("request too large"));
    });
    request.on("end", resolve);
    request.on("error", reject);
  });
}

function makeHostHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moss MCP App host</title><link rel="stylesheet" href="/mcpAppSandbox.css"></head>
<body><script>${rendererBundle}</script></body></html>`;
}

async function startServer(): Promise<string> {
  server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(makeHostHtml());
        return;
      }
      if (request.method === "GET" && request.url === "/mcpAppSandboxRenderer.js") {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(rendererBundle);
        return;
      }
      if (request.method === "GET" && request.url === "/mcpAppSandbox.css") {
        response.writeHead(rendererCss.length > 0 ? 200 : 404, {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(rendererCss);
        return;
      }
      if (
        request.method === "POST" &&
        request.url?.split("?", 1)[0] === MCP_APP_RESOURCE_READ_ROUTE_PATH
      ) {
        await readRequest(request);
        sendJson(response, 200, {
          state: "ready",
          resourceUri: "ui://fixture/mcp-app",
          html: guestHtml,
          sizeBytes: new TextEncoder().encode(guestHtml).byteLength,
          mimeType: "text/html;profile=mcp-app",
          csp: fixtureCsp(),
          prefersBorder: true,
          isCollapsible: true,
          widgetDomain: null,
        });
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture failure" });
      else response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP server did not bind.");
  return `http://127.0.0.1:${address.port}`;
}

function activeGuest(): {
  readonly guest: WebContents;
  readonly descriptor: McpAppSandboxDescriptor;
} | null {
  const first = runtimeWithInternals.activeGuests.values().next().value;
  return first ?? null;
}

function stateSnapshot() {
  const active = activeGuest();
  return {
    activeGuests: runtimeWithInternals.activeGuests.size,
    pendingAttach: runtimeWithInternals.pendingAttach.size,
    registeredPartitions: runtimeWithInternals.registeredPartitions.size,
    partitionPolicies: runtimeWithInternals.partitionPolicies.size,
    registerCount,
    diagnostics: { ...diagnostics },
    processErrors: [...processErrors],
    lastDescriptor,
    activeGuestId: active?.guest.id ?? null,
    activeDescriptor: active?.descriptor ?? null,
  };
}

function tryAttach(
  candidateOwnerId: number,
  src: string,
  partition: string,
): { readonly claimed: boolean; readonly prevented: boolean } {
  let prevented = false;
  const claimed = runtime.handleWillAttachWebview(
    candidateOwnerId,
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    { nodeIntegration: true, preload: "/unexpected-preload.js" },
    { partition, src },
    guestPreloadPath!,
  );
  return { claimed, prevented };
}

function authorityChecks() {
  if (!ownerId) throw new Error("Fixture window owner is not ready.");
  const probe = runtime.register(
    ownerId,
    fixtureInput({
      callId: "fixture-authority-probe",
      resourceUri: "ui://fixture/authority-probe",
      threadId: "thread-authority-probe",
    }),
  );
  if (!probe) throw new Error("Fixture authority probe registration failed.");
  const wrongGeneration = new URL(probe.src);
  wrongGeneration.searchParams.set("generation", String(probe.generation + 1));
  const wrongInit = new URL(probe.src);
  wrongInit.hash = "#init=wrong-init";
  const wrongPath = new URL(probe.src);
  wrongPath.pathname = "/wrong";
  const results = {
    wrongOwner: tryAttach(ownerId + 1, probe.src, probe.partition),
    wrongPartition: tryAttach(ownerId, probe.src, `${probe.partition}-wrong`),
    wrongGeneration: tryAttach(ownerId, wrongGeneration.toString(), probe.partition),
    wrongInit: tryAttach(ownerId, wrongInit.toString(), probe.partition),
    wrongPath: tryAttach(ownerId, wrongPath.toString(), probe.partition),
  };
  const registryInternals = runtime.registry as unknown as {
    pending: Map<string, { expiresAt: number; descriptor: McpAppSandboxDescriptor }>;
  };
  const pendingProbe = [...registryInternals.pending.values()].find(
    (registration) => registration.descriptor.src === probe.src,
  );
  if (!pendingProbe) throw new Error("Fixture authority probe was not pending.");
  pendingProbe.expiresAt = Date.now() - MCP_APP_SANDBOX_PENDING_TTL_MS - 1;
  runtime.registry.expire();
  const releaseUnused = (runtime as unknown as { releaseUnusedPartitionProtocols?: () => void })
    .releaseUnusedPartitionProtocols;
  releaseUnused?.call(runtime);
  const expired = tryAttach(ownerId, probe.src, probe.partition);
  return { results, expired };
}

async function executeActiveGuest(script: string): Promise<unknown> {
  const active = activeGuest();
  if (!active) throw new Error("Expected an active MCP App guest.");
  return active.guest.executeJavaScript(script, true);
}

function sendStaleGuestInit(guestId: number, descriptor: McpAppSandboxDescriptor): unknown {
  const staleGuest = seenGuests.get(guestId);
  const handleGuestPortMessage = runtimeWithInternals.handleGuestPortMessage;
  if (staleGuest && handleGuestPortMessage) {
    const channel = new MessageChannelMain();
    handleGuestPortMessage.call(
      runtime,
      {
        sender: staleGuest,
        ports: [channel.port1, channel.port2],
      } as unknown as IpcMainEvent,
      {
        type: "init",
        origin: descriptor.origin,
        initId: descriptor.initId,
        portNames: ["mcp-app-host"],
      },
    );
    channel.port1.close();
    channel.port2.close();
  }
  return stateSnapshot();
}

ipcMain.on(DESKTOP_IPC_CHANNELS.wsUrl, (event: IpcMainEvent) => {
  event.returnValue = serverUrl.replace(/^http:/, "ws:") + "/ws";
});

// The dock's top-bar gutter hooks query the custom title bar state on mount;
// the fixture window has no title-bar machinery, so answer with the off state.
ipcMain.handle(DESKTOP_IPC_CHANNELS.customTitleBarGetState, () => ({
  supported: false,
  preference: false,
  active: false,
  restartRequired: false,
}));

Object.assign(globalThis, {
  __mossMcpAppE2E: {
    state: stateSnapshot,
    authorityChecks,
    executeActiveGuest,
    sendStaleGuestInit,
    setWindowSize(width: number, height: number) {
      mainWindow?.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    },
    setFailNextRegistration(value: boolean) {
      failNextRegistration = value;
    },
    getServerUrl: () => serverUrl,
  },
});

async function main(): Promise<void> {
  serverUrl = await startServer();
  await app.whenReady();
  mainWindow = new BrowserWindow({
    width: 1_000,
    height: 760,
    show: true,
    webPreferences: {
      preload: trustedPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 43 cannot execute a CommonJS webview preload when the
      // embedding BrowserWindow is itself sandboxed. The guest remains
      // sandboxed by the hardened will-attach preferences below; keeping the
      // fixture owner unsandboxed mirrors the existing desktop E2E harness.
      sandbox: false,
      webviewTag: true,
      webSecurity: true,
    },
  });
  ownerId = mainWindow.webContents.id;
  runtime.attachOwner(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    diagnostics.willAttach += 1;
    diagnostics.willAttachPartitions.push(String(params.partition ?? "missing"));
    runtime.handleWillAttachWebview(
      ownerId,
      event,
      webPreferences,
      { partition: params.partition, src: params.src },
      guestPreloadPath!,
    );
    diagnostics.runtimeGuestPreloadPaths.push(basename(guestPreloadPath!));
    diagnostics.willAttachPreferences.push({
      preload: basename(String(webPreferences.preload ?? "missing")),
      sandbox: Boolean(webPreferences.sandbox),
      partition: String(webPreferences.partition ?? "missing"),
    });
  });
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    diagnostics.didAttach += 1;
    diagnostics.didAttachUrls.push(guest.getURL());
    const expectedSession = lastDescriptor ? session.fromPartition(lastDescriptor.partition) : null;
    diagnostics.didAttachSessionMatches.push(
      Boolean(expectedSession && guest.session === expectedSession),
    );
    diagnostics.didAttachSessionInfo.push({
      guest: String(guest.session?.storagePath ?? "null"),
      expected: String(expectedSession?.storagePath ?? "null"),
      guestUA: guest.session?.getUserAgent() ?? "missing",
      expectedUA: expectedSession?.getUserAgent() ?? "missing",
    });
    seenGuests.set(guest.id, guest);
    guest.on("console-message", (_event, details: { level: number; message: string }) => {
      const { level, message } = details;
      const knownSandboxWarning =
        /^A sandboxed iframe with the 'allow-scripts' and 'allow-same-origin' attributes can remove its sandboxing\.?$/u.test(
          message,
        );
      if (knownSandboxWarning) {
        diagnostics.guestConsoleWarnings.push(message);
        return;
      }
      if (level === 1) {
        diagnostics.guestConsoleWarnings.push(message);
        return;
      }
      if (level >= 2) {
        if (
          /blocked\.invalid|content security policy|refused to connect|not allowed to navigate|download/iu.test(
            message,
          )
        ) {
          diagnostics.guestConsoleSecurityDenials.push(message);
        } else {
          diagnostics.guestConsoleErrors.push(message);
        }
      }
    });
    guest.on("preload-error", (_event, preloadPath, error) => {
      diagnostics.preloadErrors.push(`${String(preloadPath)}:${String(error)}`);
    });
    guest.on("did-navigate", (_event, url) => diagnostics.guestLifecycle.push(`navigate:${url}`));
    guest.on("did-finish-load", () => diagnostics.guestLifecycle.push("finish"));
    guest.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      diagnostics.guestLifecycle.push(`fail:${code}:${description}:${url}:${String(isMainFrame)}`);
      if (/blocked_by_csp|content security policy/iu.test(description)) {
        diagnostics.guestSecurityDenials.push(`network:${description}:${url}`);
      }
    });
    guest.on("render-process-gone", (_event, details) => {
      diagnostics.guestLifecycle.push(`gone:${details.reason}`);
    });
    runtime.handleDidAttachWebview(ownerId, guest);
  });
  await mainWindow.loadURL(`${serverUrl}/`);
}

app.on("before-quit", () => {
  if (ownerId) runtime.teardownOwner(ownerId);
  if (server) {
    server.close();
    server = null;
  }
});

void main().catch(() => {
  app.quit();
});
