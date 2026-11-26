// FILE: AntigravityChildWork.ts
// Purpose: Reads bounded, provider-owned Antigravity swarm/subagent/wake state for an ACP session.
// Layer: Provider ACP adapter support
// Exports: resolveAntigravityProfileDir, readAntigravityChildActivity, AntigravityChildActivity

import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { configuredHomeDirectory } from "@moss/shared/platformEnvironment";
import { Effect } from "effect";

const NATIVE_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_RECORDS = 256;
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const HIGH_PRIORITY_MESSAGE = "MESSAGE_PRIORITY_HIGH";
const LOW_PRIORITY_MESSAGE = "MESSAGE_PRIORITY_LOW";
const PROFILE_DATA_DIRS = ["antigravity-cli", "antigravity-acp"] as const;

export interface AntigravityChildActivity {
  readonly activeSwarmWorkers: number;
  readonly activeSubagents: number;
  readonly hasPendingWake: boolean;
  readonly hasActiveWork: boolean;
}

export const EMPTY_ANTIGRAVITY_CHILD_ACTIVITY: AntigravityChildActivity = {
  activeSwarmWorkers: 0,
  activeSubagents: 0,
  hasPendingWake: false,
  hasActiveWork: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves the `.gemini` profile directory `agy acp` writes its session metadata into. */
export function resolveAntigravityProfileDir(cwd: string, environment: NodeJS.ProcessEnv): string {
  const home =
    configuredHomeDirectory(environment as Readonly<Record<string, string>>) ?? homedir();
  return resolve(cwd, home, ".gemini");
}

// Require every managed path component to be a literal directory/file without symlinks.
async function managedPath(
  root: string,
  segments: ReadonlyArray<string>,
  directory: boolean,
): Promise<string> {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === "." || segment === ".." || /[\\/:]/u.test(segment)) {
      throw new Error("Invalid Antigravity profile path");
    }
    current = join(current, segment);
    const info = await lstat(current);
    const expectDirectory = directory || index < segments.length - 1;
    if (expectDirectory ? !info.isDirectory() : !info.isFile()) {
      throw new Error("Linked or invalid Antigravity profile path");
    }
  }
  if ((await realpath(current)) !== current) {
    throw new Error("Linked Antigravity profile path");
  }
  return current;
}

async function readLastTranscriptLine(
  root: string,
  baseSegments: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  signal.throwIfAborted();
  const transcriptPath = await managedPath(
    root,
    [...baseSegments, "logs", "transcript.jsonl"],
    false,
  ).catch(() => undefined);
  if (!transcriptPath) return undefined;
  const handle = await open(
    transcriptPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    const current = await lstat(transcriptPath);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !current.isFile() ||
      stat.ino !== current.ino ||
      stat.dev !== current.dev ||
      (await realpath(transcriptPath)) !== transcriptPath ||
      stat.size === 0
    ) {
      return undefined;
    }
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let end = bytesRead;
    while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) {
      end -= 1;
    }
    if (end === 0) return undefined;
    const trimmed = buffer.subarray(0, end);
    const lastNewline = trimmed.lastIndexOf(0x0a);
    if (lastNewline === -1 && start > 0) return undefined;
    const line = trimmed.toString("utf8", lastNewline + 1).trim();
    if (!line) return undefined;
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Inspects Antigravity's native session metadata on disk to determine whether
 * detached `/swarm` workers, subagents, or queued high-priority wakes are still
 * actively working while the parent ACP stream is silent.
 *
 * Fails closed (`hasActiveWork: false`) when records are missing, linked,
 * oversized, or unreadable so a genuine wedged prompt can still time out.
 */
export function readAntigravityChildActivity(input: {
  readonly profileDir: string;
  readonly sessionId: string;
}): Effect.Effect<AntigravityChildActivity> {
  if (!NATIVE_ID.test(input.sessionId)) {
    return Effect.succeed(EMPTY_ANTIGRAVITY_CHILD_ACTIVITY);
  }
  return Effect.tryPromise(async (signal): Promise<AntigravityChildActivity> => {
    const profileInfo = await lstat(input.profileDir).catch(() => undefined);
    if (!profileInfo?.isDirectory()) return EMPTY_ANTIGRAVITY_CHILD_ACTIVITY;
    const root = await realpath(input.profileDir);

    let baseSegments: ReadonlyArray<string> | undefined;
    for (const dataDir of PROFILE_DATA_DIRS) {
      const candidate = [dataDir, "brain", input.sessionId, ".system_generated"] as const;
      const found = await managedPath(root, candidate, true).catch(() => undefined);
      if (found) {
        baseSegments = candidate;
        break;
      }
    }
    if (!baseSegments) return EMPTY_ANTIGRAVITY_CHILD_ACTIVITY;

    let bytesLeft = MAX_SCAN_BYTES;
    let recordsLeft = MAX_SCAN_RECORDS;

    const listJsonNames = async (
      segments: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<string>> => {
      const dirPath = await managedPath(root, segments, true).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (!dirPath) return [];
      const entries: string[] = [];
      let count = 0;
      for await (const entry of await opendir(dirPath)) {
        signal.throwIfAborted();
        if (++count > MAX_DIRECTORY_ENTRIES) {
          throw new Error("Antigravity profile directory limit exceeded");
        }
        if (entry.name.endsWith(".json")) entries.push(entry.name);
      }
      return entries.toSorted();
    };

    const readJsonRecord = async (
      segments: ReadonlyArray<string>,
    ): Promise<Record<string, unknown> | undefined> => {
      signal.throwIfAborted();
      if (--recordsLeft < 0 || bytesLeft <= 0) {
        throw new Error("Antigravity profile scan limit exceeded");
      }
      const filePath = await managedPath(root, segments, false).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (!filePath) return undefined;
      const handle = await open(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = await handle.stat();
        const current = await lstat(filePath);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !current.isFile() ||
          stat.ino !== current.ino ||
          stat.dev !== current.dev ||
          (await realpath(filePath)) !== filePath ||
          stat.size > Math.min(bytesLeft, MAX_RECORD_BYTES)
        ) {
          throw new Error("Invalid Antigravity profile record");
        }
        const contents = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
        if (bytesRead > stat.size) throw new Error("Antigravity profile record changed");
        bytesLeft -= bytesRead;
        const parsed: unknown = JSON.parse(contents.toString("utf8", 0, bytesRead));
        return isRecord(parsed) ? parsed : undefined;
      } finally {
        await handle.close();
      }
    };

    // 1. Inspect /swarm roster (`swarm/members.json`).
    // Swarm workers set `wake_mode` to `"working"` while executing a turn and
    // `"mentions"` / `"anything"` once parked waiting on the board. Checking
    // the roster authoritatively covers both newly spawned and resumed swarms.
    const swarmConversationIds = new Set<string>();
    let activeSwarmWorkers = 0;
    const swarmRoster = await readJsonRecord([...baseSegments, "swarm", "members.json"]);
    const members = isRecord(swarmRoster?.members) ? swarmRoster.members : undefined;
    if (members) {
      for (const member of Object.values(members)) {
        if (!isRecord(member)) continue;
        const convId = typeof member.conversation_id === "string" ? member.conversation_id : "";
        if (!NATIVE_ID.test(convId)) continue;
        const role = typeof member.role === "string" ? member.role : "worker";
        if (role === "coordinator") continue;
        swarmConversationIds.add(convId);
        const killed =
          member.killed === true || member.desired_state === "KILLED" || member.phase === "KILLED";
        const parked = member.wake_mode === "mentions" || member.wake_mode === "anything";
        if (!killed && !parked) {
          activeSwarmWorkers += 1;
        }
      }
    }

    // 2. Inspect parent inbox (`messages/`) for subagent reports and unread wakes.
    const parentInbox = [...baseSegments, "messages"];
    const messageFiles = await listJsonNames(parentInbox);
    const readReceipts = messageFiles.includes("read.json")
      ? await readJsonRecord([...parentInbox, "read.json"])
      : undefined;
    const reportedSenders = new Set<string>();
    let hasPendingWake = false;
    for (const fileName of messageFiles) {
      if (fileName === "read.json") continue;
      const message = await readJsonRecord([...parentInbox, fileName]);
      if (!message) continue;
      if (typeof message.sender === "string" && message.sender) {
        reportedSenders.add(message.sender);
      }
      const fileId = fileName.slice(0, -5);
      const isRead =
        readReceipts?.[fileId] === true ||
        (typeof message.id === "string" && readReceipts?.[message.id] === true);
      if (!isRead && message.priority === HIGH_PRIORITY_MESSAGE) {
        hasPendingWake = true;
      }
    }

    // 3. Inspect detached non-swarm subagents (`subagents/*.json`).
    let activeSubagents = 0;
    const subagentsDir = [...baseSegments, "subagents"];
    const subagentFiles = (await listJsonNames(subagentsDir)).filter((name) =>
      NATIVE_ID.test(name.slice(0, -5)),
    );
    for (const fileName of subagentFiles) {
      const childId = fileName.slice(0, -5);
      if (childId === input.sessionId || swarmConversationIds.has(childId)) continue;
      if (reportedSenders.has(childId)) continue;
      const descriptor = await readJsonRecord([...subagentsDir, fileName]);
      if (!descriptor) continue;
      if (descriptor.conversationId !== undefined && descriptor.conversationId !== childId) {
        continue;
      }
      if (descriptor.state === "SUBAGENT_STATE_ALIVE") {
        activeSubagents += 1;
      }
    }

    // 4. Check trailing `SYSTEM_MESSAGE` wake in `logs/transcript.jsonl` that
    // has already been dequeued from `messages/` before the planner replies.
    if (!hasPendingWake) {
      const lastStep = await readLastTranscriptLine(root, baseSegments, signal).catch(
        () => undefined,
      );
      if (lastStep?.type === "SYSTEM_MESSAGE") {
        const content = typeof lastStep.content === "string" ? lastStep.content : undefined;
        if (
          content === undefined ||
          content.includes(`priority=${HIGH_PRIORITY_MESSAGE}`) ||
          !content.includes(`priority=${LOW_PRIORITY_MESSAGE}`)
        ) {
          hasPendingWake = true;
        }
      }
    }

    return {
      activeSwarmWorkers,
      activeSubagents,
      hasPendingWake,
      hasActiveWork: activeSwarmWorkers > 0 || activeSubagents > 0 || hasPendingWake,
    };
  }).pipe(Effect.orElseSucceed(() => EMPTY_ANTIGRAVITY_CHILD_ACTIVITY));
}
