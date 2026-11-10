// FILE: projectImportTranscript.ts
// Purpose: Fill a registered (lazily imported) conversation with its transcript, read straight
//          from the agent's own session file, the first time someone opens or continues it.
// Layer: Server orchestration (project import)
// Exports: readImportedTranscript, makeImportedTranscriptLoader

import { CommandId, type ProjectImportProvider, type ThreadId } from "@moss/contracts";
import { Effect } from "effect";

import type { ProjectImportRepository } from "../persistence/projectImportRepository";
import { findClaudeSessionTranscriptPath } from "../provider/claudeProjectImport";
import { findCodexRolloutPath } from "../provider/codexProjectImport";
import { LOCAL_HISTORY_READERS, type LocalHistoryMessage } from "../provider/localHistory";
import {
  readClaudeSessionMessages,
  readCodexRolloutMessages,
} from "../provider/localHistory/nativeTranscripts";
import { makeKeyedLock } from "../provider/keyedLock";
import { mapLocalHistoryMessages } from "./importedThreadMessages";
import { projectImportPromise } from "./projectImportHistory";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";

const TRANSCRIPT_BATCH = 50;
const MISSING = "The conversation file is no longer on this computer.";

export interface ImportedTranscriptSource {
  readonly provider: ProjectImportProvider;
  /** The store the conversation was found in (a Codex home, a Claude config folder, …). */
  readonly sourceHome: string;
  readonly externalId: string;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The visible conversation, read from local files only. No agent is started. */
export async function readImportedTranscript(
  source: ImportedTranscriptSource,
): Promise<ReadonlyArray<LocalHistoryMessage>> {
  if (source.provider === "codex") {
    const file = await findCodexRolloutPath({
      homePath: source.sourceHome,
      env: source.env,
      threadId: source.externalId,
    });
    if (!file) throw new Error(MISSING);
    return readCodexRolloutMessages(file);
  }
  if (source.provider === "claudeAgent") {
    const file = await findClaudeSessionTranscriptPath({
      sessionId: source.externalId,
      configDir: source.sourceHome,
    });
    if (!file) throw new Error(MISSING);
    return readClaudeSessionMessages(file);
  }
  return LOCAL_HISTORY_READERS[source.provider].readMessages({
    homeDir: source.homeDir,
    env: source.env,
    sessionId: source.externalId,
  });
}

export function makeImportedTranscriptLoader(options: {
  readonly repository: ProjectImportRepository;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly homeDir: string;
  readonly readTranscript?: (
    source: ImportedTranscriptSource,
  ) => Promise<ReadonlyArray<LocalHistoryMessage>>;
}) {
  const readTranscript = options.readTranscript ?? readImportedTranscript;
  const locks = makeKeyedLock<string>();

  /**
   * Loads the transcript once. Deterministic command ids make a load interrupted halfway
   * resume instead of repeating messages, so opening and continuing at once is safe.
   */
  const load = (threadId: ThreadId) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        const state = yield* options.repository.getHistory(threadId);
        if (state?.lazy?.transcript !== "pending") return;
        const origin = yield* options.repository.findByThread(threadId);
        if (!origin) return;
        const markLoaded = options.repository.saveHistory({
          ...state,
          lazy: { ...state.lazy, transcript: "loaded" },
        });
        // An older importer that stopped halfway already copied part of this conversation
        // under other message ids; adding the whole transcript again would duplicate it.
        if ((yield* options.repository.getLegacyMessages(threadId)).length > 0) {
          return yield* markLoaded;
        }
        const transcript = yield* projectImportPromise(() =>
          readTranscript({
            provider: origin.provider,
            sourceHome: origin.sourceHome,
            externalId: origin.externalId,
            homeDir: options.homeDir,
            env: process.env,
          }),
        );
        const messages = mapLocalHistoryMessages({
          threadId,
          importedAt: state.sourceCreatedAt,
          messages: transcript,
        });
        for (let offset = 0; offset < messages.length; offset += TRANSCRIPT_BATCH) {
          yield* options.orchestrationEngine.dispatch({
            type: "thread.messages.import",
            commandId: CommandId.makeUnsafe(`project-import:${threadId}:transcript:${offset}`),
            threadId,
            messages: messages.slice(offset, offset + TRANSCRIPT_BATCH),
            createdAt: state.sourceCreatedAt,
          });
        }
        yield* markLoaded;
      }),
    );

  return { load };
}
