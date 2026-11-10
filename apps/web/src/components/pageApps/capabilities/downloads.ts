// FILE: downloads.ts
// Purpose: Shell half of `downloads`: every save is confirmed in a Moss
// dialog showing the file name and size, then saved by the shell.
// Layer: Web pageApps capability

import { PAGE_APP_DOWNLOAD_MAX_BYTES } from "@moss/contracts";
import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const UNSAFE_NAME = /[\u0000-\u001f<>:"/\\|?*]/gu;
const ALLOWED_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;

export function sanitizeDownloadName(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME, "_").replace(/^\.+/u, "").trim().slice(0, 180);
  return cleaned || "download";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface DownloadRequestArgs {
  readonly filename: string;
  readonly mimeType: string;
  readonly text: string | null;
  readonly bytes: Uint8Array | null;
}

export function parseDownloadArgs(args: unknown): { name: string; blob: Blob } {
  if (!args || typeof args !== "object")
    throw new PageAppCapabilityError("invalid_argument", "Malformed save().");
  const { filename, mimeType, text, bytes } = args as Partial<DownloadRequestArgs>;
  if (typeof filename !== "string")
    throw new PageAppCapabilityError("invalid_argument", "filename is required.");
  const type =
    typeof mimeType === "string" && ALLOWED_TYPE.test(mimeType)
      ? mimeType
      : "application/octet-stream";
  let blob: Blob;
  if (typeof text === "string")
    blob = new Blob([text], {
      type: type === "application/octet-stream" ? "text/plain;charset=utf-8" : type,
    });
  else if (bytes instanceof Uint8Array) blob = new Blob([new Uint8Array(bytes)], { type });
  else throw new PageAppCapabilityError("invalid_argument", "save() needs data.");
  if (blob.size > PAGE_APP_DOWNLOAD_MAX_BYTES)
    throw new PageAppCapabilityError("invalid_argument", "A download is at most 50 MB.");
  return { name: sanitizeDownloadName(filename), blob };
}

export const downloadsShellPlugin: PageAppShellPlugin = {
  name: "downloads",
  consent: "per-use",
  modes: ["full", "embed", "guest"],
  label: "保存文件",
  purpose: "让这个应用页把文件交给你保存，每次都会先问你。",
  rateLimit: { burst: 3, perMinute: 10 },
  call: async (ctx, method, args) => {
    if (method !== "save")
      throw new PageAppCapabilityError("invalid_argument", `downloads has no "${method}".`);
    const { name, blob } = parseDownloadArgs(args);
    const ok = await ctx.confirm({
      title: "保存文件？",
      body: `「${ctx.title}」想让你保存一个文件。`,
      confirmLabel: "保存",
      details: [name, formatBytes(blob.size)],
    });
    if (!ok) return { saved: false, filename: name };
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    return { saved: true, filename: name };
  },
};
