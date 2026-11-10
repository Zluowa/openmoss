// FILE: assets.ts
// Purpose: Server half of the `assets` capability: files an 应用页 keeps for
// itself (images, video, audio, PDF, fonts, CSV/JSON/text). Uploads arrive in
// chunks, are checked against their declared type (magic bytes, UTF-8, JSON),
// SVGs are rewritten by the sanitizer, and size caps apply per file and per
// page. The bytes are served from the page's own origin by `assetRoute.ts`.
// Layer: Server pages/apps

import { createHash, randomUUID } from "node:crypto";

import {
  PAGE_APP_ASSET_CHUNK_BYTES,
  PAGE_APP_ASSET_MAX_BYTES,
  PAGE_APP_ASSET_PATH,
  PAGE_APP_ASSET_TYPES,
  PAGE_APP_ASSETS_MAX_COUNT,
  PAGE_APP_ASSETS_MAX_TOTAL_BYTES,
  PAGE_APP_FILES_MAX_READ_BYTES,
  type PageAppAsset,
  type PageAppAssetType,
  type PageAppViewerLevel,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";

import type { PageAppAssetRow, PageAppExtensionStore } from "../extensions/PageAppExtensionStore";
import { sanitizeSvg } from "../extensions/svgSanitize";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

const UPLOAD_TTL_MS = 10 * 60_000;
const MAX_OPEN_UPLOADS = 8;
const LEVELS: readonly PageAppViewerLevel[] = ["view", "interact", "admin", "owner"];
const TEXT_TYPES = new Set<PageAppAssetType>([
  "text/csv",
  "application/json",
  "text/plain",
  "image/svg+xml",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);

export function sanitizeAssetName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 180);
  return cleaned || "asset";
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, offset) => bytes[at + offset] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));

/** True when the bytes look like the declared type. */
export function matchesAssetType(type: PageAppAssetType, bytes: Uint8Array): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return ascii(bytes, 0, 4) === "GIF8";
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "image/avif":
      return ascii(bytes, 4, 8) === "ftyp" && /avi[fs]/u.test(ascii(bytes, 8, 32));
    case "video/mp4":
      return ascii(bytes, 4, 8) === "ftyp";
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/mpeg":
      return (
        ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
      );
    case "audio/wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "font/woff":
      return ascii(bytes, 0, 4) === "wOFF";
    case "font/woff2":
      return ascii(bytes, 0, 4) === "wOF2";
    case "font/ttf":
      return startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || ascii(bytes, 0, 4) === "true";
    case "font/otf":
      return ascii(bytes, 0, 4) === "OTTO";
    case "text/csv":
    case "text/plain":
    case "application/json":
    case "image/svg+xml":
      return true;
  }
}

/** Checks and, for SVG, rewrites the bytes. Throws with a code the page can show. */
export function prepareAssetBytes(type: PageAppAssetType, bytes: Uint8Array): Uint8Array {
  if (!TEXT_TYPES.has(type)) {
    if (!matchesAssetType(type, bytes))
      throw fail("invalid_argument", `The file is not a valid ${type}.`);
    return bytes;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail("invalid_argument", "Text files must be UTF-8.");
  }
  if (type === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      throw fail("invalid_argument", "The file is not valid JSON.");
    }
    return bytes;
  }
  if (type === "image/svg+xml") {
    const clean = sanitizeSvg(text);
    if (!clean) throw fail("invalid_argument", "The file is not a usable SVG.");
    return new TextEncoder().encode(clean);
  }
  return bytes;
}

export const assetPublicShape = (row: PageAppAssetRow): PageAppAsset => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  size: row.size,
  sha256: row.sha256,
  createdAt: row.createdAt,
  path: `${PAGE_APP_ASSET_PATH}/${row.id}`,
});

interface OpenUpload {
  readonly id: string;
  readonly appId: string;
  readonly viewerId: string;
  readonly name: string;
  readonly mimeType: PageAppAssetType;
  readonly size: number;
  readonly chunks: Uint8Array[];
  received: number;
  readonly startedAt: number;
}

export interface PageAppAssetsDeps {
  readonly store: PageAppExtensionStore;
  readonly now: () => string;
  readonly clock?: () => number;
}

export function makeAssetsCapability(deps: PageAppAssetsDeps): PageAppServerCapability {
  const clock = deps.clock ?? Date.now;
  const uploads = new Map<string, OpenUpload>();

  const sweep = () => {
    for (const [id, upload] of uploads)
      if (clock() - upload.startedAt > UPLOAD_TTL_MS) uploads.delete(id);
  };

  const uploadLevel = (ctx: PageAppServerCallContext): PageAppViewerLevel => {
    const declared = isRecord(ctx.config) ? ctx.config.upload : undefined;
    return typeof declared === "string" && (LEVELS as readonly string[]).includes(declared)
      ? (declared as PageAppViewerLevel)
      : "admin";
  };
  const mayWrite = (ctx: PageAppServerCallContext) =>
    LEVELS.indexOf(ctx.viewer.level) >= LEVELS.indexOf(uploadLevel(ctx));

  const call = (ctx: PageAppServerCallContext, method: string, raw: unknown) =>
    Effect.gen(function* () {
      const args = isRecord(raw) ? raw : {};
      const appId = ctx.app.id;
      switch (method) {
        case "list":
          return {
            assets: (yield* deps.store.listAssets(appId)).map(assetPublicShape),
            canUpload: mayWrite(ctx),
          };
        case "begin": {
          if (!mayWrite(ctx))
            return yield* Effect.fail(fail("not_granted", "You cannot add files to this page."));
          sweep();
          const type = args.mimeType;
          if (
            typeof type !== "string" ||
            !(PAGE_APP_ASSET_TYPES as readonly string[]).includes(type)
          )
            return yield* Effect.fail(
              fail(
                "invalid_argument",
                `This file type is not allowed. Allowed: ${PAGE_APP_ASSET_TYPES.join(", ")}.`,
              ),
            );
          const size = args.size;
          if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1)
            return yield* Effect.fail(
              fail("invalid_argument", "size must be the file's byte count."),
            );
          if (size > PAGE_APP_ASSET_MAX_BYTES)
            return yield* Effect.fail(fail("too_large", "A page file is at most 25 MB."));
          const totals = yield* deps.store.assetTotals(appId);
          if (totals.count >= PAGE_APP_ASSETS_MAX_COUNT)
            return yield* Effect.fail(
              fail("quota_exceeded", `A page keeps at most ${PAGE_APP_ASSETS_MAX_COUNT} files.`),
            );
          if (totals.bytes + size > PAGE_APP_ASSETS_MAX_TOTAL_BYTES)
            return yield* Effect.fail(
              fail("quota_exceeded", "This page's files would pass 200 MB."),
            );
          if (
            [...uploads.values()].filter((upload) => upload.appId === appId).length >=
            MAX_OPEN_UPLOADS
          )
            return yield* Effect.fail(fail("resource_exhausted", "Too many uploads at once."));
          const id = randomUUID();
          uploads.set(id, {
            id,
            appId,
            viewerId: ctx.viewer.id,
            name: sanitizeAssetName(typeof args.name === "string" ? args.name : "asset"),
            mimeType: type as PageAppAssetType,
            size,
            chunks: [],
            received: 0,
            startedAt: clock(),
          });
          return { uploadId: id, chunkBytes: PAGE_APP_ASSET_CHUNK_BYTES };
        }
        case "chunk": {
          const upload = typeof args.uploadId === "string" ? uploads.get(args.uploadId) : undefined;
          if (!upload || upload.appId !== appId || upload.viewerId !== ctx.viewer.id)
            return yield* Effect.fail(fail("not_found", "That upload is gone; start again."));
          if (typeof args.base64 !== "string")
            return yield* Effect.fail(fail("invalid_argument", "chunk needs base64 data."));
          const bytes = new Uint8Array(Buffer.from(args.base64, "base64"));
          if (
            bytes.byteLength > PAGE_APP_ASSET_CHUNK_BYTES ||
            upload.received + bytes.byteLength > upload.size
          ) {
            uploads.delete(upload.id);
            return yield* Effect.fail(fail("too_large", "The upload is bigger than announced."));
          }
          upload.chunks.push(bytes);
          upload.received += bytes.byteLength;
          return { received: upload.received };
        }
        case "finish": {
          const upload = typeof args.uploadId === "string" ? uploads.get(args.uploadId) : undefined;
          if (!upload || upload.appId !== appId || upload.viewerId !== ctx.viewer.id)
            return yield* Effect.fail(fail("not_found", "That upload is gone; start again."));
          uploads.delete(upload.id);
          if (upload.received !== upload.size)
            return yield* Effect.fail(
              fail("invalid_argument", "The upload ended before all bytes arrived."),
            );
          const joined = Buffer.concat(upload.chunks);
          const prepared = yield* Effect.try({
            try: () => prepareAssetBytes(upload.mimeType, new Uint8Array(joined)),
            catch: (error) =>
              error instanceof PageAppCapabilityError
                ? error
                : fail("invalid_argument", "The file could not be read."),
          });
          const totals = yield* deps.store.assetTotals(appId);
          if (totals.bytes + prepared.byteLength > PAGE_APP_ASSETS_MAX_TOTAL_BYTES)
            return yield* Effect.fail(
              fail("quota_exceeded", "This page's files would pass 200 MB."),
            );
          const row: PageAppAssetRow = {
            id: randomUUID(),
            appId,
            name: upload.name,
            mimeType: upload.mimeType,
            size: prepared.byteLength,
            sha256: createHash("sha256").update(prepared).digest("hex"),
            createdBy: ctx.viewer.id,
            createdAt: deps.now(),
          };
          yield* deps.store.insertAsset(row, prepared);
          return assetPublicShape(row);
        }
        case "read": {
          // For pages on the opaque fallback origin, which cannot load /__moss_app/asset.
          if (typeof args.id !== "string")
            return yield* Effect.fail(fail("invalid_argument", "read needs an id."));
          const found = yield* deps.store.readAsset(appId, args.id);
          if (!found) return yield* Effect.fail(fail("not_found", "No such file."));
          const offset =
            typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 0
              ? args.offset
              : 0;
          const slice = found.data.subarray(offset, offset + PAGE_APP_FILES_MAX_READ_BYTES);
          return {
            asset: assetPublicShape(found.row),
            base64: Buffer.from(slice).toString("base64"),
            done: offset + slice.byteLength >= found.data.byteLength,
          };
        }
        case "delete": {
          if (!mayWrite(ctx))
            return yield* Effect.fail(fail("not_granted", "You cannot remove this page's files."));
          if (typeof args.id !== "string")
            return yield* Effect.fail(fail("invalid_argument", "delete needs an id."));
          return { deleted: yield* deps.store.deleteAsset(appId, args.id) };
        }
        default:
          return yield* Effect.fail(fail("invalid_argument", `assets has no "${method}".`));
      }
    });

  return {
    name: "assets",
    consent: "none",
    validateConfig: (config) => {
      if (config === undefined || config === null) return null;
      if (!isRecord(config)) return "assets config must be an object.";
      if (config.upload !== undefined && !(LEVELS as readonly unknown[]).includes(config.upload))
        return "assets.upload must be view, interact, admin or owner.";
      return null;
    },
    call,
  };
}
