import { createHash } from "node:crypto";
import { CodexRolloutHistory } from "./codexRollout";
import type { CodexReplaySourceTurn } from "../orchestration/codexReplay";
// FILE: chats.ts
// Purpose: Read last-30-day chats from supported public local files.
// Layer: Server import helper

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as nodePath from "node:path";
import readline from "node:readline";

import {
  normalizeWorkspaceImportSource,
  type WorkspaceImportCanonicalSourceKind,
  type WorkspaceImportSourceKind,
} from "@synara/contracts";
import { parse as parseToml } from "smol-toml";
import {
  chatRootsForSource,
  decodeClaudeProjectFolderName,
  resolveClaudeProjectsRoot,
  settingsPathsForSource,
} from "./paths";
import { readRegularFileNoFollow } from "./safeFile";
import { isWithinWorkspaceImportWindow, parseImportTimestamp } from "./window";

const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_FILES_PER_SOURCE = 500;
const MAX_CHAT_BYTES_PER_SOURCE = 64 * 1024 * 1024;
// Codex stores append-only JSONL sessions that can contain tool output and
// reasoning records well beyond the small transcript files used by the other
// providers. Keep a bounded source budget, but do not reject a valid session
// merely because it crossed the generic 8 MiB file limit.
const MAX_CODEX_CHAT_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CODEX_CHAT_FILES_PER_SOURCE = 1_000;
const MAX_CODEX_CHAT_BYTES_PER_SOURCE = 16 * 1024 * 1024 * 1024;
const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CLAUDE_PROJECTS = 500;
const MAX_IMPORTED_MESSAGES = 2_000;
const MAX_IMPORTED_MESSAGE_CHARS = 64_000;
const MAX_IMPORTED_CHAT_CHARS = 4 * 1024 * 1024;
const CHAT_SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/giu,
  /sk-ant-[A-Za-z0-9_-]{16,}/giu,
  /xai-[A-Za-z0-9_-]{16,}/giu,
  /gh[pousr]_[A-Za-z0-9_-]{16,}/giu,
  /github_pat_[A-Za-z0-9_-]{16,}/giu,
  /Bearer\s+[A-Za-z0-9._-]{16,}/giu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
];
const CHAT_SECRET_ASSIGNMENT_PATTERN =
  /((["']?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|jwt|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token|token)["']?\s*[:=]\s*["']?))([^\s"',}]+)/giu;

export interface CollectedImportMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface CollectedImportChat {
  readonly codexHistory?: ReadonlyArray<CodexReplaySourceTurn>;
  readonly replayFingerprint?: string;
  readonly nativeThreadId?: string;
  readonly nativeParentThreadId?: string;
  readonly nativeAgentPath?: string;
  readonly nativeAgentNickname?: string;
  readonly source: WorkspaceImportSourceKind;
  readonly sourceId: string;
  readonly title: string;
  readonly workingDirectory: string;
  readonly updatedAt: string;
  readonly messages: readonly CollectedImportMessage[];
  readonly connectors: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateTranscriptText(value: string): string {
  const trimmed = value.trim();
  const bounded =
    trimmed.length > MAX_IMPORTED_MESSAGE_CHARS
      ? `${trimmed.slice(0, MAX_IMPORTED_MESSAGE_CHARS - 1)}…`
      : trimmed;
  return redactTranscriptSecrets(bounded);
}

function redactTranscriptSecrets(value: string): string {
  let redacted = value;
  for (const pattern of CHAT_SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  redacted = redacted.replace(CHAT_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]");
  return redacted;
}

function readTranscriptText(value: unknown): string {
  if (typeof value === "string") {
    return truncateTranscriptText(value);
  }
  if (Array.isArray(value)) {
    return truncateTranscriptText(value.map(readTranscriptText).filter(Boolean).join("\n\n"));
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return truncateTranscriptText(record.text);
  }
  if (typeof record.content === "string") {
    return truncateTranscriptText(record.content);
  }
  if (Array.isArray(record.content)) {
    return truncateTranscriptText(
      record.content.map(readTranscriptText).filter(Boolean).join("\n\n"),
    );
  }
  if (Array.isArray(record.parts)) {
    return truncateTranscriptText(
      record.parts.map(readTranscriptText).filter(Boolean).join("\n\n"),
    );
  }
  return "";
}

function uniqueConnectors(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const connectors: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    connectors.push(trimmed);
  }
  return connectors;
}

function collectConnectorsFromUnknown(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    const match = /(?:mcp|connector)[:/_-]?([A-Za-z0-9._-]+)/i.exec(value);
    if (match?.[1]) {
      into.push(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectConnectorsFromUnknown(item, into);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["connector", "connectorName", "mcpServer", "serverName", "name"] as const) {
    const named = readString(record[key]);
    if (
      named &&
      (key !== "name" || "connector" in record || "mcp" in record || "mcpServer" in record)
    ) {
      into.push(named);
    }
  }
  if (Array.isArray(record.connectors)) {
    for (const item of record.connectors) {
      const named = readString(item);
      if (named) {
        into.push(named);
      } else {
        collectConnectorsFromUnknown(item, into);
      }
    }
  }
  if (record.mcpServers && typeof record.mcpServers === "object") {
    into.push(...Object.keys(record.mcpServers as Record<string, unknown>));
  }
}

function fallbackTitle(source: WorkspaceImportSourceKind, sourceId: string): string {
  const label =
    source === "claude" || source === "claude-code"
      ? "Claude Code"
      : source === "cursor"
        ? "Cursor"
        : source === "codex"
          ? "Codex"
          : source === "grok"
            ? "Grok"
            : "OpenCode";
  return `${label} chat ${sourceId.slice(0, 8)}`;
}

function titleFromMessages(messages: readonly CollectedImportMessage[]): string | null {
  const firstUser = messages.find((message) => message.role === "user" && message.text.length > 0);
  if (!firstUser) {
    return null;
  }
  const firstLine = firstUser.text
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (!firstLine) {
    return null;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function capImportedMessages(
  messages: readonly CollectedImportMessage[],
): CollectedImportMessage[] {
  const capped: CollectedImportMessage[] = [];
  let total = 0;
  for (const message of messages) {
    if (total >= MAX_IMPORTED_CHAT_CHARS) break;
    const remaining = MAX_IMPORTED_CHAT_CHARS - total;
    const text =
      message.text.length > remaining
        ? `${message.text.slice(0, Math.max(0, remaining - 1))}…`
        : message.text;
    if (!text) break;
    capped.push(text === message.text ? message : { ...message, text });
    total += text.length;
  }
  return capped;
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = (await readRegularFileNoFollow(path, MAX_SETTINGS_FILE_BYTES)).toString("utf8");
  return JSON.parse(raw) as unknown;
}

async function readBoundedChatFile(
  filePath: string,
): Promise<{ readonly contents: string; readonly stat: import("node:fs").Stats }> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CHAT_FILE_BYTES) {
    throw new Error("Chat source is not a regular bounded file.");
  }
  const contents = (await readRegularFileNoFollow(filePath, MAX_CHAT_FILE_BYTES)).toString("utf8");
  return { contents, stat };
}

function sameFileIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function pathIsInside(candidate: string, root: string): boolean {
  const resolvedCandidate = nodePath.resolve(candidate);
  const resolvedRoot = nodePath.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${nodePath.sep}`)
  );
}

/**
 * Transcript metadata is untrusted input. Keep imported workspaces within the
 * user's home or the current Moss workspace; anything else falls back to the
 * current workspace instead of silently creating a project under a system
 * directory. The exact fallback path is retained even when it has not been
 * created yet (which is useful for clean-room fixtures and new projects).
 */
async function safeImportedWorkingDirectory(input: {
  readonly candidate: string;
  readonly homeDir: string;
  readonly fallbackCwd: string;
}): Promise<string> {
  const fallback = nodePath.resolve(input.fallbackCwd);
  const candidate = input.candidate.trim();
  if (!candidate || candidate.includes("\0") || !nodePath.isAbsolute(candidate)) {
    return fallback;
  }
  const resolved = nodePath.resolve(candidate);
  const allowedLexically =
    pathIsInside(resolved, input.homeDir) || pathIsInside(resolved, fallback);
  if (!allowedLexically) return fallback;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return fallback;
    const real = await fs.realpath(resolved);
    const homeReal = await fs.realpath(input.homeDir).catch(() => nodePath.resolve(input.homeDir));
    const fallbackReal = await fs.realpath(fallback).catch(() => nodePath.resolve(fallback));
    return pathIsInside(real, homeReal) || pathIsInside(real, fallbackReal) ? real : fallback;
  } catch {
    // A source may reference a project that has not been created locally yet.
    // Keep only the exact configured fallback in that case.
    return resolved === fallback ? fallback : fallback;
  }
}

async function normalizeImportedChatWorkspace(
  chat: CollectedImportChat,
  input: { readonly homeDir: string; readonly fallbackCwd: string },
): Promise<CollectedImportChat> {
  const workingDirectory = await safeImportedWorkingDirectory({
    candidate: chat.workingDirectory,
    homeDir: input.homeDir,
    fallbackCwd: input.fallbackCwd,
  });
  return workingDirectory === chat.workingDirectory ? chat : { ...chat, workingDirectory };
}

export async function readFirstExistingJson(paths: readonly string[]): Promise<unknown> {
  for (const path of paths) {
    try {
      return await readJsonFile(path);
    } catch {
      // Try the next documented location.
    }
  }
  return null;
}

function parseGenericChatRecord(
  value: unknown,
  input: {
    readonly source: WorkspaceImportSourceKind;
    readonly sourceId: string;
    readonly fallbackCwd: string;
    readonly fallbackUpdatedAt: string;
  },
): CollectedImportChat | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const messagesRaw = Array.isArray(record.messages) ? record.messages : [];
  const messages: CollectedImportMessage[] = [];
  for (const item of messagesRaw.slice(0, MAX_IMPORTED_MESSAGES)) {
    const message = asRecord(item);
    if (!message) {
      continue;
    }
    const role = message.role === "user" || message.role === "assistant" ? message.role : null;
    const text = readTranscriptText(message);
    if (!role || text.length === 0) {
      continue;
    }
    messages.push({
      role,
      text,
      createdAt:
        parseImportTimestamp(message.createdAt ?? message.timestamp)?.toISOString() ??
        input.fallbackUpdatedAt,
    });
  }
  // A title/cwd-only metadata record is a project descriptor, not a chat.
  // Require at least one user/assistant message so settings/index JSON cannot
  // create empty Moss threads.
  const cappedMessages = capImportedMessages(messages);
  if (cappedMessages.length === 0) return null;
  const connectors: string[] = [];
  collectConnectorsFromUnknown(record, connectors);
  for (const message of messagesRaw) {
    collectConnectorsFromUnknown(message, connectors);
  }
  const workingDirectory =
    readString(record.cwd) ??
    readString(record.workingDirectory) ??
    readString(record.workspace) ??
    input.fallbackCwd;
  const title =
    readString(record.title) ??
    titleFromMessages(cappedMessages) ??
    fallbackTitle(input.source, input.sourceId);
  const updatedAt =
    parseImportTimestamp(record.updatedAt ?? record.timestamp)?.toISOString() ??
    input.fallbackUpdatedAt;
  return {
    source: input.source,
    sourceId:
      readString(record.id) && input.sourceId.includes(":")
        ? `${input.sourceId}:${readString(record.id)}`
        : (readString(record.id) ?? input.sourceId),
    title,
    workingDirectory,
    updatedAt,
    messages: cappedMessages,
    connectors: uniqueConnectors(connectors),
  };
}

function parseClaudeJsonl(input: {
  readonly contents: string;
  readonly sourceId: string;
  readonly fallbackCwd: string;
  readonly fallbackUpdatedAt: string;
}): CollectedImportChat | null {
  const messages: CollectedImportMessage[] = [];
  const connectors: string[] = [];
  let title: string | null = null;
  let cwd = input.fallbackCwd;
  let updatedAt = input.fallbackUpdatedAt;

  for (const line of input.contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) {
      continue;
    }
    collectConnectorsFromUnknown(record, connectors);
    const lineCwd = readString(record.cwd);
    if (lineCwd) {
      cwd = lineCwd;
    }
    const timestamp = parseImportTimestamp(record.timestamp ?? record.createdAt);
    if (timestamp) {
      updatedAt = timestamp.toISOString();
    }
    if (record.type === "summary") {
      title = readString(record.summary) ?? title;
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") {
      continue;
    }
    const text = readTranscriptText(record.message ?? record);
    if (text.length === 0) {
      continue;
    }
    if (messages.length < MAX_IMPORTED_MESSAGES) {
      messages.push({
        role: record.type,
        text,
        createdAt: timestamp?.toISOString() ?? updatedAt,
      });
    }
  }

  const cappedMessages = capImportedMessages(messages);
  if (cappedMessages.length === 0) return null;
  return {
    source: "claude",
    sourceId: input.sourceId,
    title: title ?? titleFromMessages(cappedMessages) ?? fallbackTitle("claude", input.sourceId),
    workingDirectory: cwd,
    updatedAt,
    messages: cappedMessages,
    connectors: uniqueConnectors(connectors),
  };
}

async function collectClaudeChats(input: {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly fallbackCwd: string;
}): Promise<{ chats: CollectedImportChat[]; olderChatCount: number }> {
  const chats: CollectedImportChat[] = [];
  let olderChatCount = 0;
  const projectsRoot = resolveClaudeProjectsRoot(input);
  try {
    const rootStat = await fs.lstat(projectsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { chats, olderChatCount };
    }
  } catch {
    return { chats, olderChatCount };
  }
  let projectEntries: import("node:fs").Dirent[];
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return { chats, olderChatCount };
  }
  projectEntries.sort((left, right) => left.name.localeCompare(right.name));
  let filesRead = 0;
  let bytesRead = 0;
  let projectsRead = 0;

  for (const projectEntry of projectEntries) {
    if (projectsRead >= MAX_CLAUDE_PROJECTS || !projectEntry.isDirectory()) {
      continue;
    }
    projectsRead += 1;
    const projectDir = nodePath.join(projectsRoot, projectEntry.name);
    const fallbackCwd = decodeClaudeProjectFolderName(projectEntry.name) ?? input.fallbackCwd;
    let transcriptEntries: import("node:fs").Dirent[];
    try {
      transcriptEntries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    transcriptEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const transcriptEntry of transcriptEntries) {
      if (
        filesRead >= MAX_CHAT_FILES_PER_SOURCE ||
        bytesRead >= MAX_CHAT_BYTES_PER_SOURCE ||
        !transcriptEntry.isFile() ||
        !transcriptEntry.name.endsWith(".jsonl")
      ) {
        continue;
      }
      const transcriptPath = nodePath.join(projectDir, transcriptEntry.name);
      let stat: import("node:fs").Stats;
      let contents: string;
      try {
        ({ contents, stat } = await readBoundedChatFile(transcriptPath));
        if (bytesRead + stat.size > MAX_CHAT_BYTES_PER_SOURCE) continue;
        filesRead += 1;
        bytesRead += stat.size;
      } catch {
        continue;
      }
      // The basename alone collides when two Claude project folders contain
      // `session.jsonl`. Include the stable project-folder component so the
      // ledger can update the correct Moss thread on re-import.
      const sourceId = `${projectEntry.name}/${transcriptEntry.name.replace(/\.jsonl$/u, "")}`;
      const chat = parseClaudeJsonl({
        contents,
        sourceId,
        fallbackCwd,
        fallbackUpdatedAt: stat.mtime.toISOString(),
      });
      if (!chat) {
        continue;
      }
      const timestamp = parseImportTimestamp(chat.updatedAt) ?? stat.mtime;
      if (!isWithinWorkspaceImportWindow({ now: input.now, timestamp })) {
        olderChatCount += 1;
        continue;
      }
      chats.push(
        await normalizeImportedChatWorkspace(chat, {
          homeDir: input.homeDir,
          fallbackCwd: input.fallbackCwd,
        }),
      );
    }
  }

  return { chats, olderChatCount };
}

async function walkCursorChatFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return files;
  } catch {
    return files;
  }
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 6 || files.length >= 500) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const next = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "workspaceStorage" ||
          entry.name === "CachedData" ||
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "cache" ||
          entry.name === "Cache"
        ) {
          continue;
        }
        await visit(next, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) {
        files.push(next);
      }
    }
  };
  await visit(root, 0);
  return files;
}

function parseCursorJsonl(input: {
  readonly contents: string;
  readonly sourceId: string;
  readonly fallbackCwd: string;
  readonly fallbackUpdatedAt: string;
}): CollectedImportChat | null {
  const messages: CollectedImportMessage[] = [];
  const connectors: string[] = [];
  let title: string | null = null;
  let cwd = input.fallbackCwd;
  let updatedAt = input.fallbackUpdatedAt;
  for (const line of input.contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) {
      continue;
    }
    collectConnectorsFromUnknown(record, connectors);
    title = readString(record.title) ?? title;
    cwd = readString(record.cwd) ?? readString(record.workingDirectory) ?? cwd;
    const timestamp = parseImportTimestamp(
      record.updatedAt ?? record.timestamp ?? record.createdAt,
    );
    if (timestamp) {
      updatedAt = timestamp.toISOString();
    }
    const role = record.role === "user" || record.role === "assistant" ? record.role : null;
    const text = readTranscriptText(record);
    if (!role || text.length === 0) {
      continue;
    }
    if (messages.length < MAX_IMPORTED_MESSAGES) {
      messages.push({
        role,
        text,
        createdAt: timestamp?.toISOString() ?? updatedAt,
      });
    }
  }
  const cappedMessages = capImportedMessages(messages);
  if (cappedMessages.length === 0) return null;
  return {
    source: "cursor",
    sourceId: input.sourceId,
    title: title ?? titleFromMessages(cappedMessages) ?? fallbackTitle("cursor", input.sourceId),
    workingDirectory: cwd,
    updatedAt,
    messages: cappedMessages,
    connectors: uniqueConnectors(connectors),
  };
}

async function collectCursorChats(input: {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly fallbackCwd: string;
}): Promise<{ chats: CollectedImportChat[]; olderChatCount: number }> {
  const chats: CollectedImportChat[] = [];
  let olderChatCount = 0;
  const seenFiles = new Set<string>();
  const seenSourceIds = new Set<string>();
  const seenChatSourceIds = new Set<string>();
  let bytesRead = 0;
  for (const root of chatRootsForSource("cursor", input)) {
    for (const filePath of await walkCursorChatFiles(root)) {
      if (bytesRead >= MAX_CHAT_BYTES_PER_SOURCE) break;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      let stat: import("node:fs").Stats;
      let contents: string;
      try {
        ({ contents, stat } = await readBoundedChatFile(filePath));
        if (bytesRead + stat.size > MAX_CHAT_BYTES_PER_SOURCE) continue;
        bytesRead += stat.size;
      } catch {
        continue;
      }
      const baseSourceId = nodePath.basename(filePath).replace(/\.(json|jsonl)$/u, "");
      const relativePath = nodePath.relative(input.homeDir, filePath).replaceAll(nodePath.sep, "/");
      const sourceId = seenSourceIds.has(baseSourceId)
        ? `${baseSourceId}:${relativePath || filePath}`
        : baseSourceId;
      seenSourceIds.add(sourceId);
      let chat = filePath.endsWith(".jsonl")
        ? parseCursorJsonl({
            contents,
            sourceId,
            fallbackCwd: input.fallbackCwd,
            fallbackUpdatedAt: stat.mtime.toISOString(),
          })
        : (() => {
            try {
              return parseGenericChatRecord(JSON.parse(contents) as unknown, {
                source: "cursor",
                sourceId,
                fallbackCwd: input.fallbackCwd,
                fallbackUpdatedAt: stat.mtime.toISOString(),
              });
            } catch {
              return null;
            }
          })();
      if (!chat) {
        continue;
      }
      // Cursor's JSON records often carry a short `id` that is not globally
      // unique. Preserve the historical bare id for the first occurrence,
      // then namespace collisions with the stable relative file path.
      if (seenChatSourceIds.has(chat.sourceId)) {
        const prefix = chat.sourceId;
        let candidate = `${prefix}:${relativePath || filePath}`;
        let suffix = 2;
        while (seenChatSourceIds.has(candidate)) {
          candidate = `${prefix}:${relativePath || filePath}:${suffix}`;
          suffix += 1;
        }
        chat = { ...chat, sourceId: candidate };
      }
      seenChatSourceIds.add(chat.sourceId);
      const timestamp = parseImportTimestamp(chat.updatedAt) ?? stat.mtime;
      if (!isWithinWorkspaceImportWindow({ now: input.now, timestamp })) {
        olderChatCount += 1;
        continue;
      }
      chats.push(
        await normalizeImportedChatWorkspace(chat, {
          homeDir: input.homeDir,
          fallbackCwd: input.fallbackCwd,
        }),
      );
    }
  }
  return { chats, olderChatCount };
}

/**
 * Generic JSON/JSONL reader used by providers whose on-disk format changes
 * more frequently than Claude's documented JSONL format.  We only accept
 * user/assistant text and metadata; arbitrary commands, hooks and credentials
 * are never executed or copied into a thread.
 */
async function collectGenericProviderChats(input: {
  readonly source: WorkspaceImportCanonicalSourceKind;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly fallbackCwd: string;
}): Promise<{ chats: CollectedImportChat[]; olderChatCount: number }> {
  const chats: CollectedImportChat[] = [];
  let olderChatCount = 0;
  const seenFiles = new Set<string>();
  let bytesRead = 0;
  for (const root of chatRootsForSource(input.source, input)) {
    for (const filePath of await walkCursorChatFiles(root)) {
      if (bytesRead >= MAX_CHAT_BYTES_PER_SOURCE) break;
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      let stat: import("node:fs").Stats;
      let contents: string;
      try {
        ({ contents, stat } = await readBoundedChatFile(filePath));
        if (bytesRead + stat.size > MAX_CHAT_BYTES_PER_SOURCE) continue;
        bytesRead += stat.size;
      } catch {
        continue;
      }
      const relativePath = nodePath.relative(input.homeDir, filePath).replaceAll(nodePath.sep, "/");
      const sourceId = `${input.source}:${relativePath || nodePath.basename(filePath)}`;
      const fallbackUpdatedAt = stat.mtime.toISOString();
      const parsed = filePath.endsWith(".jsonl")
        ? parseGenericJsonl({
            contents,
            source: input.source,
            sourceId,
            fallbackCwd: input.fallbackCwd,
            fallbackUpdatedAt,
          })
        : (() => {
            try {
              return parseGenericChatRecord(JSON.parse(contents) as unknown, {
                source: input.source,
                sourceId,
                fallbackCwd: input.fallbackCwd,
                fallbackUpdatedAt,
              });
            } catch {
              return null;
            }
          })();
      if (!parsed) continue;
      const timestamp = parseImportTimestamp(parsed.updatedAt) ?? stat.mtime;
      if (!isWithinWorkspaceImportWindow({ now: input.now, timestamp })) {
        olderChatCount += 1;
        continue;
      }
      chats.push(
        await normalizeImportedChatWorkspace(parsed, {
          homeDir: input.homeDir,
          fallbackCwd: input.fallbackCwd,
        }),
      );
    }
  }
  return { chats, olderChatCount };
}

function parseCodexMessageRecord(
  record: Record<string, unknown>,
  fallbackTimestamp: string,
): { role: "user" | "assistant"; text: string; createdAt: string } | null {
  const payload = asRecord(record.payload);
  const recordType = readString(record.type);
  const payloadType = readString(payload?.type);
  let role: "user" | "assistant" | null = null;
  let rawText: unknown = null;
  if (recordType === "event_msg" && payloadType === "user_message") {
    role = "user";
    rawText = payload?.message ?? payload?.content;
  } else if (recordType === "event_msg" && payloadType === "agent_message") {
    role = "assistant";
    rawText = payload?.message ?? payload?.content;
  } else if (recordType === "response_item" && payloadType === "message") {
    role = payload?.role === "user" || payload?.role === "assistant" ? payload.role : null;
    rawText = payload?.content ?? payload?.message;
  }
  if (!role) return null;
  const text = readTranscriptText(rawText);
  if (!text) return null;
  const timestamp =
    parseImportTimestamp(record.timestamp) ??
    parseImportTimestamp(payload?.timestamp) ??
    parseImportTimestamp(payload?.createdAt);
  return { role, text, createdAt: timestamp?.toISOString() ?? fallbackTimestamp };
}

interface CodexChatFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Codex session roots can contain hundreds of large append-only JSONL files.
 * Gather file metadata first, then process newest sessions before older ones;
 * the generic provider walker is intentionally not reused because its 500-file
 * and 64 MiB limits are appropriate for small provider exports, not Codex.
 */
async function walkCodexChatFiles(root: string): Promise<CodexChatFile[]> {
  const files: CodexChatFile[] = [];
  const seen = new Set<string>();
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return files;
  } catch {
    return files;
  }
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length >= 10_000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= 10_000 || entry.name.startsWith(".")) continue;
      const next = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "Cache" ||
          entry.name === "CachedData" ||
          entry.name === "cache" ||
          entry.name === "node_modules" ||
          entry.name === ".git"
        ) {
          continue;
        }
        await visit(next, depth + 1);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json"))) {
        continue;
      }
      const resolved = nodePath.resolve(next);
      if (seen.has(resolved)) continue;
      try {
        const stat = await fs.lstat(next);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        seen.add(resolved);
        files.push({ path: next, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A concurrently removed or unreadable file is simply not importable.
      }
    }
  };
  await visit(root, 0);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return files.slice(0, MAX_CODEX_CHAT_FILES_PER_SOURCE);
}

async function readFilePrefixNoFollow(
  filePath: string,
  maxBytes: number,
): Promise<{ readonly prefix: string }> {
  const pathStat = await fs.lstat(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error("Import source is not a regular file.");
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(pathStat, before)) {
      throw new Error("Import source changed while it was opened.");
    }
    const length = Math.min(maxBytes, before.size);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) {
      throw new Error("Import source changed while it was being read.");
    }
    return { prefix: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readFileSuffixNoFollow(
  filePath: string,
  maxBytes: number,
): Promise<{ readonly suffix: string }> {
  const pathStat = await fs.lstat(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error("Import source is not a regular file.");
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(pathStat, before)) {
      throw new Error("Import source changed while it was opened.");
    }
    const length = Math.min(maxBytes, before.size);
    const start = before.size - length;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) {
      throw new Error("Import source changed while it was being read.");
    }
    return { suffix: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function codexRecordHasMessage(record: Record<string, unknown>): boolean {
  if (parseCodexMessageRecord(record, new Date(0).toISOString())) return true;
  const role = record.role === "user" || record.role === "assistant" ? record.role : null;
  return role !== null && readTranscriptText(record.message ?? record).length > 0;
}

/**
 * Probe Codex without parsing gigabytes of tool output. Session metadata and
 * the first user/assistant records are emitted at the beginning of Codex JSONL
 * files, so a bounded prefix is enough to count recent importable sessions
 * while the full stream is reserved for an explicit Apply.
 */
export async function inspectCodexChatInventory(input: {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
}): Promise<{ readonly chatCount: number; readonly olderChatCount: number }> {
  const filesByPath = new Map<string, CodexChatFile>();
  for (const root of chatRootsForSource("codex", input)) {
    for (const file of await walkCodexChatFiles(root)) filesByPath.set(file.path, file);
  }
  let chatCount = 0;
  let olderChatCount = 0;
  for (const file of filesByPath.values()) {
    try {
      const probeWindowBytes = 8 * 1024 * 1024;
      const { prefix } = await readFilePrefixNoFollow(file.path, probeWindowBytes);
      // Large Codex sessions can put a tool/output record before the first
      // user message. Scan the tail window too so probe counts the same
      // importable session that Apply will discover without reading a 2 GiB
      // append-only file in full.
      const windows =
        file.size > probeWindowBytes
          ? [prefix, (await readFileSuffixNoFollow(file.path, probeWindowBytes)).suffix]
          : [prefix];
      let latestTimestamp: Date | null = null;
      let hasMessage = false;
      for (const line of windows.flatMap((window) => window.split(/\r?\n/u))) {
        if (
          !line.includes('"response_item"') &&
          !line.includes('"event_msg"') &&
          !line.includes('"session_meta"') &&
          !line.includes('"role"')
        ) {
          continue;
        }
        try {
          const record = asRecord(JSON.parse(line) as unknown);
          if (!record) continue;
          const payload = record.type === "session_meta" ? asRecord(record.payload) : null;
          const timestamp =
            parseImportTimestamp(record.timestamp ?? record.updatedAt ?? record.createdAt) ??
            parseImportTimestamp(payload?.timestamp ?? payload?.createdAt);
          if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
            latestTimestamp = timestamp;
          }
          if (codexRecordHasMessage(record)) hasMessage = true;
        } catch {
          // Ignore malformed or truncated prefix lines; Apply does the full
          // resilient parse when the user confirms the import.
        }
      }
      if (!hasMessage) continue;
      const timestamp = latestTimestamp ?? new Date(file.mtimeMs);
      if (!isWithinWorkspaceImportWindow({ now: input.now, timestamp })) {
        olderChatCount += 1;
        continue;
      }
      chatCount += 1;
    } catch {
      // A file that cannot be safely opened is not an import candidate.
    }
  }
  return { chatCount, olderChatCount };
}

function collectCodexConnectors(record: Record<string, unknown>, into: string[]): void {
  // Avoid recursively walking large tool-output payloads. Connector metadata is
  // emitted in these small, documented fields by Codex session records.
  for (const key of [
    "connector",
    "connectorName",
    "connectors",
    "mcpServer",
    "mcpServers",
    "serverName",
  ] as const) {
    if (key in record) collectConnectorsFromUnknown(record[key], into);
    const payload = asRecord(record.payload);
    if (payload && key in payload) collectConnectorsFromUnknown(payload[key], into);
  }
}

async function parseCodexJsonlFile(input: {
  readonly filePath: string;
  readonly sourceId: string;
  readonly fallbackCwd: string;
  readonly fallbackUpdatedAt: string;
}): Promise<CollectedImportChat | null> {
  const pathStat = await fs.lstat(input.filePath);
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.size > MAX_CODEX_CHAT_FILE_BYTES
  ) {
    throw new Error("Codex chat source is not a regular bounded file.");
  }
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(input.filePath, fsConstants.O_RDONLY | noFollow);
  let stream: ReturnType<import("node:fs/promises").FileHandle["createReadStream"]> | null = null;
  let lines: readline.Interface | null = null;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > MAX_CODEX_CHAT_FILE_BYTES ||
      !sameFileIdentity(pathStat, before)
    ) {
      throw new Error("Codex chat source changed while it was opened.");
    }
    stream = handle.createReadStream({
      encoding: "utf8",
      highWaterMark: 64 * 1024,
      autoClose: false,
    });
    lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const messages: CollectedImportMessage[] = [];
    const connectors: string[] = [];
    const seenMessages = new Set<string>();
    const history = new CodexRolloutHistory(redactTranscriptSecrets);
    let title: string | null = null;
    let cwd = input.fallbackCwd;
    let latestTimestamp: Date | null = null;

    for await (const line of lines) {
      // Never materialize an unusually large JSON line. Codex message text is
      // bounded below; giant tool payloads are not useful to Moss threads.
      if (Buffer.byteLength(line, "utf8") > 16 * 1024 * 1024) continue;
      if (
        !line.includes('"response_item"') &&
        !line.includes('"event_msg"') &&
        !line.includes('"session_meta"') &&
        !line.includes('"role"')
      ) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const record = asRecord(parsed);
      if (!record) continue;
      history.add(
        record,
        typeof record.timestamp === "string" ? record.timestamp : input.fallbackUpdatedAt,
      );
      collectCodexConnectors(record, connectors);
      const payload = record.type === "session_meta" ? asRecord(record.payload) : null;
      if (payload) {
        cwd = readString(payload.cwd ?? payload.workingDirectory) ?? cwd;
        title = readString(payload.title ?? payload.name) ?? title;
      }
      const timestamp =
        parseImportTimestamp(record.timestamp ?? record.updatedAt ?? record.createdAt) ??
        parseImportTimestamp(payload?.timestamp ?? payload?.createdAt);
      if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
        latestTimestamp = timestamp;
      }
      let message = parseCodexMessageRecord(
        record,
        timestamp?.toISOString() ?? input.fallbackUpdatedAt,
      );
      // Clean-room fixtures and a few older Codex exports use the generic
      // `{role, text}` envelope instead of `event_msg`/`response_item`.
      if (!message) {
        const role = record.role === "user" || record.role === "assistant" ? record.role : null;
        const text = readTranscriptText(record.message ?? record);
        if (role && text) {
          message = {
            role,
            text,
            createdAt: timestamp?.toISOString() ?? input.fallbackUpdatedAt,
          };
        }
      }
      if (!message || messages.length >= MAX_IMPORTED_MESSAGES) continue;
      const key = `${message.role}:${message.createdAt}:${message.text}`;
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      messages.push(message);
    }
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) {
      throw new Error("Codex chat source changed while it was being read.");
    }
    const codexHistory = history.snapshot();
    const canonicalMessages = codexHistory?.flatMap((turn) =>
      turn.items.flatMap((value) => {
        const item = asRecord(value);
        if (item?.type !== "userMessage" && item?.type !== "agentMessage") return [];
        const text =
          item.type === "agentMessage" ? readString(item.text) : readTranscriptText(item.content);
        if (!text) return [];
        const id = typeof item.id === "string" ? item.id : "";
        return [
          {
            role: item.type === "userMessage" ? ("user" as const) : ("assistant" as const),
            text,
            createdAt: turn.itemTimes?.[id]?.createdAt ?? input.fallbackUpdatedAt,
          },
        ];
      }),
    );
    const cappedMessages = capImportedMessages(canonicalMessages ?? messages);
    if (cappedMessages.length === 0) return null;
    const updatedAt = latestTimestamp?.toISOString() ?? input.fallbackUpdatedAt;
    return {
      source: "codex",
      sourceId: input.sourceId,
      ...(codexHistory
        ? {
            codexHistory,
            replayFingerprint: createHash("sha256")
              .update(JSON.stringify(codexHistory))
              .digest("hex"),
          }
        : {}),
      ...(history.threadId ? { nativeThreadId: history.threadId } : {}),
      ...(history.parentThreadId ? { nativeParentThreadId: history.parentThreadId } : {}),
      ...(history.agentPath ? { nativeAgentPath: history.agentPath } : {}),
      ...(history.agentNickname ? { nativeAgentNickname: history.agentNickname } : {}),
      title: title ?? titleFromMessages(cappedMessages) ?? fallbackTitle("codex", input.sourceId),
      workingDirectory: cwd,
      updatedAt,
      messages: cappedMessages,
      connectors: uniqueConnectors(connectors),
    };
  } finally {
    lines?.close();
    stream?.destroy();
    await handle.close().catch(() => undefined);
  }
}

async function collectCodexChats(input: {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly fallbackCwd: string;
}): Promise<{ chats: CollectedImportChat[]; olderChatCount: number }> {
  const chats: CollectedImportChat[] = [];
  let olderChatCount = 0;
  const seenFiles = new Set<string>();
  let bytesRead = 0;
  for (const root of chatRootsForSource("codex", input)) {
    for (const file of await walkCodexChatFiles(root)) {
      if (seenFiles.has(file.path) || bytesRead + file.size > MAX_CODEX_CHAT_BYTES_PER_SOURCE) {
        continue;
      }
      seenFiles.add(file.path);
      bytesRead += file.size;
      const relativePath = nodePath
        .relative(input.homeDir, file.path)
        .replaceAll(nodePath.sep, "/");
      const sourceId = `codex:${relativePath || nodePath.basename(file.path)}`;
      let chat: CollectedImportChat | null;
      try {
        chat = await parseCodexJsonlFile({
          filePath: file.path,
          sourceId,
          fallbackCwd: input.fallbackCwd,
          fallbackUpdatedAt: new Date(file.mtimeMs).toISOString(),
        });
      } catch {
        continue;
      }
      if (!chat) continue;
      const timestamp = parseImportTimestamp(chat.updatedAt) ?? new Date(file.mtimeMs);
      if (!isWithinWorkspaceImportWindow({ now: input.now, timestamp })) {
        olderChatCount += 1;
        continue;
      }
      chats.push(
        await normalizeImportedChatWorkspace(chat, {
          homeDir: input.homeDir,
          fallbackCwd: input.fallbackCwd,
        }),
      );
    }
  }
  return { chats, olderChatCount };
}

function parseGenericJsonl(input: {
  readonly contents: string;
  readonly source: WorkspaceImportCanonicalSourceKind;
  readonly sourceId: string;
  readonly fallbackCwd: string;
  readonly fallbackUpdatedAt: string;
}): CollectedImportChat | null {
  const records: unknown[] = [];
  for (const line of input.contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch {
      // A corrupt line must not make the rest of a session unavailable.
    }
  }
  const messages: CollectedImportMessage[] = [];
  const connectors: string[] = [];
  let title: string | null = null;
  let cwd = input.fallbackCwd;
  let updatedAt = input.fallbackUpdatedAt;
  const seenMessages = new Set<string>();
  for (const value of records.slice(0, 10_000)) {
    const record = asRecord(value);
    if (!record) continue;
    collectConnectorsFromUnknown(record, connectors);
    const codexMessage = parseCodexMessageRecord(record, updatedAt);
    if (codexMessage) {
      const key = `${codexMessage.role}:${codexMessage.createdAt}:${codexMessage.text}`;
      if (!seenMessages.has(key) && messages.length < MAX_IMPORTED_MESSAGES) {
        seenMessages.add(key);
        messages.push(codexMessage);
      }
    }
    const metaPayload = record.type === "session_meta" ? asRecord(record.payload) : null;
    if (metaPayload) {
      cwd = readString(metaPayload.cwd ?? metaPayload.workingDirectory) ?? cwd;
      title = readString(metaPayload.title ?? metaPayload.name) ?? title;
    }
    title = readString(record.title ?? record.name ?? record.summary) ?? title;
    cwd = readString(record.cwd ?? record.workingDirectory ?? record.workspace) ?? cwd;
    const timestamp =
      parseImportTimestamp(
        record.updatedAt ?? record.timestamp ?? record.createdAt ?? record.time,
      ) ?? parseImportTimestamp(metaPayload?.timestamp ?? metaPayload?.createdAt);
    if (timestamp) updatedAt = timestamp.toISOString();
    const role = record.role === "user" || record.role === "assistant" ? record.role : null;
    const text = readTranscriptText(record.message ?? record);
    if (role && text) {
      const message = { role, text, createdAt: timestamp?.toISOString() ?? updatedAt } as const;
      const key = `${message.role}:${message.createdAt}:${message.text}`;
      if (!seenMessages.has(key) && messages.length < MAX_IMPORTED_MESSAGES) {
        seenMessages.add(key);
        messages.push(message);
      }
      continue;
    }
    // Some providers emit a `parts` or nested `messages` envelope per line.
    const nested = Array.isArray(record.messages)
      ? record.messages
      : Array.isArray(record.parts)
        ? record.parts
        : [];
    for (const item of nested) {
      const nestedRecord = asRecord(item);
      if (!nestedRecord) continue;
      const nestedRole =
        nestedRecord.role === "user" || nestedRecord.role === "assistant"
          ? nestedRecord.role
          : null;
      const nestedText = readTranscriptText(nestedRecord);
      if (!nestedRole || !nestedText) continue;
      const nestedTimestamp = parseImportTimestamp(
        nestedRecord.createdAt ?? nestedRecord.timestamp,
      );
      const message = {
        role: nestedRole,
        text: nestedText,
        createdAt: nestedTimestamp?.toISOString() ?? updatedAt,
      } as const;
      const key = `${message.role}:${message.createdAt}:${message.text}`;
      if (!seenMessages.has(key) && messages.length < MAX_IMPORTED_MESSAGES) {
        seenMessages.add(key);
        messages.push(message);
      }
    }
  }
  const cappedMessages = capImportedMessages(messages);
  if (cappedMessages.length === 0) return null;
  return {
    source: input.source,
    sourceId: input.sourceId,
    title:
      title ?? titleFromMessages(cappedMessages) ?? fallbackTitle(input.source, input.sourceId),
    workingDirectory: cwd,
    updatedAt,
    messages: cappedMessages,
    connectors: uniqueConnectors(connectors),
  };
}

export async function collectImportChats(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now: Date;
  readonly fallbackCwd: string;
}): Promise<{ chats: CollectedImportChat[]; olderChatCount: number }> {
  const source = normalizeWorkspaceImportSource(input.source);
  if (source === "claude") return collectClaudeChats(input);
  if (source === "cursor") {
    return collectCursorChats({ ...input, platform: input.platform ?? process.platform });
  }
  if (source === "codex") {
    return collectCodexChats({ ...input, platform: input.platform ?? process.platform });
  }
  return collectGenericProviderChats({
    source,
    homeDir: input.homeDir,
    platform: input.platform ?? process.platform,
    env: input.env,
    now: input.now,
    fallbackCwd: input.fallbackCwd,
  });
}

export async function readSourceSettings(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<unknown> {
  const paths = settingsPathsForSource(input.source, input);
  for (const path of paths) {
    try {
      const raw = (await readRegularFileNoFollow(path, MAX_SETTINGS_FILE_BYTES)).toString("utf8");
      if (path.toLowerCase().endsWith(".toml")) {
        return parseToml(raw) as unknown;
      }
      return JSON.parse(raw) as unknown;
    } catch {
      // Try the next documented location.
    }
  }
  return null;
}
