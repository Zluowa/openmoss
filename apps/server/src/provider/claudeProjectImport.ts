import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { readJsonlRecords } from "./localHistory/jsonlRecords.ts";
import {
  asRecord,
  isoTimestamp,
  mapBounded,
  nonEmptyString,
  titleFromText,
  visibleMessageText,
} from "./localHistory/shared.ts";
import type { NativeProjectImportCatalog } from "./projectImportTypes.ts";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_LINE_BYTES = 8 * 1024 * 1024;
const METADATA_TAIL_BYTES = 256 * 1024;
const MAX_DESKTOP_METADATA_BYTES = 1024 * 1024;
const METADATA_CONCURRENCY = 4;
// The title sanitizer must not process a whole prompt or summary from a large record.
const TITLE_SAMPLE_CHARS = 2_048;

interface ClaudeProjectImportInput {
  readonly configDir?: string;
  readonly desktopSessionsDir?: string;
}

function isoDate(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function absoluteCwd(value: unknown): string | undefined {
  return typeof value === "string" && !value.includes("\0") && path.isAbsolute(value)
    ? path.normalize(value)
    : undefined;
}

async function directoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function sessionFiles(
  configDir: string,
  onSkipped?: () => void,
): Promise<Map<string, string>> {
  const projectsDir = path.join(configDir, "projects");
  const files = new Map<string, string>();
  for (const project of await directoryEntries(projectsDir)) {
    if (!project.isDirectory()) continue;
    const directory = path.join(projectsDir, project.name);
    const entries = await directoryEntries(directory).catch((error: unknown) => {
      if (!onSkipped) throw error;
      onSkipped();
      return [];
    });
    for (const file of entries) {
      // Subagents and tool output live below session directories. Never recurse.
      const id = file.name.slice(0, -6).toLowerCase();
      if (!file.isFile() || !/\.jsonl$/iu.test(file.name) || !SESSION_ID.test(id)) continue;
      const filePath = path.join(directory, file.name);
      const previous = files.get(id);
      if (previous) {
        const [previousStat, currentStat] = await Promise.all([
          stat(previous).catch(() => undefined),
          stat(filePath).catch(() => undefined),
        ]);
        if (!currentStat || (previousStat && previousStat.mtimeMs >= currentStat.mtimeMs)) continue;
      }
      files.set(id, filePath);
    }
  }
  return files;
}

function readTranscriptEntries(file: string) {
  return readJsonlRecords(file, {
    maxLineBytes: MAX_METADATA_LINE_BYTES,
  });
}

async function readTranscriptMetadata(
  file: string,
  size: number,
  desktop: { cwd: string | undefined; title: string | undefined } | undefined,
) {
  let cwd = desktop?.cwd;
  let createdAt: string | undefined;
  let firstPrompt = desktop?.title;
  let customTitle: string | undefined;
  let summary: string | undefined;
  let relocatedCwd: string | undefined;
  let continued = false;
  const collect = (entry: Record<string, unknown>) => {
    if (entry.type === "custom-title")
      customTitle = nonEmptyString(entry.customTitle) ?? customTitle;
    if (entry.type === "summary") summary = nonEmptyString(entry.summary) ?? summary;
    if (entry.type === "relocated") relocatedCwd = absoluteCwd(entry.relocatedCwd) ?? relocatedCwd;
    if (entry.type === "continued-in") continued = true;
  };
  // Keep the oldest prompt/date and newest rename/relocation from bounded slices.
  for await (const entry of readJsonlRecords(file, { maxBytes: MAX_METADATA_BYTES })) {
    if (entry.isSidechain === true) continue;
    collect(entry);
    cwd ??= absoluteCwd(entry.cwd);
    if (typeof entry.timestamp === "string") createdAt ??= isoDate(entry.timestamp);
    if (entry.type === "user" && entry.isMeta !== true) {
      firstPrompt ??= titleFromText(
        visibleMessageText(asRecord(entry.message)?.content).slice(0, TITLE_SAMPLE_CHARS),
      );
    }
    if (cwd && createdAt && firstPrompt) break;
  }
  for await (const entry of readJsonlRecords(file, {
    startByte: Math.max(0, size - METADATA_TAIL_BYTES),
    maxBytes: METADATA_TAIL_BYTES,
    maxLineBytes: METADATA_TAIL_BYTES,
  })) {
    if (entry.isSidechain === true) continue;
    collect(entry);
    cwd ??= absoluteCwd(entry.cwd);
    if (typeof entry.timestamp === "string") createdAt ??= isoDate(entry.timestamp);
  }
  return {
    cwd: relocatedCwd ?? cwd,
    createdAt,
    title:
      titleFromText(customTitle?.slice(0, TITLE_SAMPLE_CHARS)) ??
      titleFromText(summary?.slice(0, TITLE_SAMPLE_CHARS)) ??
      firstPrompt,
    hidden: continued && desktop === undefined,
  };
}

async function readDesktopRow(filePath: string) {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    if (size > MAX_DESKTOP_METADATA_BYTES) return null;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer);
    return asRecord(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
  } finally {
    await file.close();
  }
}

async function desktopSessions(directory: string, onSkipped: () => void) {
  const entries = (dir: string) =>
    directoryEntries(dir).catch(() => {
      onSkipped();
      return [];
    });
  const rows: { localId: string; data: Record<string, unknown>; ids: string[] }[] = [];
  for (const account of await entries(directory)) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(directory, account.name);
    for (const org of await entries(accountDir)) {
      if (!org.isDirectory()) continue;
      const orgDir = path.join(accountDir, org.name);
      const files = (await entries(orgDir)).filter(
        (file) => file.isFile() && /^local_.+\.json$/u.test(file.name),
      );
      const parsed = await mapBounded(files, METADATA_CONCURRENCY, async (file) => {
        const data = await readDesktopRow(path.join(orgDir, file.name)).catch(() => null);
        if (!data) {
          onSkipped();
          return undefined;
        }
        const forkSource = nonEmptyString(data.forkedFromSessionId)?.toLowerCase();
        const ids = [
          data.cliSessionId,
          ...(Array.isArray(data.priorCliSessionIds) ? data.priorCliSessionIds : []),
        ].flatMap((id, index) =>
          typeof id === "string" &&
          SESSION_ID.test(id) &&
          (index === 0 || id.toLowerCase() !== forkSource)
            ? [id.toLowerCase()]
            : [],
        );
        return { data, localId: file.name.slice(6, -5), ids: [...new Set(ids)] };
      });
      for (const row of parsed) if (row) rows.push(row);
    }
  }
  return rows.toSorted((a, b) =>
    (isoTimestamp(b.data.lastActivityAt) ?? "").localeCompare(
      isoTimestamp(a.data.lastActivityAt) ?? "",
    ),
  );
}

function spawnParent(value: unknown): string | undefined {
  const record = asRecord(value);
  return nonEmptyString(
    record?.sessionId ??
      record?.parentSessionId ??
      record?.localSessionId ??
      record?.parentCliSessionId ??
      record?.cliSessionId ??
      record?.id ??
      value,
  )
    ?.replace(/^local_/u, "")
    .toLowerCase();
}

function claudeConfigDir(configDir?: string): string {
  return path.resolve(
    configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"),
  );
}

export async function findClaudeSessionTranscriptPath(input: {
  readonly sessionId: string;
  readonly configDir?: string;
}): Promise<string | undefined> {
  const files = await sessionFiles(claudeConfigDir(input.configDir));
  return files.get(input.sessionId.toLowerCase());
}

/** Read dates from a frozen native copy; the SDK supplies its selected message chain. */
export async function readClaudeImportMessageDates(input: {
  readonly sessionId: string;
  readonly configDir?: string;
}): Promise<ReadonlyMap<string, string>> {
  const dates = new Map<string, string>();
  const files = await sessionFiles(claudeConfigDir(input.configDir));
  const file = files.get(input.sessionId.toLowerCase());
  if (!file) return dates;
  for await (const entry of readTranscriptEntries(file)) {
    if (entry.isSidechain === true || typeof entry.uuid !== "string") continue;
    const timestamp = typeof entry.timestamp === "string" ? isoDate(entry.timestamp) : undefined;
    if (timestamp) dates.set(entry.uuid, timestamp);
  }
  return dates;
}

export async function discoverClaudeProjects(
  input: ClaudeProjectImportInput = {},
): Promise<NativeProjectImportCatalog> {
  const sourceHome = claudeConfigDir(input.configDir);
  let skippedSessions = 0;
  const skipped = () => {
    skippedSessions++;
  };
  const files = await sessionFiles(sourceHome, skipped);
  const byTranscript = new Map<string, Record<string, unknown>>();
  const transcriptIds = new Map<string, string>();
  const priorIds = new Map<string, string[]>();
  if (files.size && input.desktopSessionsDir) {
    for (const { data, localId, ids } of await desktopSessions(input.desktopSessionsDir, skipped)) {
      const id = ids.find((candidate) => transcriptIds.has(candidate) || files.has(candidate));
      if (!id) continue;
      const selected = transcriptIds.get(id) ?? id;
      transcriptIds.set(localId.toLowerCase(), selected);
      for (const alias of ids) {
        if (!transcriptIds.has(alias)) transcriptIds.set(alias, selected);
      }
      if (!byTranscript.has(selected)) byTranscript.set(selected, data);
      priorIds.set(selected, [...new Set([...(priorIds.get(selected) ?? []), ...ids])]);
    }
  }
  const projects = new Map<string, NativeProjectImportCatalog["projects"][number]>();
  const results = await mapBounded([...files], METADATA_CONCURRENCY, async ([id, file]) => {
    if ((transcriptIds.get(id) ?? id) !== id) return undefined;
    try {
      const desktop = byTranscript.get(id);
      const metadataCwd = absoluteCwd(desktop?.cwd);
      const origin = absoluteCwd(desktop?.originCwd);
      const worktree = absoluteCwd(desktop?.worktreePath);
      const metadataTitle = nonEmptyString(desktop?.title);
      const metadataCreatedAt = isoTimestamp(desktop?.createdAt);
      const relative = worktree && metadataCwd ? path.relative(worktree, metadataCwd) : undefined;
      const insideWorktree =
        relative !== undefined &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
      const desktopCwd = insideWorktree ? metadataCwd : (worktree ?? metadataCwd);
      const info = await stat(file);
      const fallback =
        (desktopCwd || origin) && metadataTitle && metadataCreatedAt
          ? undefined
          : await readTranscriptMetadata(
              file,
              info.size,
              desktop ? { cwd: desktopCwd ?? origin, title: metadataTitle } : undefined,
            );
      if (fallback?.hidden) return undefined;
      const cwd = desktopCwd ?? fallback?.cwd ?? origin;
      if (!cwd) {
        skipped();
        return undefined;
      }
      const projectRoot = origin ?? (worktree && !insideWorktree ? metadataCwd : undefined);
      const root = projectRoot ?? cwd;
      const updatedAt = isoTimestamp(desktop?.lastActivityAt) ?? info.mtime.toISOString();
      const parent = spawnParent(desktop?.spawnedFrom);
      const parentSessionId = parent ? (transcriptIds.get(parent) ?? parent) : undefined;
      const aliases = priorIds.get(id)?.filter((alias) => alias !== id);
      projects.set(root, { id: root, title: path.basename(root) || root, roots: [root] });
      return {
        id,
        title: metadataTitle ?? fallback?.title ?? (path.basename(root) || root),
        cwd,
        projectId: root,
        ...(projectRoot ? { projectRoot } : {}),
        ...(parentSessionId && parentSessionId !== id ? { parentSessionId } : {}),
        ...(aliases?.length ? { priorSessionIds: aliases } : {}),
        createdAt: metadataCreatedAt ?? fallback?.createdAt ?? updatedAt,
        updatedAt,
        archived: desktop?.isArchived === true,
      };
    } catch {
      skipped();
      return undefined;
    }
  });
  const sessions = results.filter((row) => row !== undefined);
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return {
    sourceHome,
    projects: [...projects.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    sessions,
    ...(skippedSessions ? { skippedSessions } : {}),
  };
}
