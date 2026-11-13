// The account-scoped Moss host reuses Open Moss Canvas's durable project and
// snapshot modules. No renderer path or account field chooses a storage root.
import { access, cp, lstat, mkdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";
import { outboundHttp } from "@moss/shared/outboundHttp";
import { RUNTIME_RESIDENCY_POLICIES } from "@moss/shared/runtimeResidency";
import {
  mediaAccountScope,
  MossMediaJobsError,
  type MossMediaCredential,
  type MossMediaIdentity,
} from "./mossMediaJobsService";
import type { MossCanvasWorkspace } from "./mossCanvasWorkspace";
import { createIdleResourcePool } from "./idleResourcePool";

interface CanvasStorage {
  request(method: string, input?: Record<string, unknown>): Promise<unknown>;
  readAsset(name: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  readKnowledgeAsset(name: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  close(): void;
}

export async function promoteMossCanvasAsset(
  input: Record<string, unknown>,
  credential: MossMediaCredential,
): Promise<Response> {
  const root = await resolveMossCanvasBundleRoot();
  const upstream = (await import(
    pathToFileURL(join(root, "apps/codex-canvas/electron/moss-canvas-direct-media.mjs")).href
  )) as {
    forwardMossCanvasAssetPromotion(
      request: Request,
      credential: MossMediaCredential,
    ): Promise<Response>;
  };
  return upstream.forwardMossCanvasAssetPromotion(
    new Request("http://localhost/api/canvas/assets/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    credential,
  );
}
// A conversation's store opens on its first request and closes when unused, under the shared
// residency policy (idleResourcePool.ts): no request for five minutes, or more than eight open.
const stores = createIdleResourcePool<CanvasStorage>(RUNTIME_RESIDENCY_POLICIES.conversationStore);
/** Open conversation Canvas stores right now (diagnostics and tests). */
export const mossCanvasOpenStoreCount = () => stores.openCount();
/** Release every Canvas store and its folder's writer lease, e.g. on shutdown. */
export const closeMossCanvasStores = () => stores.closeAll();

export async function resolveMossCanvasBundleRoot(): Promise<string> {
  const candidates = [
    ...(process.env.MOSS_CANVAS_BUNDLE_DIR ? [resolve(process.env.MOSS_CANVAS_BUNDLE_DIR)] : []),
    ...(process.env.MOSS_CANVAS_SOURCE_DIR ? [resolve(process.env.MOSS_CANVAS_SOURCE_DIR)] : []),
    resolve(import.meta.dirname, "../../desktop/canvas-bundle"),
    ...(typeof process.resourcesPath === "string"
      ? [join(process.resourcesPath, "moss-canvas")]
      : []),
  ];
  for (const root of candidates) {
    try {
      await access(join(root, "apps/codex-canvas/server/hosted-storage.mjs"));
      return root;
    } catch {
      continue;
    }
  }
  throw new MossMediaJobsError("canvas_bundle_unavailable", 503);
}

const threadKey = (threadId: string) => createHash("sha256").update(threadId).digest("hex");

/**
 * Where one account's Canvas for one conversation (or the account-wide Canvas) lives: in Moss's
 * own state, never in the project. A Canvas inside the project (`.moss/canvas/…`, the layout
 * before 2026-11-11) showed up as project changes and its deep asset paths broke checkpoints with
 * Windows' "Filename too long". The thread key is shortened to keep the canvas's own folders short.
 */
export function mossCanvasStorageDirectory(
  stateDirectory: string,
  credential: MossMediaIdentity,
  workspace?: MossCanvasWorkspace | null,
): string {
  const scope = mediaAccountScope(credential);
  return workspace
    ? join(stateDirectory, "moss-canvas-threads", scope, threadKey(workspace.threadId).slice(0, 32))
    : join(stateDirectory, "moss-canvas", scope);
}

/** The pre-2026-11-11 location inside the conversation's folder. */
export function legacyMossCanvasDirectory(
  credential: MossMediaIdentity,
  workspace: MossCanvasWorkspace,
): string {
  return join(
    workspace.cwd,
    ".moss",
    "canvas",
    mediaAccountScope(credential),
    threadKey(workspace.threadId),
  );
}

/**
 * The legacy Canvas folder, only when every part of its path below the conversation's folder is
 * a real directory there: a link out of the project is never followed, moved or deleted.
 */
async function realLegacyDirectory(
  credential: MossMediaIdentity,
  workspace: MossCanvasWorkspace,
): Promise<string | null> {
  let current = workspace.cwd;
  for (const part of [
    ".moss",
    "canvas",
    mediaAccountScope(credential),
    threadKey(workspace.threadId),
  ]) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
        return null;
    } catch {
      return null;
    }
  }
  return current;
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Moves a legacy Canvas into Moss's state: a rename on the same volume, otherwise a copy and
 * then the old folder's removal. Returns where the Canvas is now; if it could not be moved it
 * stays usable where it was. Emptied `.moss/canvas` folders are removed; `.moss` only if empty.
 */
async function moveLegacyCanvas(legacy: string, target: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await rename(legacy, target);
  } catch {
    try {
      await cp(toNamespacedPath(legacy), toNamespacedPath(target), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
    } catch {
      await rm(toNamespacedPath(target), { recursive: true, force: true }).catch(() => undefined);
      return legacy;
    }
    await rm(toNamespacedPath(legacy), { recursive: true, force: true }).catch(() => undefined);
  }
  // Only empty folders: anything else under .moss is not the Canvas's.
  for (let folder = dirname(legacy), depth = 0; depth < 3; folder = dirname(folder), depth += 1)
    await rmdir(folder).catch(() => undefined);
  return target;
}

/** Whether this conversation's Canvas exists yet (here or at its legacy place). Never creates it. */
export async function mossCanvasStorageExists(
  stateDirectory: string,
  credential: MossMediaIdentity,
  workspace?: MossCanvasWorkspace | null,
): Promise<boolean> {
  const directory = mossCanvasStorageDirectory(stateDirectory, credential, workspace);
  if (stores.isOpen(directory)) return true;
  if (await isRealDirectory(directory)) return true;
  return workspace ? (await realLegacyDirectory(credential, workspace)) !== null : false;
}

export function mossCanvasStorageFor(
  stateDirectory: string,
  credential: MossMediaIdentity,
  workspace?: MossCanvasWorkspace | null,
): Promise<CanvasStorage> {
  const target = mossCanvasStorageDirectory(stateDirectory, credential, workspace);
  const handle = stores.handle(target, async () => {
    let directory = target;
    if (workspace && !(await isRealDirectory(target))) {
      // A Canvas made before 2026-11-11 lives in the project; bring it over once.
      const legacy = await realLegacyDirectory(credential, workspace);
      if (legacy) directory = await moveLegacyCanvas(legacy, target);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await resolveMossCanvasBundleRoot();
    const moduleUrl = pathToFileURL(join(root, "apps/codex-canvas/server/hosted-storage.mjs")).href;
    const upstream = (await import(moduleUrl)) as {
      createMossCanvasHostedStorage(input: {
        stateDirectory: string;
        conversation?: { threadId: string; title: string };
      }): Promise<CanvasStorage>;
    };
    return upstream.createMossCanvasHostedStorage({
      // SQLite opens the folder through the Windows long-path namespace.
      stateDirectory: toNamespacedPath(directory),
      ...(workspace
        ? { conversation: { threadId: workspace.threadId, title: workspace.title } }
        : {}),
    });
  });
  // Callers may keep this object: every call goes through the pool, which reopens a store that
  // was closed while idle. Opening now keeps the contract that a store which cannot open (missing
  // bundle, unsafe folder) rejects here.
  const facade: CanvasStorage = {
    request: (method, input) => handle.use((store) => store.request(method, input)),
    readAsset: (name) => handle.use((store) => store.readAsset(name)),
    readKnowledgeAsset: (name) => handle.use((store) => store.readKnowledgeAsset(name)),
    close: () => void handle.close(),
  };
  return handle.use(() => facade);
}

export async function cacheMossCanvasRemoteAsset(
  store: CanvasStorage,
  input: Record<string, unknown>,
  readMediaAsset?: (
    jobId: string,
    index: number,
  ) => Promise<{ bytes: Uint8Array; asset: { contentType: string } }>,
): Promise<unknown> {
  if (typeof input.url !== "string") throw new MossMediaJobsError("canvas_asset_invalid");
  const url = new URL(input.url, "http://moss-canvas.invalid");
  const localOutput = url.pathname.match(
    /^\/api\/moss\/media\/assets\/(moss_[A-Za-z0-9_-]{1,128})\/([0-9]{1,2})$/u,
  );
  if (
    localOutput &&
    (url.origin === "http://moss-canvas.invalid" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  ) {
    if (!readMediaAsset) throw new MossMediaJobsError("canvas_asset_not_found", 404);
    // These IDs resolve through the current account's existing durable output
    // store. Never send the desktop credential to a URL supplied by the frame.
    const output = await readMediaAsset(localOutput[1]!, Number(localOutput[2]));
    return store.request("workspace.importAssetBytes", {
      bytesBase64: Buffer.from(output.bytes).toString("base64"),
      mimeType: output.asset.contentType,
      fileName: typeof input.fileName === "string" ? input.fileName : "canvas-output",
    });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new MossMediaJobsError("canvas_asset_url_invalid");
  const response = await outboundHttp.request({
    url,
    method: "GET",
    policy: {
      service: "moss-canvas-asset",
      allowedOrigins: [url.origin],
      requirePublicAddress: true,
      timeoutMs: 90_000,
      maxRequestBytes: 0,
      maxResponseBytes: 128 * 1024 * 1024,
      maxRedirects: 0,
      maxConcurrent: 2,
      maxQueued: 8,
    },
  });
  if (response.status !== 200) throw new MossMediaJobsError("canvas_asset_unavailable", 502);
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return store.request("workspace.importAssetBytes", {
    bytesBase64: Buffer.from(response.body).toString("base64"),
    fileName: typeof input.fileName === "string" ? input.fileName : "canvas-asset",
    mimeType,
  });
}
