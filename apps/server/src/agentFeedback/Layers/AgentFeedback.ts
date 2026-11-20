// FILE: AgentFeedback.ts
// Purpose: Keeps agent feedback in one private JSON file in the server's state folder.
//   A report whose tool and summary match an entry already kept counts against that
//   entry instead of adding a row, so repeated friction rises to the top by count.
// Layer: Server service implementation
// Exports: AgentFeedbackLive, makeAgentFeedback, agentFeedbackFingerprint
// Why: Nothing here leaves the computer. Sending an entry to Moss goes through the
//   feedback dialog, which asks for consent and shows exactly what is sent.

import * as fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  AGENT_FEEDBACK_DETAILS_MAX_LENGTH,
  AGENT_FEEDBACK_MAX_ENTRIES,
  AGENT_FEEDBACK_MAX_PROVIDERS,
  AGENT_FEEDBACK_MAX_THREADS,
  AGENT_FEEDBACK_PROPOSED_FIX_MAX_LENGTH,
  AGENT_FEEDBACK_SUMMARY_MAX_LENGTH,
  AGENT_FEEDBACK_TOOL_MAX_LENGTH,
  AgentFeedbackEntry,
  type AgentFeedbackId,
  type AgentFeedbackSeverity,
} from "@moss/contracts";
import { redactDevsReportText } from "@moss/shared/devsReport";
import { Effect, Layer, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  AgentFeedback,
  AgentFeedbackError,
  type AgentFeedbackRecordResult,
  type AgentFeedbackReportInput,
  type AgentFeedbackShape,
} from "../Services/AgentFeedback.ts";

const FILE_NAME = "agent-feedback.json";

const StoredEntry = Schema.Struct({
  ...AgentFeedbackEntry.fields,
  fingerprint: Schema.String,
});
type StoredEntry = typeof StoredEntry.Type;
const decodeStoredEntry = Schema.decodeUnknownSync(StoredEntry);

const parseStoredEntries = (raw: string): { entries: StoredEntry[]; skipped: number } => {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("agent feedback file is not an array");
  const valid: StoredEntry[] = [];
  let skipped = 0;
  for (const item of parsed) {
    try {
      valid.push(decodeStoredEntry(item));
    } catch {
      skipped += 1;
    }
  }
  return { entries: valid, skipped };
};

const SEVERITY_RANK: Record<AgentFeedbackSeverity, number> = { idea: 0, friction: 1, blocker: 2 };

/** Same tool and same summary, ignoring case, spacing and punctuation. */
export function agentFeedbackFingerprint(tool: string | null, summary: string): string {
  const words = summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${(tool ?? "").trim().toLowerCase()}\n${words}`;
}

const cleanOptional = (value: string | null, maxLength: number) => {
  if (value === null) return null;
  const cleaned = redactDevsReportText(value, maxLength).trim();
  return cleaned.length > 0 ? cleaned : null;
};

const toEntry = ({ fingerprint: _fingerprint, ...entry }: StoredEntry): AgentFeedbackEntry => entry;

export const makeAgentFeedback = (options: {
  readonly filePath: string;
  readonly now?: () => Date;
}) =>
  Effect.gen(function* () {
    const now = options.now ?? (() => new Date());
    const lock = yield* Semaphore.make(1);
    let entries: StoredEntry[] | null = null;

    const load = Effect.gen(function* () {
      if (entries !== null) return entries;
      const raw = yield* Effect.tryPromise(() => fs.readFile(options.filePath, "utf8")).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      let decoded: StoredEntry[] = [];
      if (raw !== null) {
        const parsed = yield* Effect.try({
          try: () => parseStoredEntries(raw),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("agent feedback file unreadable; starting empty", { cause }).pipe(
              Effect.as({ entries: [] as StoredEntry[], skipped: 0 }),
            ),
          ),
        );
        if (parsed.skipped > 0) {
          yield* Effect.logWarning("skipped unreadable agent feedback entries", {
            skipped: parsed.skipped,
          });
        }
        decoded = parsed.entries;
      }
      entries = decoded;
      return decoded;
    });

    const save = (next: StoredEntry[]) =>
      writeFileStringAtomically({
        filePath: options.filePath,
        contents: JSON.stringify(next),
      }).pipe(
        Effect.mapError(
          (cause) => new AgentFeedbackError({ message: "Could not save agent feedback.", cause }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            entries = next;
          }),
        ),
      );

    const record = (input: AgentFeedbackReportInput) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* load;
          const summary =
            redactDevsReportText(input.summary, AGENT_FEEDBACK_SUMMARY_MAX_LENGTH).trim() ||
            "[redacted]";
          const tool = cleanOptional(input.tool, AGENT_FEEDBACK_TOOL_MAX_LENGTH);
          const details = cleanOptional(input.details, AGENT_FEEDBACK_DETAILS_MAX_LENGTH);
          const proposedFix = cleanOptional(
            input.proposedFix,
            AGENT_FEEDBACK_PROPOSED_FIX_MAX_LENGTH,
          );
          const fingerprint = agentFeedbackFingerprint(tool, summary);
          const reportedAt = now().toISOString();
          const existing = current.find((entry) => entry.fingerprint === fingerprint);
          const entry: StoredEntry = existing
            ? {
                ...existing,
                severity:
                  SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]
                    ? input.severity
                    : existing.severity,
                details: details ?? existing.details,
                proposedFix: proposedFix ?? existing.proposedFix,
                providers: [
                  input.provider,
                  ...existing.providers.filter((provider) => provider !== input.provider),
                ].slice(0, AGENT_FEEDBACK_MAX_PROVIDERS),
                occurrences: existing.occurrences + 1,
                lastReportedAt: reportedAt,
                threadIds: [
                  input.threadId,
                  ...existing.threadIds.filter((threadId) => threadId !== input.threadId),
                ].slice(0, AGENT_FEEDBACK_MAX_THREADS),
              }
            : {
                id: `agent-feedback:${randomBytes(16).toString("hex")}` as AgentFeedbackId,
                fingerprint,
                severity: input.severity,
                summary,
                details,
                tool,
                proposedFix,
                providers: [input.provider],
                occurrences: 1,
                firstReportedAt: reportedAt,
                lastReportedAt: reportedAt,
                threadIds: [input.threadId],
              };
          const next = [entry, ...current.filter((candidate) => candidate !== existing)].slice(
            0,
            AGENT_FEEDBACK_MAX_ENTRIES,
          );
          yield* save(next);
          return {
            id: entry.id,
            occurrences: entry.occurrences,
          } satisfies AgentFeedbackRecordResult;
        }),
      );

    const list = lock
      .withPermits(1)(load)
      .pipe(Effect.map((current) => current.map(toEntry)));

    const dismiss = (id: AgentFeedbackId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* load;
          if (!current.some((entry) => entry.id === id)) return;
          yield* save(current.filter((entry) => entry.id !== id));
        }),
      );

    return { record, list, dismiss };
  });

export const AgentFeedbackLive = Layer.effect(
  AgentFeedback,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* makeAgentFeedback({ filePath: path.join(config.stateDir, FILE_NAME) });
    return store satisfies AgentFeedbackShape;
  }),
);
