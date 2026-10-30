import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  outboundHttp,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
} from "@synara/shared/outboundHttp";
import { readRegularFileNoFollow } from "./workspaceImport/safeFile";

const IMAGE_LIMIT = 32 * 1024 * 1024;
const VIDEO_LIMIT = 128 * 1024 * 1024;
const ACCOUNT_LIMIT = 1024 * 1024 * 1024;
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export interface MossMediaAsset {
  readonly assetId: string;
  readonly index: number;
  readonly kind: "image" | "video";
  readonly contentType: string;
  readonly byteLength: number;
  readonly downloadPath: string;
}

export function validMossMediaAsset(value: unknown, jobId: string): value is MossMediaAsset {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.assetId === "string" &&
    /^[a-f0-9]{64}$/u.test(item.assetId) &&
    typeof item.index === "number" &&
    Number.isInteger(item.index) &&
    item.index >= 0 &&
    item.index < 32 &&
    (item.kind === "image" || item.kind === "video") &&
    typeof item.contentType === "string" &&
    item.contentType.startsWith(`${item.kind}/`) &&
    MIME_EXTENSIONS[item.contentType] !== undefined &&
    typeof item.byteLength === "number" &&
    Number.isSafeInteger(item.byteLength) &&
    item.byteLength > 0 &&
    item.byteLength <= (item.kind === "image" ? IMAGE_LIMIT : VIDEO_LIMIT) &&
    item.downloadPath === `/api/moss/media/assets/${jobId}/${item.index}`
  );
}

function matchesSignature(bytes: Uint8Array, mime: string): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64));
  if (mime === "image/png")
    return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/webp")
    return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  if (mime === "image/avif")
    return b.toString("ascii", 4, 8) === "ftyp" && /avif|avis/u.test(b.toString("ascii", 8));
  if (mime === "video/mp4") return b.toString("ascii", 4, 8) === "ftyp";
  return mime === "video/webm" && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

/** Downloads only provider-returned URLs through the existing DNS-pinned policy. */
export class MossMediaAssetStore {
  readonly #mutations = new Map<string, Promise<void>>();
  constructor(
    readonly stateDirectory: string,
    readonly download: (request: OutboundHttpRequest) => Promise<OutboundHttpResponse> = (
      request,
    ) => outboundHttp.request(request),
    readonly accountByteLimit = ACCOUNT_LIMIT,
  ) {}

  #directory(scope: string) {
    if (!/^[a-f0-9]{64}$/u.test(scope)) throw new Error("asset_scope_invalid");
    return join(this.stateDirectory, "media-assets", scope);
  }

  async #mutate<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutations.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => hold);
    this.#mutations.set(scope, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutations.get(scope) === queued) this.#mutations.delete(scope);
    }
  }

  async #save(scope: string, assetId: string, extension: string, bytes: Uint8Array): Promise<void> {
    await this.#mutate(scope, async () => {
      const directory = this.#directory(scope);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new Error("asset_directory_invalid");
      const path = join(directory, `${assetId}.${extension}`);
      try {
        const existing = await readRegularFileNoFollow(path, bytes.byteLength);
        if (
          existing.byteLength === bytes.byteLength &&
          createHash("sha256").update(existing).digest("hex") === assetId
        )
          return;
      } catch {
        /* Missing or corrupted output is replaced atomically below. */
      }
      let used = 0;
      let replacedBytes = 0;
      for (const name of await readdir(directory)) {
        const info = await lstat(join(directory, name));
        if (info.isFile() && !info.isSymbolicLink()) {
          used += info.size;
          if (name === `${assetId}.${extension}`) replacedBytes = info.size;
        }
      }
      if (used - replacedBytes + bytes.byteLength > Math.min(ACCOUNT_LIMIT, this.accountByteLimit))
        throw new Error("asset_storage_limit");
      const temporary = join(directory, `${assetId}.${randomUUID()}.tmp`);
      let stagingExists = false;
      try {
        const handle = await open(temporary, "wx", 0o600);
        stagingExists = true;
        try {
          await handle.chmod(0o600);
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        stagingExists = false;
      } finally {
        if (stagingExists) await unlink(temporary).catch(() => undefined);
      }
    });
  }

  async cache(
    scope: string,
    jobId: string,
    urls: readonly string[],
    kind: "image" | "video",
  ): Promise<readonly MossMediaAsset[]> {
    if (!/^moss_[A-Za-z0-9_-]+$/u.test(jobId)) throw new Error("asset_job_invalid");
    this.#directory(scope);
    const assets: MossMediaAsset[] = [];
    const deadline = Date.now() + 120_000;
    for (const [index, source] of urls.entries()) {
      if (index >= 32 || Date.now() >= deadline) break;
      try {
        const url = new URL(source);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("asset_url_invalid");
        const maximum = kind === "image" ? IMAGE_LIMIT : VIDEO_LIMIT;
        const response = await this.download({
          url,
          method: "GET",
          policy: {
            service: "moss-media-output",
            allowedOrigins: [url.origin],
            timeoutMs: Math.max(1, Math.min(90_000, deadline - Date.now())),
            maxRequestBytes: 0,
            maxResponseBytes: maximum,
            maxRedirects: 0,
            maxConcurrent: 2,
            maxQueued: 8,
            requirePublicAddress: true,
          },
        });
        const contentType =
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (
          response.status !== 200 ||
          !contentType.startsWith(`${kind}/`) ||
          !MIME_EXTENSIONS[contentType] ||
          response.body.byteLength === 0 ||
          response.body.byteLength > maximum ||
          !matchesSignature(response.body, contentType)
        ) {
          throw new Error("asset_response_invalid");
        }
        const assetId = createHash("sha256").update(response.body).digest("hex");
        await this.#save(scope, assetId, MIME_EXTENSIONS[contentType]!, response.body);
        assets.push({
          assetId,
          index,
          kind,
          contentType,
          byteLength: response.body.byteLength,
          downloadPath: `/api/moss/media/assets/${jobId}/${index}`,
        });
      } catch {
        // Provider generation already completed. Preserve its URL and report
        // partial/failed persistence; caching can never trigger regeneration.
      }
    }
    return assets;
  }

  async read(scope: string, asset: MossMediaAsset): Promise<Uint8Array> {
    const extension = MIME_EXTENSIONS[asset.contentType];
    if (!extension || !/^[a-f0-9]{64}$/u.test(asset.assetId)) throw new Error("asset_not_found");
    const path = join(this.#directory(scope), `${asset.assetId}.${extension}`);
    if (
      !Number.isSafeInteger(asset.byteLength) ||
      asset.byteLength <= 0 ||
      asset.byteLength > VIDEO_LIMIT
    )
      throw new Error("asset_not_found");
    const bytes = await readRegularFileNoFollow(path, asset.byteLength);
    if (
      bytes.byteLength !== asset.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== asset.assetId
    )
      throw new Error("asset_not_found");
    return bytes;
  }

  /** Resolve live references inside the mutation lock; null means a job is active. */
  async collectUnreferenced(
    scope: string,
    references: () => ReadonlySet<string> | null,
    retainedInHistory?: (assetId: string) => Promise<boolean>,
  ): Promise<void> {
    const directory = this.#directory(scope);
    await this.#mutate(scope, async () => {
      const referencedIds = references();
      if (referencedIds === null) return;
      try {
        for (const name of await readdir(directory)) {
          const match = name.match(/^([a-f0-9]{64})\.(?:png|jpg|webp|avif|mp4|webm)$/u);
          const abandonedStagingFile = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/u.test(name);
          if ((!match && !abandonedStagingFile) || (match && referencedIds.has(match[1]!)))
            continue;
          // Failure to consult the durable library aborts cleanup, never deletes.
          if (match && retainedInHistory && (await retainedInHistory(match[1]!))) continue;
          const path = join(directory, name);
          const info = await lstat(path);
          if (info.isFile() && !info.isSymbolicLink()) await unlink(path);
        }
      } catch {
        /* A cleanup failure must never change a provider charge or job outcome. */
      }
    });
  }
}
