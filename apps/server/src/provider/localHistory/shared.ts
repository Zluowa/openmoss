// FILE: shared.ts
// Purpose: Small helpers every local-history reader shares: visible text, dates, titles,
//          directory listing, and bounded concurrency.
// Layer: Provider local-history parsing

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

/** One imported message never needs to be larger than this. */
export const MAX_LOCAL_HISTORY_MESSAGE_CHARS = 64_000;
const TITLE_CHARS = 40;

// Prompts Moss injected while hosting a session carry the harness policy block;
// imported history should show only the user's own text.
const MOSS_HOST_CONTEXT_PATTERN = /<moss_host_context>[\s\S]*?<\/moss_host_context>/gu;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The text a person saw for a message: a plain string, or the `text` parts of a content
 * array. Reasoning, tool calls, tool output, and images are left out.
 */
export function visibleMessageText(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .flatMap((part) => {
        const record = asRecord(part);
        if (!record || typeof record.text !== "string") return [];
        // Codex spells the part type "Text"; every other agent uses "text".
        return record.type === undefined || String(record.type).toLowerCase() === "text"
          ? [record.text]
          : [];
      })
      .join("\n\n");
  } else {
    return "";
  }
  const visible = text.replace(MOSS_HOST_CONTEXT_PATTERN, "").trim();
  return visible.length > MAX_LOCAL_HISTORY_MESSAGE_CHARS
    ? `${visible.slice(0, MAX_LOCAL_HISTORY_MESSAGE_CHARS - 1)}…`
    : visible;
}

/** ISO date from an ISO string or a Unix time in seconds or milliseconds. */
export function isoTimestamp(value: unknown): string | undefined {
  const milliseconds =
    typeof value === "number"
      ? Math.abs(value) < 1e12
        ? value * 1_000
        : value
      : typeof value === "string" && value.trim().length > 0
        ? Date.parse(value.trim())
        : Number.NaN;
  if (!Number.isFinite(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

// Harnesses prepend context blocks such as `<system-reminder>…</system-reminder>` to prompts.
const LEADING_CONTEXT_BLOCK = /^\s*<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/u;

// Identifiers a person never typed as a title: UUIDs and long hex ids, with any
// `(session_id: …)`-style wrapper around them.
const TITLE_IDENTIFIER =
  /[(（]?\s*(?:[a-z_]*id\s*[:：=]\s*)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{24,})\s*[)）]?/giu;
const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
// Markdown markers and quotes that open a prompt line.
const TITLE_LEAD = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|["'“”‘’`]+)+/u;

/**
 * A short one-line title (about 40 characters) from an agent's thread name or a prompt:
 * injected context blocks, ids, and markdown are dropped, and only the first line is kept.
 */
export function titleFromText(text: string | undefined): string | undefined {
  let remaining = text ?? "";
  for (let match = LEADING_CONTEXT_BLOCK.exec(remaining); match; ) {
    remaining = remaining.slice(match[0].length);
    match = LEADING_CONTEXT_BLOCK.exec(remaining);
  }
  const line = remaining
    .split(/\r?\n/u)
    .map((entry) =>
      entry
        // A removed id leaves no gap between Chinese, Japanese or Korean characters.
        .replace(
          new RegExp(`(\\S?)\\s*${TITLE_IDENTIFIER.source}\\s*(\\S?)`, "giu"),
          (_match, before: string, after: string) =>
            `${before}${CJK_CHARACTER.test(before) || CJK_CHARACTER.test(after) ? "" : " "}${after}`,
        )
        .replace(TITLE_LEAD, "")
        .replace(/\s+/gu, " ")
        .replace(/["'“”‘’`]+$/u, "")
        .trim(),
    )
    .find(Boolean);
  if (!line) return undefined;
  const characters = [...line];
  return characters.length > TITLE_CHARS
    ? `${characters
        .slice(0, TITLE_CHARS - 1)
        .join("")
        .trimEnd()}…`
    : line;
}

export function absolutePath(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && (nodePath.isAbsolute(text) || /^[A-Za-z]:[\\/]/u.test(text)) ? text : undefined;
}

/** An absolute directory override from the environment; relative values are ignored. */
/**
 * A directory from an environment override or an agent's settings: absolute, or `~/...` under
 * the person's home (agents such as Pi expand it themselves). Relative values are ignored.
 */
export function homeDirectory(value: unknown, homeDir?: string): string | undefined {
  const text = nonEmptyString(value);
  if (!text || text.includes("\0")) return undefined;
  if (homeDir && (text === "~" || /^~[\\/]/u.test(text))) {
    return nodePath.join(homeDir, text.slice(1));
  }
  return absolutePath(text);
}

/** A directory override from the environment; see {@link homeDirectory}. */
export function envDirectory(
  env: NodeJS.ProcessEnv,
  key: string,
  homeDir?: string,
): string | undefined {
  return homeDirectory(env[key], homeDir);
}

export async function listDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

export async function modifiedAt(file: string): Promise<string | undefined> {
  try {
    return new Date((await fs.stat(file)).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/** Runs `operation` over `values` with at most `limit` in flight, preserving order. */
export async function mapBounded<T, R>(
  values: ReadonlyArray<T>,
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: values.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}
