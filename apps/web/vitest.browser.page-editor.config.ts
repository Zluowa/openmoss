import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Option, Schema } from "effect";
import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

import stableConfig, { PAGE_EDITOR_BROWSER_SPECS } from "./vitest.browser.stable.config";

// Page specs drive the real Canvas Plate editor, which only exists once the pinned Canvas
// bundle is built (`scripts/prepare-moss-canvas-bundle.ts`, CI's Desktop Build job). Serve
// its /canvas/ route from Vite's dev server so the iframe shares Vitest's origin and
// `expect.element(frameLocator)` can inspect `iframe.contentDocument`.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const canvasStaticRoot = resolve(
  process.env.MOSS_CANVAS_STATIC_DIR?.trim() ||
    resolve(repoRoot, "apps/desktop/canvas-bundle/apps/codex-canvas/dist"),
);
if (!existsSync(resolve(canvasStaticRoot, "page-editor.html"))) {
  throw new Error(
    `The Page editor browser specs need the built Canvas bundle; ${canvasStaticRoot} has no page-editor.html. Run scripts/prepare-moss-canvas-bundle.ts or set MOSS_CANVAS_STATIC_DIR.`,
  );
}

const CANVAS_ROUTE_PREFIX = "/canvas/";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type CanvasServerPlugin = NonNullable<ViteUserConfig["plugins"]>[number];

const canvasStaticPlugin: CanvasServerPlugin = {
  name: "moss-page-editor-canvas-static",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url ?? "/", "http://canvas.invalid").pathname;
      if (!pathname.startsWith(CANVAS_ROUTE_PREFIX)) {
        next();
        return;
      }
      const relativePath = normalize(
        decodeURIComponent(pathname.slice(CANVAS_ROUTE_PREFIX.length)) || "index.html",
      );
      const filePath =
        relativePath.startsWith("..") || relativePath.includes("\0") || isAbsolute(relativePath)
          ? null
          : resolve(canvasStaticRoot, relativePath);
      if (
        request.method !== "GET" ||
        filePath === null ||
        !filePath.startsWith(`${canvasStaticRoot}${sep}`) ||
        !existsSync(filePath) ||
        !statSync(filePath).isFile()
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type":
          CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    });
  },
};

type OrchestrationThreadRecord = { readonly id: string; readonly canvasEditedAt?: string | null };
type OrchestrationReadModelRecord = {
  readonly snapshotSequence: number;
  readonly threads: ReadonlyArray<OrchestrationThreadRecord>;
};
type OrchestrationEventRecord = { readonly sequence: number; readonly type: string };
type ServerEffect<A> = Effect.Effect<A, unknown, never>;
type TestOrchestration = {
  readonly knows: (threadId: string) => boolean;
  readonly request: (method: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly recordCanvasWrite: (
    threadId: string,
    method: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
};

/**
 * The server's orchestration in memory, for tests that follow a chat into the lists (WALK-7
 * N7-1). A window's command is decoded with the server's client command schema, then decided and
 * projected by the server's own decider and projector (apps/server/src/orchestration), as its
 * engine does, without SQL. A Canvas storage write records the 画布's first content through the
 * server's own recordMossCanvasEdited (mossCanvasEdited.ts), as the real storage route does.
 */
async function createTestOrchestration(server: {
  readonly ssrLoadModule: (url: string) => Promise<Record<string, unknown>>;
}): Promise<TestOrchestration> {
  const load = (path: string) => server.ssrLoadModule(resolve(repoRoot, path));
  const [contracts, decider, projector, engineService, queryService, edited] = await Promise.all([
    load("packages/contracts/src/orchestration.ts"),
    load("apps/server/src/orchestration/decider.ts"),
    load("apps/server/src/orchestration/projector.ts"),
    load("apps/server/src/orchestration/Services/OrchestrationEngine.ts"),
    load("apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts"),
    load("apps/server/src/mossCanvasEdited.ts"),
  ]);
  const decodeClientCommand = Schema.decodeUnknownSync(
    contracts.ClientOrchestrationCommand as Schema.Codec<unknown, unknown, never, never>,
  );
  const decide = decider.decideOrchestrationCommand as (input: {
    command: unknown;
    readModel: OrchestrationReadModelRecord;
  }) => ServerEffect<unknown>;
  const projectEvent = projector.projectEvent as (
    model: OrchestrationReadModelRecord,
    event: OrchestrationEventRecord,
  ) => ServerEffect<OrchestrationReadModelRecord>;
  const createEmptyReadModel = projector.createEmptyReadModel as (
    now: string,
  ) => OrchestrationReadModelRecord;
  const isCanvasContentWrite = edited.isCanvasContentWrite as (
    method: unknown,
    input: Record<string, unknown>,
  ) => boolean;
  const recordMossCanvasEdited = edited.recordMossCanvasEdited as (
    threadId: string,
  ) => Effect.Effect<void, never, unknown>;
  const resetRecorded = edited.resetMossCanvasEditedForTests as () => void;

  let readModel = createEmptyReadModel(new Date().toISOString());
  let events: OrchestrationEventRecord[] = [];
  let sequence = 0;
  // One command at a time, as the engine's queue runs them.
  let queue: Promise<unknown> = Promise.resolve();
  const dispatch = (command: unknown) => {
    const run = queue.then(async () => {
      const decided = await Effect.runPromise(decide({ command, readModel }));
      const decidedEvents = Array.isArray(decided)
        ? decided
        : decided && typeof decided === "object" && "type" in decided
          ? [decided]
          : [];
      for (const event of decidedEvents as Array<Omit<OrchestrationEventRecord, "sequence">>) {
        sequence += 1;
        const stored = { ...event, sequence };
        readModel = await Effect.runPromise(projectEvent(readModel, stored));
        events.push(stored);
      }
      return { sequence };
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const knows = (threadId: string) => readModel.threads.some((thread) => thread.id === threadId);

  return {
    knows,
    request: async (method, input) => {
      if (method === "reset") {
        readModel = createEmptyReadModel(new Date().toISOString());
        events = [];
        sequence = 0;
        resetRecorded();
        return null;
      }
      if (method === "dispatch") return dispatch(decodeClientCommand(input.command));
      if (method === "readModel") return readModel;
      if (method === "events") {
        const after = typeof input.after === "number" ? input.after : 0;
        return events.filter((event) => event.sequence > after);
      }
      throw new Error(`unknown test orchestration method ${method}`);
    },
    recordCanvasWrite: async (threadId, method, input) => {
      if (!knows(threadId) || !isCanvasContentWrite(method, input)) return;
      await Effect.runPromise(
        recordMossCanvasEdited(threadId).pipe(
          Effect.provideService(
            queryService.ProjectionSnapshotQuery as never,
            {
              getThreadShellById: (id: string) => {
                const thread = readModel.threads.find((entry) => entry.id === id);
                return Effect.succeed(thread ? Option.some(thread) : Option.none());
              },
            } as never,
          ),
          Effect.provideService(
            engineService.OrchestrationEngineService as never,
            {
              dispatch: (command: unknown) => Effect.promise(() => dispatch(command)),
            } as never,
          ),
        ) as ServerEffect<void>,
      );
    },
  };
}

type HostedStorageHandle = {
  request: (method: string, input?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
};

const canvasBoardApiPlugin: CanvasServerPlugin = {
  name: "moss-page-editor-canvas-board-api",
  configureServer(server) {
    let storageStateDir: string | null = null;
    // Made on first use: only the tests that follow a chat into the lists load the server's
    // orchestration (`/api/moss/test/orchestration`).
    let orchestration: Promise<TestOrchestration> | null = null;
    const getOrchestration = () => (orchestration ??= createTestOrchestration(server));
    let storagePromise: Promise<HostedStorageHandle> | null = null;
    const getStorage = async (): Promise<HostedStorageHandle> => {
      if (!storagePromise) {
        storagePromise = (async () => {
          storageStateDir = mkdtempSync(join(tmpdir(), "moss-canvas-board-test-"));
          const moduleUrl = pathToFileURL(
            resolve(canvasStaticRoot, "../server/hosted-storage.mjs"),
          ).href;
          const mod = (await import(moduleUrl)) as {
            createMossCanvasHostedStorage: (input: {
              stateDirectory: string;
              conversation?: { threadId: string; title?: string };
            }) => Promise<HostedStorageHandle>;
          };
          return await mod.createMossCanvasHostedStorage({ stateDirectory: storageStateDir });
        })();
      }
      return storagePromise;
    };
    server.httpServer?.once("close", () => {
      const pending = storagePromise;
      const dir = storageStateDir;
      storagePromise = null;
      storageStateDir = null;
      if (pending) {
        void pending
          .then((handle) => handle.close())
          .catch(() => undefined)
          .finally(() => {
            if (dir) rmSync(dir, { recursive: true, force: true });
          });
      } else if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://canvas.invalid");
      if (request.method === "POST" && url.pathname === "/api/moss/test/orchestration") {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
            method?: string;
            input?: Record<string, unknown>;
          };
          const result = await (
            await getOrchestration()
          ).request(parsed.method ?? "", parsed.input ?? {});
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ result }));
        })().catch((error: unknown) => {
          // Like the real server, a command its decider rejects fails the window's dispatch.
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(
            JSON.stringify({
              error: { message: error instanceof Error ? error.message : String(error) },
            }),
          );
        });
        return;
      }
      if (
        !url.pathname.startsWith("/api/moss/media/canvas/") &&
        url.pathname !== "/api/moss/media/jobs"
      ) {
        next();
        return;
      }

      const boardPageId = url.searchParams.get("canvasBoard");
      const boardKey = url.searchParams.get("canvasBoardKey") ?? "";
      const boardSpace = url.searchParams.get("canvasBoardSpace") ?? "";
      const boardScope = boardPageId
        ? {
            pageId: boardPageId,
            canvasProjectKey: boardKey,
            scopeSpaceId: boardSpace ? boardSpace : null,
          }
        : null;

      const sendJson = (status: number, payload: unknown) => {
        const headers: Record<string, string> = {
          "content-type": "application/json; charset=utf-8",
        };
        if (boardScope) {
          headers["X-Moss-Canvas-Board"] = encodeURIComponent(JSON.stringify(boardScope));
        }
        response.writeHead(status, headers);
        response.end(JSON.stringify(payload));
      };

      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/account") {
        const canvasThread = url.searchParams.get("canvasThread");
        void (async () => {
          // Like the real server (resolveMossCanvasWorkspace): a conversation the server does not
          // know (a new chat nothing was sent in) has no Canvas. A `draft-…` thread is known once
          // its thread.create reached the server's orchestration.
          if (
            canvasThread?.startsWith("draft-") &&
            !(await getOrchestration()).knows(canvasThread)
          ) {
            sendJson(404, { error: { code: "canvas_thread_not_found" } });
            return;
          }
          sendJson(200, {
            authenticated: true,
            ...(boardScope ? { boardScope } : {}),
            ...(canvasThread
              ? {
                  workspace: {
                    threadId: canvasThread,
                    fingerprint: createHash("sha256").update(canvasThread).digest("hex"),
                  },
                }
              : {}),
            authority: "moss-desktop-database",
            realm: "cn",
            user: { id: "account-a", name: "Moss 用户", phone: "+8613800000000" },
          });
        })().catch(() => sendJson(500, { error: { code: "canvas_account_failed" } }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/moss/media/jobs") {
        sendJson(200, { models: [], jobs: [], ...(boardScope ? { boardScope } : {}) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/text/models") {
        sendJson(200, { models: [], ...(boardScope ? { boardScope } : {}) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/quota") {
        sendJson(200, { remaining: 999, unlimited: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/moss/media/canvas/storage") {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          const raw = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "{}";
          const parsed = JSON.parse(raw) as {
            method?: string;
            input?: Record<string, unknown>;
          };
          const method = parsed.method ?? "";
          if (method === "host.providers") {
            sendJson(200, {
              result: {
                version: 1,
                updatedAt: new Date().toISOString(),
                activeProviderId: "moss",
                providersPath: "",
                credentialStore: "moss-account",
                providers: [],
                models: [],
              },
              ...(boardScope ? { boardScope } : {}),
            });
            return;
          }
          if (method === "host.providerTest") {
            sendJson(200, {
              result: {
                ok: true,
                providerId: "moss",
                status: "available",
                apiReachable: true,
                authenticated: true,
                modelCount: 0,
              },
              ...(boardScope ? { boardScope } : {}),
            });
            return;
          }
          const storage = await getStorage();
          if (method === "test.mossCanvasMutate") {
            const mod = (await server.ssrLoadModule(
              resolve(repoRoot, "apps/server/src/mossCanvasMutate.ts"),
            )) as {
              applyMossCanvasOpsToSnapshot: (args: {
                existingSnapshot?: unknown;
                ops: unknown[];
                title?: string;
              }) => {
                snapshot: Record<string, unknown>;
                created: Record<string, string>;
                shapeCounts: Record<string, number>;
              };
            };
            const ops = Array.isArray(parsed.input?.ops) ? parsed.input.ops : [];
            const title = typeof parsed.input?.title === "string" ? parsed.input.title : "白板";
            const active = (await storage.request("projects.active")) as {
              relativePath?: string;
            } | null;
            const current = active?.relativePath
              ? ((await storage.request("projects.read", {
                  relativePath: active.relativePath,
                })) as { snapshot?: unknown } | null)
              : null;
            const mutated = mod.applyMossCanvasOpsToSnapshot({
              existingSnapshot: current?.snapshot,
              ops,
              title,
            });
            let entry: Record<string, unknown> | null;
            if (active?.relativePath) {
              entry = (await storage.request("projects.write", {
                relativePath: active.relativePath,
                snapshot: mutated.snapshot,
              })) as Record<string, unknown>;
            } else {
              const createdEntry = (await storage.request("projects.create", {
                title,
                snapshot: mutated.snapshot,
              })) as Record<string, unknown>;
              entry = (await storage.request("projects.setActive", {
                relativePath: createdEntry.relativePath,
              })) as Record<string, unknown>;
            }
            sendJson(200, {
              result: {
                revision: String(entry?.updatedAt ?? new Date().toISOString()),
                created: mutated.created,
                shapeCounts: mutated.shapeCounts,
              },
            });
            return;
          }
          const result = await storage.request(method, parsed.input ?? {});
          // Like the real storage route (mossMediaJobsRoute.ts): a conversation's 画布 saved with
          // content is recorded, before the answer, by the server's own recordMossCanvasEdited.
          const writtenThread = url.searchParams.get("canvasThread");
          if (writtenThread && orchestration) {
            await (
              await orchestration
            ).recordCanvasWrite(writtenThread, method, parsed.input ?? {});
          }
          sendJson(200, { result, ...(boardScope ? { boardScope } : {}) });
        })().catch((error: unknown) => {
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "canvas_storage_failed";
          sendJson(400, { error: { code } });
        });
        return;
      }

      next();
    });
  },
};

const shotsDir = process.env.VITE_MOSS_PAGE_EDITOR_SHOTS?.trim();
const shotsVariant = process.env.VITE_MOSS_PAGE_EDITOR_SHOTS_VARIANT?.trim();

// Merging would concatenate the stable include and exclude globs; this lane owns only Pages.
export default defineConfig({
  ...stableConfig,
  plugins: [...(stableConfig.plugins ?? []), canvasStaticPlugin, canvasBoardApiPlugin],
  define: {
    ...stableConfig.define,
    "import.meta.env.VITE_MOSS_PAGE_EDITOR_TEST_WS_URL": JSON.stringify("same-origin"),
    ...(shotsDir
      ? { "import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS": JSON.stringify(shotsDir) }
      : {}),
    ...(shotsVariant
      ? {
          "import.meta.env.VITE_MOSS_PAGE_EDITOR_SHOTS_VARIANT": JSON.stringify(shotsVariant),
        }
      : {}),
  },
  test: {
    ...stableConfig.test,
    include: [...PAGE_EDITOR_BROWSER_SPECS],
    exclude: configDefaults.exclude,
  },
});
