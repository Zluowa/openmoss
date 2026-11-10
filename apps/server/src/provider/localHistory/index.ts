// FILE: index.ts
// Purpose: One registry of local-history readers for agents whose conversations Moss copies
//          as messages (Codex and Claude Code are copied natively instead), plus counters for
//          conversations Moss can find but not copy.
// Layer: Provider local-history parsing
// Exports: LOCAL_HISTORY_READERS, UNREADABLE_HISTORY_COUNTERS

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  ProjectImportTranscriptProvider,
  ProjectImportUnreadableProvider,
} from "@moss/contracts";

import { antigravitySessionReader, countAntigravityAppConversations } from "./antigravitySessions";
import { cursorSessionReader } from "./cursorSessions";
import { devinSessionReader } from "./devinSessions";
import { geminiSessionReader } from "./geminiSessions";
import { grokSessionReader } from "./grokSessions";
import { hermesSessionReader } from "./hermesSessions";
import { openCodeSessionReader, zcodeSessionReader } from "./openCodeSessions";
import { makePiSessionReader } from "./piSessions";
import { envDirectory, listDirectory } from "./shared";
import type { LocalHistoryPathInput, LocalHistoryReader } from "./types";

export type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

export const LOCAL_HISTORY_READERS: Readonly<
  Record<ProjectImportTranscriptProvider, LocalHistoryReader>
> = {
  cursor: cursorSessionReader,
  gemini: geminiSessionReader,
  antigravity: antigravitySessionReader,
  grok: grokSessionReader,
  opencode: openCodeSessionReader,
  pi: makePiSessionReader(
    (input) =>
      envDirectory(input.env, "PI_CODING_AGENT_DIR", input.homeDir) ??
      nodePath.join(input.homeDir, ".pi", "agent"),
    "PI_CODING_AGENT_SESSION_DIR",
  ),
  hermes: hermesSessionReader,
  devin: devinSessionReader,
  // Oh My Pi is a Pi fork with the same session format under its own profile folder.
  omp: makePiSessionReader((input) =>
    nodePath.join(input.homeDir, input.env.PI_CONFIG_DIR?.trim() || ".omp", "agent"),
  ),
  zcode: zcodeSessionReader,
};

/** Kimi Code keeps `sessions/<folder key>/<session>/state.json`; its message log is not documented. */
async function countKimiSessions(input: LocalHistoryPathInput): Promise<number> {
  const sessions = nodePath.join(
    envDirectory(input.env, "KIMI_CODE_HOME", input.homeDir) ??
      nodePath.join(input.homeDir, ".kimi-code"),
    "sessions",
  );
  let count = 0;
  for (const folder of await listDirectory(sessions)) {
    if (!folder.isDirectory()) continue;
    for (const session of await listDirectory(nodePath.join(sessions, folder.name))) {
      if (!session.isDirectory()) continue;
      try {
        await fs.access(nodePath.join(sessions, folder.name, session.name, "state.json"));
        count += 1;
      } catch {
        // Not a session folder.
      }
    }
  }
  return count;
}

export interface UnreadableHistoryCounter {
  readonly reason: "encrypted" | "unsupported-format";
  readonly count: (input: LocalHistoryPathInput) => Promise<number>;
}

/** Conversations Moss reports so nothing on the computer goes unmentioned, but cannot copy. */
export const UNREADABLE_HISTORY_COUNTERS: Readonly<
  Record<ProjectImportUnreadableProvider, UnreadableHistoryCounter>
> = {
  antigravity: { reason: "encrypted", count: countAntigravityAppConversations },
  kimi: { reason: "unsupported-format", count: countKimiSessions },
};
