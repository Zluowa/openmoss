// The account-scoped Moss host reuses Open Moss Canvas's durable project and
// snapshot modules. No renderer path or account field chooses a storage root.
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outboundHttp } from "@synara/shared/outboundHttp";
import {
  mediaAccountScope,
  MossMediaJobsError,
  type MossMediaCredential,
  type MossMediaIdentity,
} from "./mossMediaJobsService";
import type { MossCanvasWorkspace } from "./mossCanvasWorkspace";

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
const stores = new Map<string, Promise<CanvasStorage>>();

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

export function mossCanvasStorageFor(
  stateDirectory: string,
  credential: MossMediaIdentity,
  workspace?: MossCanvasWorkspace | null,
): Promise<CanvasStorage> {
  const scope = mediaAccountScope(credential);
  const directory = workspace
    ? join(
        workspace.cwd,
        ".moss",
        "canvas",
        scope,
        createHash("sha256").update(workspace.threadId).digest("hex"),
      )
    : join(stateDirectory, "moss-canvas", scope);
  let pending = stores.get(directory);
  if (!pending) {
    pending = (async () => {
      if (workspace) {
        // Every newly created ancestor remains inside the server-selected cwd.
        // Never follow a pre-existing .moss/canvas link into another directory.
        let current = workspace.cwd;
        for (const part of [
          ".moss",
          "canvas",
          scope,
          createHash("sha256").update(workspace.threadId).digest("hex"),
        ]) {
          current = join(current, part);
          await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          });
          const info = await lstat(current);
          if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current)
            throw new MossMediaJobsError("canvas_workspace_path_invalid", 409);
        }
      }
      const root = await resolveMossCanvasBundleRoot();
      const moduleUrl = pathToFileURL(
        join(root, "apps/codex-canvas/server/hosted-storage.mjs"),
      ).href;
      const upstream = (await import(moduleUrl)) as {
        createMossCanvasHostedStorage(input: {
          stateDirectory: string;
          conversation?: { threadId: string; title: string };
        }): Promise<CanvasStorage>;
      };
      return upstream.createMossCanvasHostedStorage({
        stateDirectory: directory,
        ...(workspace
          ? { conversation: { threadId: workspace.threadId, title: workspace.title } }
          : {}),
      });
    })().catch((error: unknown) => {
      stores.delete(directory);
      throw error;
    });
    stores.set(directory, pending);
  }
  return pending;
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
