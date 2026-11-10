// FILE: antigravitySessions.ts
// Purpose: Read Antigravity CLI conversations from their plain transcripts
//          (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`), and
//          count the Antigravity app's conversations (`~/.gemini/antigravity/conversations/*.pb`),
//          which the app keeps encrypted, so they can be reported but not copied.
// Layer: Provider local-history parsing
// Exports: antigravitySessionReader, countAntigravityAppConversations

import * as nodePath from "node:path";

import type { NativeImportSession } from "../projectImportTypes";
import { readJsonlRecords } from "./jsonlRecords";
import {
  listDirectory,
  mapBounded,
  modifiedAt,
  nonEmptyString,
  titleFromText,
  visibleMessageText,
} from "./shared";
import type { LocalHistoryMessage, LocalHistoryPathInput, LocalHistoryReader } from "./types";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DISCOVERY_CONCURRENCY = 8;

function cliHome(input: LocalHistoryPathInput): string {
  return nodePath.join(input.homeDir, ".gemini", "antigravity-cli");
}

function transcriptPath(input: LocalHistoryPathInput, id: string): string {
  return nodePath.join(
    cliHome(input),
    "brain",
    id,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

async function readTranscript(file: string): Promise<LocalHistoryMessage[]> {
  const messages: LocalHistoryMessage[] = [];
  for await (const step of readJsonlRecords(file)) {
    // A planner step with tool calls is the agent working, not a reply to the person.
    const role =
      step.type === "USER_INPUT"
        ? "user"
        : step.type === "PLANNER_RESPONSE" &&
            !(Array.isArray(step.tool_calls) && step.tool_calls.length > 0)
          ? "assistant"
          : null;
    const text = role ? visibleMessageText(step.content) : "";
    if (!role || !text) continue;
    messages.push({
      id: typeof step.step_index === "number" ? String(step.step_index) : String(messages.length),
      role,
      text,
    });
  }
  return messages;
}

async function readSummary(
  input: LocalHistoryPathInput,
  id: string,
): Promise<NativeImportSession | undefined> {
  const file = transcriptPath(input, id);
  const updatedAt = await modifiedAt(file);
  if (!updatedAt) return undefined;
  const firstPrompt = (await readTranscript(file)).find((message) => message.role === "user")?.text;
  if (!firstPrompt) return undefined;
  return {
    id,
    title: titleFromText(firstPrompt) ?? "Antigravity",
    // The transcript does not name a working folder; file it under the home folder.
    cwd: input.homeDir,
    projectId: null,
    createdAt: updatedAt,
    updatedAt,
    archived: false,
  };
}

export const antigravitySessionReader: LocalHistoryReader = {
  sourceHome: cliHome,
  discover: async (input) => {
    const ids = (await listDirectory(nodePath.join(cliHome(input), "brain")))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const sessions = await mapBounded(ids, DISCOVERY_CONCURRENCY, (id) => readSummary(input, id));
    return {
      sourceHome: cliHome(input),
      projects: [],
      sessions: sessions.filter((session) => session !== undefined),
    };
  },
  readMessages: async (input) => {
    const id = nonEmptyString(input.sessionId);
    if (!id || !ID_PATTERN.test(id) || !(await modifiedAt(transcriptPath(input, id)))) {
      throw new Error("The conversation file is no longer on this computer.");
    }
    return readTranscript(transcriptPath(input, id));
  },
};

/** The Antigravity app's own conversations: present, but encrypted. */
export async function countAntigravityAppConversations(
  input: LocalHistoryPathInput,
): Promise<number> {
  const entries = await listDirectory(
    nodePath.join(input.homeDir, ".gemini", "antigravity", "conversations"),
  );
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".pb")).length;
}
