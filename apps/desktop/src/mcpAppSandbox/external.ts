// FILE: external.ts
// Purpose: Validation for the widget host's external actions: opening a link
// with the system shell and saving a downloaded file (pure).
// Layer: Electron main-process support.

import { MCP_APP_EXTERNAL_URL_SCHEMES } from "@moss/contracts";

const MAX_EXTERNAL_URL_CHARS = 8_192;

/** The URL to hand to the system shell, or null when it must not be opened. */
export function normalizeMcpAppExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EXTERNAL_URL_CHARS) {
    return null;
  }
  if (value !== value.trim() || /[\p{Cc}]/u.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!(MCP_APP_EXTERNAL_URL_SCHEMES as readonly string[]).includes(parsed.protocol)) return null;
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname === "") {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.pathname === "") {
    return null;
  }
  return parsed.href;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu;
const MAX_FILE_NAME_CHARS = 200;

/**
 * A plain file name for the save dialog: no directories, no control or
 * reserved characters, no Windows device names, no trailing dots or spaces.
 */
export function sanitizeMcpAppDownloadFileName(value: string): string {
  const lastSegment = value.split(/[\\/]/u).pop() ?? "";
  let name = lastSegment
    .replace(/[\p{Cc}<>:"|?*]/gu, "_")
    .replace(/^[\s.]+/u, "")
    .replace(/[\s.]+$/u, "");
  if (name.length > MAX_FILE_NAME_CHARS) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, MAX_FILE_NAME_CHARS - extension.length) + extension;
  }
  if (name.length === 0 || WINDOWS_RESERVED_NAME.test(name))
    name = `download${name ? `-${name}` : ""}`;
  return name;
}
