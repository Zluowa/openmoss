// Integration test for the production /api/local-image Effect-based route.
// Boots the same `localImageEffectRouteLayer` that `makeEffectHttpRouteLayer` wires
// into `effectServer.ts` and exercises it through a real HTTP listener.
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ProviderInstanceId,
} from "@moss/contracts";
import { DateTime, Effect, Exit, Layer, Scope, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import {
  HTML_RENDER_FRAME_ACCESS_TTL_MS,
  signHtmlRenderFrameAccess,
} from "@moss/shared/htmlRenderFrameAccess";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultGroupsWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import {
  attachmentsEffectRouteLayer,
  localHtmlPreviewEffectRouteLayer,
  localImageEffectRouteLayer,
} from "./http";
import { createLocalPreviewGrant } from "./localImageFiles";
import { resolveScratchWorkspacesRoot } from "./scratchWorkspaces.ts";
import type { CodexGeneratedImageHomeCandidate } from "./codexGeneratedImages.ts";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import type { ProviderAdapterError } from "./provider/Errors.ts";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry.ts";
import {
  ServerSettingsService,
  type ServerSettingsShape,
  toServerSettingsView,
} from "./serverSettings.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepoTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(process.cwd(), `.${prefix}`));
  tempDirs.push(dir);
  return dir;
}

function makeGeneratedImage(prefix: string): { readonly homePath: string; readonly path: string } {
  const homePath = makeRepoTempDir(prefix);
  const imagePath = path.join(homePath, "generated_images", "thread-live", "call-live.png");
  mkdirSync(path.dirname(imagePath), { recursive: true });
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { homePath, path: imagePath };
}

function makeServerConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = makeTempDir("moss-effect-route-");
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    groupsWorkspaceRoot: resolveDefaultGroupsWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

function makeFakeServerAuth(): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  const descriptor = {
    policy: "loopback-browser" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "moss_session",
  };
  const session = {
    sessionId: "session-id" as never,
    subject: "owner",
    method: "browser-session-cookie" as const,
    role: "owner" as const,
    expiresAt,
  };
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () => Effect.succeed({ authenticated: false, auth: descriptor }),
    exchangeBootstrapCredential: () =>
      Effect.succeed({
        response: {
          authenticated: true,
          role: "client" as const,
          sessionMethod: "browser-session-cookie" as const,
          expiresAt,
        },
        sessionToken: "session-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      Effect.succeed({
        authenticated: true,
        role: "client" as const,
        sessionMethod: "bearer-session-token" as const,
        expiresAt,
        sessionToken: "bearer-session-token",
      }),
    revokeOwnerDeviceAccess: () => Effect.succeed(0),
    issueAccountDeviceBearerSession: () => Effect.die("account sign-in is not used in this test"),
    revokeAccountDeviceSessions: () => Effect.succeed(0),
    issuePairingCredential: () =>
      Effect.succeed({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => Effect.succeed(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => Effect.succeed(true),
    revokeOtherClientSessions: () => Effect.succeed(1),
    logoutSession: () => Effect.succeed(true),
    authenticateHttpRequest: () => Effect.succeed({ ...session, credentialSource: "cookie" }),
    authenticateWebSocketUpgrade: () => Effect.succeed(session),
    issueWebSocketToken: () => Effect.succeed({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () => Effect.succeed("http://127.0.0.1:3773/pair#token=PAIRINGTOKEN"),
  } satisfies ServerAuthShape;
}

function makeRejectingServerAuth(): ServerAuthShape {
  return {
    ...makeFakeServerAuth(),
    authenticateHttpRequest: () =>
      Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
  };
}

function makeGeneratedImageHomeRegistry(
  sessions: readonly {
    readonly instanceId: ProviderInstanceId;
    readonly homePath: CodexGeneratedImageHomeCandidate;
  }[],
): {
  readonly service: typeof ProviderAdapterRegistry.Service;
  readonly enabledInstanceScopes: Array<ReadonlySet<ProviderInstanceId> | undefined>;
} {
  const enabledInstanceScopes: Array<ReadonlySet<ProviderInstanceId> | undefined> = [];
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: "codex",
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    listGeneratedImageHomePaths: (input) => {
      enabledInstanceScopes.push(input?.enabledProviderInstanceIds);
      return Effect.succeed(
        sessions
          .filter(
            ({ instanceId }) =>
              !input?.enabledProviderInstanceIds ||
              input.enabledProviderInstanceIds.has(instanceId),
          )
          .map(({ homePath }) => homePath),
      );
    },
    hasSession: () => Effect.succeed(false),
    readThread: () => Effect.die("unused"),
    rollbackThread: () => Effect.die("unused"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
  return {
    service: {
      getByProvider: () => Effect.succeed(adapter),
      listProviders: () => Effect.succeed(["codex"]),
    },
    enabledInstanceScopes,
  };
}

function makeServerSettings(getSettings: ServerSettingsShape["getSettings"]): ServerSettingsShape {
  return {
    start: Effect.void,
    ready: Effect.void,
    getSettings,
    getSettingsView: getSettings.pipe(Effect.map(toServerSettingsView)),
    getSnapshot: getSettings.pipe(
      Effect.map((settings) => ({ revision: 0, migrationVersion: 2, settings })),
    ),
    updateSettings: () => Effect.die("unused"),
    updateSettingsIfRevision: () => Effect.die("unused"),
    updateSettingsView: () => Effect.die("unused"),
    subscribeChanges: Effect.succeed(Stream.empty),
    streamChanges: Stream.empty,
    streamViews: Stream.empty,
    streamViewsWithSnapshot: Stream.empty,
  };
}

async function withEffectServer(
  config: ServerConfigShape,
  routeLayer:
    | typeof localImageEffectRouteLayer
    | typeof attachmentsEffectRouteLayer
    | typeof localHtmlPreviewEffectRouteLayer,
  run: (origin: string) => Promise<void>,
  options: {
    readonly providerRegistry?: typeof ProviderAdapterRegistry.Service;
    readonly serverSettings?: ServerSettingsShape;
    readonly serverAuth?: ServerAuthShape;
  } = {},
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const servicesLayer = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    Layer.succeed(ServerAuth, options.serverAuth ?? makeFakeServerAuth()),
    ...(options.providerRegistry
      ? [Layer.succeed(ProviderAdapterRegistry, options.providerRegistry)]
      : []),
    ...(options.serverSettings
      ? [Layer.succeed(ServerSettingsService, options.serverSettings)]
      : []),
    ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    NodeHttpServer.layerHttpServices,
  );
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(routeLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(Effect.provide(servicesLayer)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected effect server to expose an address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    await run(origin);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("localImageEffectRouteLayer", () => {
  it("serves an allowlisted workspace image and signals downloads via Content-Disposition", async () => {
    const workspace = makeTempDir("moss-effect-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "hero.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: imagePath, cwd: workspace });
      const previewResponse = await fetch(`${origin}/api/local-image?${params}`);
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("content-type")).toContain("image/png");
      expect(previewResponse.headers.get("content-disposition")).toBeNull();

      params.set("download", "1");
      const downloadResponse = await fetch(`${origin}/api/local-image?${params}`);
      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers.get("content-disposition")).toBe(
        'attachment; filename="hero.png"',
      );
    });
  });

  it("downloads files whose names are not plain ASCII through an RFC 5987 filename", async () => {
    const workspace = makeTempDir("moss-effect-image-unicode-name-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const config = makeServerConfig({ cwd: workspace });
    const files = [
      { fileName: "报告.pdf", bytes: Buffer.from("%PDF-1.4"), encoded: "%E6%8A%A5%E5%91%8A.pdf" },
      // macOS screenshots carry a narrow no-break space (U+202F) before AM/PM.
      {
        fileName: "Screenshot 2026-04-03 at 9.27.45\u202fPM.png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        encoded: "Screenshot%202026-04-03%20at%209.27.45%E2%80%AFPM.png",
      },
      // RFC 5987 does not allow ' ( ) * unencoded, and encodeURIComponent leaves them.
      {
        fileName: "l'été (1).png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        encoded: "l%27%C3%A9t%C3%A9%20%281%29.png",
      },
    ];
    for (const { fileName, bytes } of files) writeFileSync(path.join(workspace, fileName), bytes);

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      for (const { fileName, bytes, encoded } of files) {
        const params = new URLSearchParams({
          path: path.join(workspace, fileName),
          cwd: workspace,
          download: "1",
        });
        // A route that rejects the header never ends the response; bound the wait.
        const response = await fetch(`${origin}/api/local-image?${params}`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toBe(
          `attachment; filename*=UTF-8''${encoded}`,
        );
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      }
    });
  });

  it("serves an absolute local image outside the workspace for file-panel previews", async () => {
    const workspace = makeTempDir("moss-effect-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const externalRoot = makeTempDir("moss-effect-external-preview-");
    const imagePath = path.join(externalRoot, "downloads-file.pdf");
    writeFileSync(imagePath, Buffer.from("%PDF-1.7"));
    const config = makeServerConfig({ cwd: workspace });

    const grant = await createLocalPreviewGrant({ requestedPath: imagePath });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: imagePath, cwd: workspace, grant: grant.grant });
      const response = await fetch(`${origin}/api/local-image?${params}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");

      params.delete("grant");
      const ungrantedResponse = await fetch(`${origin}/api/local-image?${params}`);
      expect(ungrantedResponse.status).toBe(404);
    });
  });

  it("previews and downloads a simulator PNG outside the allowed roots only with its own grant", async () => {
    // Keep this outside os.tmpdir(): temporary images are already allowlisted.
    const externalRoot = mkdtempSync(path.join(process.cwd(), ".simulator-preview-"));
    tempDirs.push(externalRoot);
    const desktop = path.join(externalRoot, "Desktop");
    mkdirSync(desktop);
    const imagePath = path.join(desktop, "simulator-iPhone.png");
    const otherPath = path.join(desktop, "unrelated.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(imagePath, bytes);
    writeFileSync(otherPath, bytes);
    const config = makeServerConfig();

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: imagePath, cwd: config.cwd });
      expect((await fetch(`${origin}/api/local-image?${params}`)).status).toBe(404);
      params.set("download", "1");
      expect((await fetch(`${origin}/api/local-image?${params}`)).status).toBe(404);

      const grant = await createLocalPreviewGrant({ requestedPath: imagePath });
      params.set("grant", grant.grant);
      for (const download of [false, true]) {
        if (download) params.set("download", "1");
        else params.delete("download");
        const response = await fetch(`${origin}/api/local-image?${params}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("image/png");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
        if (download)
          expect(response.headers.get("content-disposition")).toContain("simulator-iPhone.png");
      }

      params.set("path", otherPath);
      expect((await fetch(`${origin}/api/local-image?${params}`)).status).toBe(404);
    });
  });

  it("serves an allowlisted workspace PDF and only allows the desktop app origin to read it", async () => {
    const workspace = makeTempDir("moss-effect-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "spec.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: pdfPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "moss://app" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // The in-app viewer fetches bytes cross-origin, but only trusted app
      // origins should get a CORS-readable response.
      expect(response.headers.get("access-control-allow-origin")).toBe("moss://app");
      expect(response.headers.get("vary")).toBe("Origin");
      // Streamed responses must still advertise their size so the browser's
      // PDF viewer can show load progress.
      expect(response.headers.get("content-length")).toBe("8");
      await expect(response.arrayBuffer()).resolves.toHaveProperty("byteLength", 8);
      // No Content-Disposition: the browser must render the PDF inline in the
      // preview iframe rather than trigger a download.
      expect(response.headers.get("content-disposition")).toBeNull();
    });
  });

  it("allows the configured Vite dev origin to read PDF bytes", async () => {
    const workspace = makeTempDir("moss-effect-pdf-dev-origin-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "spec.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const config = makeServerConfig({
      cwd: workspace,
      devUrl: new URL("http://localhost:5173/"),
    });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: pdfPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "http://localhost:5173" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });
  });

  it("does not expose local preview bytes to untrusted web origins through CORS", async () => {
    const workspace = makeTempDir("moss-effect-pdf-untrusted-origin-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "spec.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: pdfPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "https://example.test" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("vary")).toBe("Origin");
    });
  });

  it("marks the no-Origin (<img>) copy as origin-dependent so a cached copy never answers fetch()", async () => {
    const workspace = makeTempDir("moss-effect-image-vary-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "generated.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: imagePath, cwd: workspace });
      // What an <img> in the desktop renderer sends: no Origin header.
      const imageLoad = await fetch(`${origin}/api/local-image?${params}`);
      expect(imageLoad.status).toBe(200);
      expect(imageLoad.headers.get("cache-control")).toBe("private, max-age=60");
      expect(imageLoad.headers.get("access-control-allow-origin")).toBeNull();
      expect(imageLoad.headers.get("vary")).toBe("Origin");
      // What the app's fetch() of the same URL sends afterwards.
      const appRead = await fetch(`${origin}/api/local-image?${params}`, {
        headers: { Origin: "moss://app" },
      });
      expect(appRead.headers.get("access-control-allow-origin")).toBe("moss://app");
      expect(appRead.headers.get("vary")).toBe("Origin");
    });
  });

  it("exposes missing-file errors to desktop downloads without allowing untrusted origins", async () => {
    const workspace = makeTempDir("moss-effect-missing-image-");
    const config = makeServerConfig({ cwd: workspace });
    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: "missing.png", cwd: workspace, download: "1" });
      for (const requestOrigin of ["moss://app", "https://example.test"]) {
        const response = await fetch(`${origin}/api/local-image?${params}`, {
          headers: { Origin: requestOrigin },
        });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not Found");
        expect(response.headers.get("access-control-allow-origin")).toBe(
          requestOrigin === "moss://app" ? requestOrigin : null,
        );
      }
    });
  });

  it("returns 404 when the requested path has an unsupported extension", async () => {
    const workspace = makeTempDir("moss-effect-image-bad-ext-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const docPath = path.join(workspace, "notes.txt");
    writeFileSync(docPath, "hello");
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: docPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`);
      expect(response.status).toBe(404);
    });
  });

  it("serves generated images from live Codex session homes after settings drift", async () => {
    const workspace = makeTempDir("moss-effect-image-live-session-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const image = makeGeneratedImage("moss-live-codex-home-");
    const config = makeServerConfig({ cwd: workspace });
    const liveHomes = makeGeneratedImageHomeRegistry([
      { instanceId: "codex" as ProviderInstanceId, homePath: image.homePath },
    ]);

    await withEffectServer(
      config,
      localImageEffectRouteLayer,
      async (origin) => {
        const params = new URLSearchParams({ path: image.path, cwd: workspace });
        const response = await fetch(`${origin}/api/local-image?${params}`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("image/png");
      },
      {
        providerRegistry: liveHomes.service,
      },
    );
    expect(liveHomes.enabledInstanceScopes).toEqual([undefined]);
  });

  it("serves live Codex session images when settings cannot be read", async () => {
    const workspace = makeTempDir("moss-effect-image-settings-failure-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const image = makeGeneratedImage("moss-live-codex-settings-failure-home-");
    const config = makeServerConfig({ cwd: workspace });
    const liveHomes = makeGeneratedImageHomeRegistry([
      { instanceId: "codex_work" as ProviderInstanceId, homePath: image.homePath },
    ]);

    await withEffectServer(
      config,
      localImageEffectRouteLayer,
      async (origin) => {
        const params = new URLSearchParams({ path: image.path, cwd: workspace });
        const response = await fetch(`${origin}/api/local-image?${params}`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("image/png");
      },
      {
        providerRegistry: liveHomes.service,
        serverSettings: makeServerSettings(
          Effect.fail(
            new ServerSettingsError({
              settingsPath: "<unavailable>",
              detail: "settings unavailable",
            }),
          ),
        ),
      },
    );
    expect(liveHomes.enabledInstanceScopes).toEqual([undefined]);
  });

  it("filters live Codex session images to instances enabled by readable settings", async () => {
    const workspace = makeTempDir("moss-effect-image-settings-scope-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const disabledImage = makeGeneratedImage("moss-live-codex-disabled-home-");
    const config = makeServerConfig({ cwd: workspace });
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        codex_work: { driver: "codex", enabled: true },
        codex_disabled: { driver: "codex", enabled: false },
      },
    };
    const liveHomes = makeGeneratedImageHomeRegistry([
      {
        instanceId: "codex_disabled" as ProviderInstanceId,
        homePath: disabledImage.homePath,
      },
    ]);

    await withEffectServer(
      config,
      localImageEffectRouteLayer,
      async (origin) => {
        const disabledParams = new URLSearchParams({
          path: disabledImage.path,
          cwd: workspace,
        });
        const disabledResponse = await fetch(`${origin}/api/local-image?${disabledParams}`);
        expect(disabledResponse.status).toBe(404);
      },
      {
        providerRegistry: liveHomes.service,
        serverSettings: makeServerSettings(Effect.succeed(settings)),
      },
    );
    const [scope] = liveHomes.enabledInstanceScopes;
    if (!scope) {
      throw new Error("Expected readable settings to provide an explicit instance scope");
    }
    expect([...scope]).toEqual(["codex", "codex_work"]);
  });

  it("returns 404 for missing files", async () => {
    const workspace = makeTempDir("moss-effect-image-missing-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const ghostPath = path.join(workspace, "does-not-exist.png");
    const config = makeServerConfig({ cwd: workspace });

    await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
      const params = new URLSearchParams({ path: ghostPath, cwd: workspace });
      const response = await fetch(`${origin}/api/local-image?${params}`);
      expect(response.status).toBe(404);
    });
  });
});

describe("attachmentsEffectRouteLayer", () => {
  it("serves persisted image attachments by id without the file response helper", async () => {
    const config = makeServerConfig({ authToken: "desktop-secret" });
    mkdirSync(config.attachmentsDir, { recursive: true });
    writeFileSync(
      path.join(config.attachmentsDir, "thread-1-6ec544e7-9130-4a8b-993d-9635297d04d3.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    await withEffectServer(config, attachmentsEffectRouteLayer, async (origin) => {
      const response = await fetch(
        `${origin}/attachments/thread-1-6ec544e7-9130-4a8b-993d-9635297d04d3?token=desktop-secret`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/png");
      expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(response.headers.get("pragma")).toBeNull();
      await expect(response.arrayBuffer()).resolves.toHaveProperty("byteLength", 4);
    });
  });

  describe("HTML attachments", () => {
    const page = "thread-1-6ec544e7-9130-4a8b-993d-9635297d04d3.html";
    const writePage = (config: ServerConfigShape) => {
      mkdirSync(config.attachmentsDir, { recursive: true });
      writeFileSync(path.join(config.attachmentsDir, page), "<p>Chart</p>");
    };
    const frameQuery = async (relativePath: string, token = "desktop-secret") => {
      const expiresAtMs = Date.now() + HTML_RENDER_FRAME_ACCESS_TTL_MS;
      const signature = await signHtmlRenderFrameAccess({ token, relativePath, expiresAtMs });
      return `expires=${expiresAtMs}&signature=${signature}`;
    };

    it("serves a page to its frame signature with T3's sandbox policy", async () => {
      const config = makeServerConfig({ authToken: "desktop-secret", host: "127.0.0.1" });
      writePage(config);

      await withEffectServer(
        config,
        attachmentsEffectRouteLayer,
        async (origin) => {
          const response = await fetch(`${origin}/attachments/${page}?${await frameQuery(page)}`);

          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
          const policy = response.headers.get("content-security-policy") ?? "";
          expect(policy).toBe("sandbox allow-scripts allow-forms allow-popups");
          expect(policy).not.toContain("allow-same-origin");
          expect(policy).not.toContain("default-src");
          expect(response.headers.get("referrer-policy")).toBeNull();
          expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
          await expect(response.text()).resolves.toBe("<p>Chart</p>");
        },
        { serverAuth: makeRejectingServerAuth() },
      );
    });

    it("never accepts the startup token, which the page could read from its URL", async () => {
      const config = makeServerConfig({ authToken: "desktop-secret", host: "127.0.0.1" });
      writePage(config);

      await withEffectServer(config, attachmentsEffectRouteLayer, async (origin) => {
        const response = await fetch(`${origin}/attachments/${page}?token=desktop-secret`);
        expect(response.status).toBe(403);
      });
    });

    it("rejects a signature for another page or another token", async () => {
      const config = makeServerConfig({ authToken: "desktop-secret", host: "127.0.0.1" });
      writePage(config);

      await withEffectServer(
        config,
        attachmentsEffectRouteLayer,
        async (origin) => {
          for (const query of [
            await frameQuery("thread-1-other.html"),
            await frameQuery(page, "other-secret"),
          ]) {
            const response = await fetch(`${origin}/attachments/${page}?${query}`);
            expect(response.status).toBe(403);
          }
        },
        { serverAuth: makeRejectingServerAuth() },
      );
    });

    it("accepts a page-scoped signature on a public server", async () => {
      const config = makeServerConfig({
        authToken: "desktop-secret",
        host: "0.0.0.0",
        publicUrl: new URL("https://moss.example.test"),
      });
      writePage(config);

      await withEffectServer(
        config,
        attachmentsEffectRouteLayer,
        async (origin) => {
          const response = await fetch(`${origin}/attachments/${page}?${await frameQuery(page)}`);
          expect(response.status).toBe(200);
        },
        { serverAuth: makeRejectingServerAuth() },
      );
    });

    it("needs a session when a request carries no frame signature", async () => {
      const config = makeServerConfig({ authToken: "desktop-secret", host: "127.0.0.1" });
      writePage(config);

      await withEffectServer(
        config,
        attachmentsEffectRouteLayer,
        async (origin) => {
          const response = await fetch(`${origin}/attachments/${page}`);
          expect(response.status).toBe(401);
        },
        { serverAuth: makeRejectingServerAuth() },
      );
      await withEffectServer(config, attachmentsEffectRouteLayer, async (origin) => {
        const response = await fetch(`${origin}/attachments/${page}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toMatch(/^sandbox /u);
      });
    });
  });

  describe("byte-range and HEAD streaming across preview routes", () => {
    it("supports HEAD, 206 Range, and 416 responses on /api/local-image for video files", async () => {
      const workspaceDir = makeTempDir("moss-range-video-");
      const videoPath = path.join(workspaceDir, "clip.mp4");
      const bytes = Buffer.from("0123456789abcdef");
      writeFileSync(videoPath, bytes);
      const config = makeServerConfig({ cwd: workspaceDir });

      await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
        const url = `${origin}/api/local-image?path=${encodeURIComponent(videoPath)}&cwd=${encodeURIComponent(workspaceDir)}`;
        const headResponse = await fetch(url, { method: "HEAD" });
        expect(headResponse.status).toBe(200);
        expect(headResponse.headers.get("accept-ranges")).toBe("bytes");
        expect(headResponse.headers.get("content-length")).toBe(String(bytes.byteLength));
        expect(headResponse.headers.get("content-type")).toBe("video/mp4");
        await expect(headResponse.text()).resolves.toBe("");

        const partialResponse = await fetch(url, {
          headers: { Range: "bytes=2-5" },
        });
        expect(partialResponse.status).toBe(206);
        expect(partialResponse.headers.get("accept-ranges")).toBe("bytes");
        expect(partialResponse.headers.get("content-range")).toBe(`bytes 2-5/${bytes.byteLength}`);
        expect(partialResponse.headers.get("content-length")).toBe("4");
        await expect(partialResponse.text()).resolves.toBe("2345");

        const invalidResponse = await fetch(url, {
          headers: { Range: "bytes=999-1000" },
        });
        expect(invalidResponse.status).toBe(416);
        expect(invalidResponse.headers.get("content-range")).toBe(`bytes */${bytes.byteLength}`);
      });
    });

    it("supports HEAD and Range requests on /attachments/* and /api/local-html/*", async () => {
      const workspaceDir = makeTempDir("moss-range-html-");
      const htmlPath = path.join(workspaceDir, "index.html");
      const htmlBody = "<html><body>hello range world</body></html>";
      writeFileSync(htmlPath, htmlBody);
      const config = makeServerConfig({ cwd: workspaceDir });

      mkdirSync(config.attachmentsDir, { recursive: true });
      const attachmentName = "thread-range-sample.txt";
      const attachmentBody = "attachment-payload-0123456789";
      writeFileSync(path.join(config.attachmentsDir, attachmentName), attachmentBody);

      await withEffectServer(config, attachmentsEffectRouteLayer, async (origin) => {
        const headResponse = await fetch(`${origin}/attachments/${attachmentName}`, {
          method: "HEAD",
        });
        expect(headResponse.status).toBe(200);
        expect(headResponse.headers.get("accept-ranges")).toBe("bytes");
        expect(headResponse.headers.get("content-length")).toBe(String(attachmentBody.length));
        await expect(headResponse.text()).resolves.toBe("");

        const rangeResponse = await fetch(`${origin}/attachments/${attachmentName}`, {
          headers: { Range: "bytes=11-17" },
        });
        expect(rangeResponse.status).toBe(206);
        expect(rangeResponse.headers.get("content-range")).toBe(
          `bytes 11-17/${attachmentBody.length}`,
        );
        await expect(rangeResponse.text()).resolves.toBe("payload");
      });

      const grant = await createLocalPreviewGrant({ requestedPath: htmlPath });
      await withEffectServer(config, localHtmlPreviewEffectRouteLayer, async (origin) => {
        const url = `${origin}/api/local-html/${encodeURIComponent(grant.grant)}/index.html`;
        const headResponse = await fetch(url, { method: "HEAD" });
        expect(headResponse.status).toBe(200);
        expect(headResponse.headers.get("accept-ranges")).toBe("bytes");
        expect(headResponse.headers.get("content-length")).toBe(String(htmlBody.length));
        await expect(headResponse.text()).resolves.toBe("");

        const rangeResponse = await fetch(url, {
          headers: { Range: "bytes=-7" },
        });
        expect(rangeResponse.status).toBe(206);
        expect(rangeResponse.headers.get("content-range")).toBe(
          `bytes ${htmlBody.length - 7}-${htmlBody.length - 1}/${htmlBody.length}`,
        );
        await expect(rangeResponse.text()).resolves.toBe("</html>");
      });
    });
  });

  describe("download=1 extension policy and threadId scratch resolution", () => {
    it("allows arbitrary workspace extensions when download=1 is set and maps .ts to text/plain", async () => {
      const workspaceDir = makeTempDir("moss-download-ext-");
      const ps1Path = path.join(workspaceDir, "deploy.ps1");
      const tsPath = path.join(workspaceDir, "script.ts");
      writeFileSync(ps1Path, "Write-Output 'ok'\n");
      writeFileSync(tsPath, "export const answer = 42;\n");
      const config = makeServerConfig({ cwd: workspaceDir });

      await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
        const blocked = await fetch(
          `${origin}/api/local-image?path=${encodeURIComponent(ps1Path)}&cwd=${encodeURIComponent(workspaceDir)}`,
        );
        expect(blocked.status).toBe(404);

        const ps1Download = await fetch(
          `${origin}/api/local-image?path=${encodeURIComponent(ps1Path)}&cwd=${encodeURIComponent(workspaceDir)}&download=1`,
        );
        expect(ps1Download.status).toBe(200);
        expect(ps1Download.headers.get("content-disposition")).toContain("attachment");
        await expect(ps1Download.text()).resolves.toBe("Write-Output 'ok'\n");

        const tsDownload = await fetch(
          `${origin}/api/local-image?path=${encodeURIComponent(tsPath)}&cwd=${encodeURIComponent(workspaceDir)}&download=1`,
        );
        expect(tsDownload.status).toBe(200);
        expect(tsDownload.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        await expect(tsDownload.text()).resolves.toBe("export const answer = 42;\n");
      });
    });

    it("resolves relative files inside threadId scratch workspace when cwd is omitted and rejects traversal", async () => {
      const scratchRoot = resolveScratchWorkspacesRoot();
      const safeThreadId = `route-scratch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const threadDir = path.join(scratchRoot, safeThreadId);
      tempDirs.push(threadDir);
      mkdirSync(threadDir, { recursive: true });
      writeFileSync(path.join(threadDir, "notes.ps1"), "# scratch script");

      const workspaceDir = makeTempDir("moss-outside-thread-");
      const outsidePath = path.join(workspaceDir, "secret.ps1");
      writeFileSync(outsidePath, "secret");
      const config = makeServerConfig({ cwd: workspaceDir });

      await withEffectServer(config, localImageEffectRouteLayer, async (origin) => {
        const okResponse = await fetch(
          `${origin}/api/local-image?path=notes.ps1&threadId=${encodeURIComponent(safeThreadId)}&download=1`,
        );
        expect(okResponse.status).toBe(200);
        await expect(okResponse.text()).resolves.toBe("# scratch script");

        const traversalResponse = await fetch(
          `${origin}/api/local-image?path=notes.ps1&threadId=${encodeURIComponent("../escape")}&download=1`,
        );
        expect(traversalResponse.status).toBe(404);

        const outsideRelativeTraversal = await fetch(
          `${origin}/api/local-image?path=${encodeURIComponent(`../${path.basename(outsidePath)}`)}&threadId=${encodeURIComponent(safeThreadId)}&download=1`,
        );
        expect(outsideRelativeTraversal.status).toBe(404);
      });
    });

    it("supports previewGrant for arbitrary download extensions while never relaxing Codex/temp extensions", async () => {
      const outsideDir = makeTempDir("moss-grant-ext-");
      const grantedPs1 = path.join(outsideDir, "tool.ps1");
      writeFileSync(grantedPs1, "Get-Date");
      const grant = await createLocalPreviewGrant({ requestedPath: grantedPs1 });

      const codexHome = makeTempDir("moss-codex-no-relax-");
      const codexPng = path.join(codexHome, "generated_images", "thread-1", "ok.png");
      const codexScript = path.join(codexHome, "generated_images", "thread-1", "evil.ps1");
      mkdirSync(path.dirname(codexScript), { recursive: true });
      writeFileSync(codexPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(codexScript, "Write-Host 'nope'");

      const liveHomes = makeGeneratedImageHomeRegistry([
        { instanceId: "codex" as ProviderInstanceId, homePath: codexHome },
      ]);
      const workspaceDir = makeTempDir("moss-ws-unused-");
      const config = makeServerConfig({ cwd: workspaceDir });

      await withEffectServer(
        config,
        localImageEffectRouteLayer,
        async (origin) => {
          const grantedResponse = await fetch(
            `${origin}/api/local-image?path=${encodeURIComponent(grantedPs1)}&grant=${encodeURIComponent(grant.grant)}&download=1`,
          );
          expect(grantedResponse.status).toBe(200);
          await expect(grantedResponse.text()).resolves.toBe("Get-Date");

          const codexImageAllowed = await fetch(
            `${origin}/api/local-image?path=${encodeURIComponent(codexPng)}&cwd=${encodeURIComponent(workspaceDir)}`,
          );
          expect(codexImageAllowed.status).toBe(200);

          const codexBlocked = await fetch(
            `${origin}/api/local-image?path=${encodeURIComponent(codexScript)}&cwd=${encodeURIComponent(workspaceDir)}&download=1`,
          );
          expect(codexBlocked.status).toBe(404);
        },
        { providerRegistry: liveHomes.service },
      );
    });
  });
});
