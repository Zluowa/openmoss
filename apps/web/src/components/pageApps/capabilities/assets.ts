// FILE: assets.ts
// Purpose: Shell half of `assets`: a page keeps its own files (images, video,
// PDF, fonts, CSV/JSON/text). Uploads go to the server in chunks; the server
// checks types, sanitizes SVG and enforces the caps.
// Layer: Web pageApps capability

import {
  PAGE_APP_ASSET_CHUNK_BYTES,
  PAGE_APP_ASSET_MAX_BYTES,
  type PageAppAsset,
} from "@moss/contracts";
import {
  PageAppCapabilityError,
  type PageAppShellContext,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

import { base64ToBytes, bytesToBase64 } from "./files";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function upload(ctx: PageAppShellContext, args: unknown): Promise<PageAppAsset> {
  if (!isRecord(args) || !(args.bytes instanceof Uint8Array) || typeof args.mimeType !== "string")
    throw new PageAppCapabilityError(
      "invalid_argument",
      "upload() needs a file or bytes with a type.",
    );
  const bytes = args.bytes;
  if (bytes.byteLength === 0)
    throw new PageAppCapabilityError("invalid_argument", "The file is empty.");
  if (bytes.byteLength > PAGE_APP_ASSET_MAX_BYTES)
    throw new PageAppCapabilityError("too_large", "A page file is at most 25 MB.");
  const begun = (await ctx.serverCall("begin", {
    name: typeof args.name === "string" ? args.name : "asset",
    mimeType: args.mimeType,
    size: bytes.byteLength,
  })) as { uploadId: string; chunkBytes: number };
  const step = Math.min(begun.chunkBytes, PAGE_APP_ASSET_CHUNK_BYTES);
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    await ctx.serverCall("chunk", {
      uploadId: begun.uploadId,
      base64: bytesToBase64(bytes.subarray(offset, offset + step)),
    });
  }
  return (await ctx.serverCall("finish", { uploadId: begun.uploadId })) as PageAppAsset;
}

async function read(ctx: PageAppShellContext, args: unknown) {
  const id = isRecord(args) && typeof args.id === "string" ? args.id : "";
  if (!id) throw new PageAppCapabilityError("invalid_argument", "read(id) needs an asset id.");
  const parts: Uint8Array[] = [];
  let asset: PageAppAsset | null = null;
  let offset = 0;
  for (;;) {
    const chunk = (await ctx.serverCall("read", { id, offset })) as {
      asset: PageAppAsset;
      base64: string;
      done: boolean;
    };
    asset = chunk.asset;
    const bytes = base64ToBytes(chunk.base64);
    parts.push(bytes);
    offset += bytes.byteLength;
    if (chunk.done || bytes.byteLength === 0) break;
  }
  const joined = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return { asset, bytes: joined };
}

export const assetsShellPlugin: PageAppShellPlugin = {
  name: "assets",
  consent: "none",
  modes: ["full", "embed", "guest"],
  label: "页面文件",
  purpose: "让这个应用页保存和显示它自己的图片、视频、PDF、字体和数据文件。",
  rateLimit: { burst: 60, perMinute: 240 },
  call: (ctx, method, args) => {
    switch (method) {
      case "list":
        return ctx.serverCall("list", null);
      case "upload":
        return upload(ctx, args);
      case "read":
        return read(ctx, args);
      case "delete":
        return ctx.serverCall("delete", args);
      default:
        throw new PageAppCapabilityError("invalid_argument", `assets has no "${method}".`);
    }
  },
};
