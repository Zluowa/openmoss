// FILE: files.ts
// Purpose: Shell half of `files`: a page lists and reads one Moss project's
// files (asked once, remembered per page). Saving a project file to the
// viewer's computer is confirmed every time with its name and size; program
// and script files are never handed out.
// Layer: Web pageApps capability

import {
  PAGE_APP_FILES_MAX_DOWNLOAD_BYTES,
  PAGE_APP_FILES_MAX_READ_BYTES,
  type PageAppFilesReadWire,
} from "@moss/contracts";
import {
  PageAppCapabilityError,
  type PageAppShellContext,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

import { formatBytes, sanitizeDownloadName } from "./downloads";

const BLOCKED_DOWNLOAD =
  /\.(?:exe|msi|msix|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|hta|cpl|jar|lnk|reg|sh|bash|zsh|app|dmg|pkg|deb|rpm|apk|appx)$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function read(ctx: PageAppShellContext, args: unknown) {
  const wire = (await ctx.serverCall("read", args)) as PageAppFilesReadWire;
  return { bytes: base64ToBytes(wire.base64), size: wire.size, revision: wire.revision };
}

async function download(ctx: PageAppShellContext, args: unknown) {
  const path = isRecord(args) && typeof args.path === "string" ? args.path : "";
  if (!path) throw new PageAppCapabilityError("invalid_argument", "download(path) needs a path.");
  const info = (await ctx.serverCall("stat", { path })) as {
    path: string;
    isDirectory: boolean;
    size: number;
    revision: string;
  };
  if (info.isDirectory)
    throw new PageAppCapabilityError("invalid_argument", "A folder cannot be saved; pick a file.");
  const name = sanitizeDownloadName(path.split("/").pop() ?? "file");
  if (BLOCKED_DOWNLOAD.test(name))
    throw new PageAppCapabilityError(
      "invalid_argument",
      "Programs and scripts cannot be saved from a page.",
    );
  if (info.size > PAGE_APP_FILES_MAX_DOWNLOAD_BYTES)
    throw new PageAppCapabilityError("too_large", "This file is over 200 MB.");
  const ok = await ctx.confirm({
    title: "保存项目文件？",
    body: `「${ctx.title}」想把项目里的一个文件保存到你的电脑。`,
    confirmLabel: "保存",
    details: [name, path, formatBytes(info.size)],
  });
  if (!ok) throw new PageAppCapabilityError("declined", "The viewer declined the save.");
  const parts: Uint8Array[] = [];
  let offset = 0;
  do {
    const chunk = (await ctx.serverCall("read", {
      path,
      offset,
      length: PAGE_APP_FILES_MAX_READ_BYTES,
      purpose: "download",
    })) as PageAppFilesReadWire;
    if (chunk.revision !== info.revision)
      throw new PageAppCapabilityError(
        "changed",
        "The file changed while it was being saved; try again.",
      );
    const bytes = base64ToBytes(chunk.base64);
    parts.push(bytes);
    offset += bytes.byteLength;
    if (bytes.byteLength === 0) break;
  } while (offset < info.size);
  const url = URL.createObjectURL(new Blob(parts.map((part) => new Uint8Array(part))));
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
  return { status: "saved", filename: name };
}

export const filesShellPlugin: PageAppShellPlugin = {
  name: "files",
  consent: "standing",
  modes: ["full", "embed"],
  label: "读取项目文件",
  purpose: "让这个应用页读取一个 Moss 项目里的文件（只读，不会修改）。保存文件到电脑时会再问你。",
  rateLimit: { burst: 60, perMinute: 300 },
  call: (ctx, method, args) => {
    switch (method) {
      case "list":
      case "stat":
        return ctx.serverCall(method, args);
      case "read": {
        const { purpose: _purpose, ...clean } = isRecord(args) ? args : {};
        return read(ctx, clean);
      }
      case "download":
        return download(ctx, args);
      default:
        throw new PageAppCapabilityError("invalid_argument", `files has no "${method}".`);
    }
  },
};
