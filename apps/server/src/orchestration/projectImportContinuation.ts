// FILE: projectImportContinuation.ts
// Purpose: Before the first new message in a conversation that was imported by registration
//          only, load its transcript and, when the agent can continue it natively, make the
//          native copy then. Otherwise the conversation continues with the copied transcript
//          as context (see hasCopiedTranscriptMessages).
// Layer: Server orchestration (project import)
// Exports: makeImportedThreadContinuation

import {
  CommandId,
  type OrchestrationThread,
  type ProviderStartOptions,
  type ThreadId,
} from "@moss/contracts";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@moss/shared/threadWorkspace";
import { Effect } from "effect";

import type {
  ProjectImportHistoryState,
  ProjectImportRepository,
} from "../persistence/projectImportRepository";
import { findClaudeSessionTranscriptPath } from "../provider/claudeProjectImport";
import { findCodexRolloutPath } from "../provider/codexProjectImport";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { projectImportPromise } from "./projectImportHistory";
import {
  isProjectImportNativeProvider,
  type ProjectImportSource,
  resolveProjectImportSourceHome,
  resolveProjectImportSources,
} from "./projectImportSources";
import { makeImportedTranscriptLoader } from "./projectImportTranscript";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";

type Continuation = NonNullable<ProjectImportHistoryState["lazy"]>["continuation"];

export function makeImportedThreadContinuation(options: {
  readonly repository: ProjectImportRepository;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly serverSettings: ServerSettingsShape;
  readonly homeDir: string;
  readonly stateDir?: string;
}) {
  const transcripts = makeImportedTranscriptLoader(options);
  const paths = { homeDir: options.homeDir, stateDir: options.stateDir };
  // Threads with nothing left to prepare; most threads were never imported.
  const settled = new Set<string>();

  const decide = (threadId: ThreadId, continuation: Continuation) =>
    Effect.gen(function* () {
      const latest = yield* options.repository.getHistory(threadId);
      if (latest?.lazy) {
        yield* options.repository.saveHistory({
          ...latest,
          lazy: { ...latest.lazy, continuation },
        });
      }
      settled.add(threadId);
    });

  /** Whether the agent can copy this conversation natively from the store it was found in. */
  const nativeSourceAvailable = (
    state: ProjectImportHistoryState,
    externalId: string,
    source: ProjectImportSource,
    activeHome: string,
  ) =>
    projectImportPromise(async () => {
      if (state.provider === "codex") {
        // Codex can only fork a rollout that lives inside the home it runs with.
        const rollout = await findCodexRolloutPath({
          homePath: state.sourceHome,
          env: source.environment,
          threadId: externalId,
        });
        return (
          rollout !== undefined &&
          isWorkspaceRootWithin(rollout, activeHome, { platform: process.platform })
        );
      }
      return (
        (await findClaudeSessionTranscriptPath({
          sessionId: externalId,
          configDir: state.sourceHome,
        })) !== undefined
      );
    });

  const forkNatively = (
    state: ProjectImportHistoryState,
    externalId: string,
    source: ProjectImportSource,
    thread: Pick<OrchestrationThread, "modelSelection" | "runtimeMode">,
  ) =>
    Effect.gen(function* () {
      const importExternalThread = options.providerService.importExternalThread;
      const stopRuntimeSession = options.providerService.stopRuntimeSession;
      if (!importExternalThread || !stopRuntimeSession) return false;
      const providerOptions: ProviderStartOptions =
        state.provider === "codex"
          ? { codex: source.providerOptions?.codex ?? {} }
          : { claudeAgent: source.providerOptions?.claudeAgent ?? {} };
      const fork = importExternalThread({
        threadId: state.threadId,
        provider: state.provider as "codex" | "claudeAgent",
        externalThreadId: externalId,
        sourceCwd: state.sourceCwd,
        ...(state.cwd ? { cwd: state.cwd } : {}),
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        providerOptions,
      });
      // The turn about to start resumes the copy; a process left from making it is stopped.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(restore(fork));
          yield* stopRuntimeSession({ threadId: state.threadId });
          yield* result;
        }),
      );
      const now = new Date().toISOString();
      yield* options.orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`project-import:${state.threadId}:native-copy`),
        threadId: state.threadId,
        session: {
          threadId: state.threadId,
          providerName: state.provider,
          providerInstanceId: source.instanceId,
          status: "stopped",
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      return true;
    });

  /**
   * Runs before a turn starts. Never fails the turn: anything that prevents a native copy
   * leaves the conversation on the copied transcript instead.
   */
  const prepare = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (settled.has(threadId)) return;
      const state = yield* options.repository.getHistory(threadId);
      if (!state?.lazy) {
        settled.add(threadId);
        return;
      }
      yield* transcripts.load(threadId);
      if (state.lazy.continuation !== "pending") {
        settled.add(threadId);
        return;
      }
      const origin = yield* options.repository.findByThread(threadId);
      const thread = (yield* options.orchestrationEngine.getReadModel()).threads.find(
        (entry) => entry.id === threadId,
      );
      if (
        !origin ||
        !thread ||
        !isProjectImportNativeProvider(state.provider) ||
        thread.modelSelection.provider !== state.provider ||
        (yield* options.repository.hasRuntimeBinding(threadId))
      ) {
        return yield* decide(threadId, "copied");
      }
      const settings = yield* options.serverSettings.getSettings;
      const source = resolveProjectImportSources(settings, [state.provider], paths).find(
        (candidate) => candidate.instanceId === state.providerInstanceId,
      );
      const activeHome = source
        ? yield* projectImportPromise(() => resolveProjectImportSourceHome(source))
        : undefined;
      if (
        !source ||
        !activeHome ||
        !workspaceRootsEqual(activeHome, state.sourceHome, { platform: process.platform }) ||
        !(yield* nativeSourceAvailable(state, origin.externalId, source, activeHome))
      ) {
        return yield* decide(threadId, "copied");
      }
      const forked = yield* forkNatively(state, origin.externalId, source, thread).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Imported conversation continues from its copied transcript.", {
            threadId,
            reason: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.as(false)),
        ),
      );
      yield* decide(threadId, forked ? "native" : "copied");
    });

  return { prepare };
}
