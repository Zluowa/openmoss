// FILE: threadOutputFileTimes.ts
// Purpose: Whether a file a reply links was created or written while its turn ran, so the reply
//          offers 下载 beside a file the turn's commands made (WALK-6 N6-1). A folder without
//          git has no checkpoint diff, and a script that writes report.xlsx is no file-change
//          tool; the file's own times are what tell it apart from a README.md the agent only read.
// Layer: Web chat file chips
// Exports: TurnFileWindow, fileTimesFallInTurn, useFileMadeDuringTurn

import {
  PROJECT_STAT_THREAD_OUTPUT_FILES_MAX_PATHS,
  ThreadId,
  type ProjectThreadOutputFileTimes,
} from "@moss/contracts";
import { useEffect, useState } from "react";

import { readNativeApi } from "~/nativeApi";

/** When a turn ran, as the thread recorded it. */
export interface TurnFileWindow {
  readonly startedAt: string;
  /** Null while the turn still runs. */
  readonly completedAt: string | null;
}

// File times and turn times come from the same machine's clock; the margin covers file systems
// that keep times to the second or two (FAT).
const TURN_WINDOW_MARGIN_MS = 2_000;
const MAX_CACHED_ANSWERS = 512;

/** Whether the file was created or last written between the turn's start and its end. */
export function fileTimesFallInTurn(
  times: ProjectThreadOutputFileTimes | null,
  window: TurnFileWindow,
): boolean {
  if (!times) return false;
  const start = Date.parse(window.startedAt) - TURN_WINDOW_MARGIN_MS;
  const end =
    window.completedAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(window.completedAt) + TURN_WINDOW_MARGIN_MS;
  if (!Number.isFinite(start) || Number.isNaN(end)) return false;
  const within = (ms: number | null) => ms !== null && ms >= start && ms <= end;
  return within(times.modifiedAtMs) || within(times.createdAtMs);
}

// Undefined: the server did not answer; null: its download would not serve the file.
type FileTimesAnswer = ProjectThreadOutputFileTimes | null | undefined;

type PendingStat = {
  readonly path: string;
  readonly resolve: (times: FileTimesAnswer) => void;
};

const pendingByThread = new Map<string, PendingStat[]>();
const answers = new Map<string, Promise<FileTimesAnswer>>();

async function flushThread(threadId: string): Promise<void> {
  const pending = pendingByThread.get(threadId) ?? [];
  pendingByThread.delete(threadId);
  const paths = [...new Set(pending.map((entry) => entry.path))];
  const timesByPath = new Map<string, FileTimesAnswer>();
  try {
    const projects = readNativeApi()?.projects;
    if (!projects?.statThreadOutputFiles) return;
    for (
      let offset = 0;
      offset < paths.length;
      offset += PROJECT_STAT_THREAD_OUTPUT_FILES_MAX_PATHS
    ) {
      const chunk = paths.slice(offset, offset + PROJECT_STAT_THREAD_OUTPUT_FILES_MAX_PATHS);
      const result = await projects.statThreadOutputFiles({
        threadId: ThreadId.makeUnsafe(threadId),
        paths: chunk,
      });
      chunk.forEach((path, index) => timesByPath.set(path, result?.files?.[index] ?? null));
    }
  } catch {
    // A server that cannot answer (an older Moss, a lost connection) leaves the chip plain.
  } finally {
    for (const entry of pending) entry.resolve(timesByPath.get(entry.path));
  }
}

function answerKey(threadId: string, path: string, window: TurnFileWindow): string {
  return [threadId, window.startedAt, window.completedAt ?? "running", path].join("|");
}

// One request per thread for the chips a render shows together. A turn's answer is kept: its
// key changes when the turn ends, so a file the running turn had not written yet is asked again.
// An unanswered request is not kept, so the next mount asks again.
function readFileTimes(
  threadId: string,
  path: string,
  window: TurnFileWindow,
): Promise<FileTimesAnswer> {
  const key = answerKey(threadId, path, window);
  const known = answers.get(key);
  if (known) return known;
  const answer = new Promise<FileTimesAnswer>((resolve) => {
    const pending = pendingByThread.get(threadId);
    if (pending) {
      pending.push({ path, resolve });
      return;
    }
    pendingByThread.set(threadId, [{ path, resolve }]);
    queueMicrotask(() => void flushThread(threadId));
  });
  answers.set(key, answer);
  void answer.then((times) => {
    if (times === undefined) answers.delete(key);
  });
  if (answers.size > MAX_CACHED_ANSWERS) {
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
  return answer;
}

/**
 * Whether `path`, linked by a reply of the turn that ran in `window`, was created or written
 * during that turn. False until the server answers, and for a file its download would not serve.
 */
export function useFileMadeDuringTurn(
  threadId: string,
  path: string,
  window: TurnFileWindow,
): boolean {
  const key = answerKey(threadId, path, window);
  const [answer, setAnswer] = useState<{ key: string; made: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const turn = { startedAt: window.startedAt, completedAt: window.completedAt };
    void readFileTimes(threadId, path, turn).then((times) => {
      if (live) setAnswer({ key, made: fileTimesFallInTurn(times ?? null, turn) });
    });
    return () => {
      live = false;
    };
  }, [key, threadId, path, window.startedAt, window.completedAt]);
  return answer?.key === key && answer.made;
}
