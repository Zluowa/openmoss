import type {
  ProjectImportProvider,
  ProviderInstanceId,
  ProviderStartOptions,
  ThreadHandoffImportedMessage,
  ThreadId,
} from "@moss/contracts";
import { Data, Effect } from "effect";
import { readClaudeImportMessageDates } from "../provider/claudeProjectImport";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import { readClaudeSessionMessagePageInEnvironment } from "./importThreadRoute";
import { mapClaudeSessionMessages, mapCodexSnapshotMessages } from "./importedThreadMessages";

export class ProjectImportError extends Data.TaggedError("ProjectImportError")<{
  /** Plain words a person can read; raw system errors stay in `detail` and the server log. */
  readonly message: string;
  /** True only when trying again can succeed, such as a busy disk or database. */
  readonly retryable?: boolean;
  readonly detail?: string;
}> {}

const BUSY_CODES = new Set([
  "EBUSY",
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

/**
 * A failure in plain words. File-system and database errors carry codes and raw paths
 * (`EISDIR: illegal operation on a directory, stat 'E:'`) that mean nothing to a person;
 * Moss's own errors are already written for people and pass through.
 */
export function toProjectImportError(cause: unknown): ProjectImportError {
  if (cause instanceof ProjectImportError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string" && BUSY_CODES.has(code)) {
    return new ProjectImportError({
      message: "The disk was busy. Moss can try again.",
      retryable: true,
      detail: message,
    });
  }
  if (typeof code === "string" && /^(?:E[A-Z]+|SQLITE_\w+|ERR_SQLITE_ERROR)$/u.test(code)) {
    return new ProjectImportError({
      message: "Moss couldn't read this conversation's files.",
      retryable: false,
      detail: message,
    });
  }
  return new ProjectImportError({ message });
}

export const projectImportPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: toProjectImportError }).pipe(
    Effect.tapError((error) =>
      error.detail
        ? Effect.logWarning("project import could not use a file or folder").pipe(
            Effect.annotateLogs({ detail: error.detail }),
          )
        : Effect.void,
    ),
  );

export function nativeImportId(provider: ProjectImportProvider, cursor: unknown): string | null {
  if (!cursor || typeof cursor !== "object") return null;
  const value =
    provider === "codex"
      ? (cursor as { threadId?: unknown }).threadId
      : (cursor as { resume?: unknown }).resume;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ReadProjectImportHistoryInput {
  readonly provider: ProjectImportProvider;
  readonly threadId: ThreadId;
  readonly nativeId: string;
  readonly sourceHome: string;
  readonly sourceCwd: string;
  readonly sourceCreatedAt: string;
  readonly providerOptions?: ProviderStartOptions | undefined;
  readonly providerInstanceId?: ProviderInstanceId;
  /** Claude account environment when its config dir is not the server's own. */
  readonly claudeEnvironment?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  readonly cursor?: string;
  /** Upper date boundary of the already imported newer page. */
  readonly before?: string | undefined;
}

export interface ProjectImportHistoryPage {
  readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
  readonly nextCursor: string | null;
}

function orderOlderPage(
  messages: ReadonlyArray<ThreadHandoffImportedMessage>,
  before: string | undefined,
): ReadonlyArray<ThreadHandoffImportedMessage> {
  if (!before) return messages;
  let ceiling = Date.parse(before);
  return messages
    .toReversed()
    .map((message) => {
      ceiling = Math.min(Date.parse(message.createdAt), ceiling - 1);
      return {
        ...message,
        createdAt: new Date(ceiling).toISOString(),
        updatedAt: new Date(ceiling).toISOString(),
      };
    })
    .reverse();
}

export function makeProjectImportHistoryReader(registry: ProviderAdapterRegistryShape) {
  return Effect.fn(function* (
    input: ReadProjectImportHistoryInput,
  ): Effect.fn.Return<ProjectImportHistoryPage, unknown> {
    if (input.provider === "claudeAgent") {
      const page = yield* projectImportPromise(async () => {
        // Read the independent fork, never the original conversation.
        const [history, dates] = await Promise.all([
          readClaudeSessionMessagePageInEnvironment({
            sessionId: input.nativeId,
            dir: input.sourceCwd,
            environment: input.claudeEnvironment,
            ...(input.cursor ? { before: input.cursor } : {}),
          }),
          readClaudeImportMessageDates({ sessionId: input.nativeId, configDir: input.sourceHome }),
        ]);
        return {
          ...history,
          messages: history.messages.map((message) => ({
            ...message,
            timestamp: dates.get(message.uuid),
          })),
        };
      });
      return {
        nextCursor: page.nextCursor,
        messages: orderOlderPage(
          mapClaudeSessionMessages({
            threadId: input.threadId,
            importedAt: input.sourceCreatedAt,
            messages: page.messages,
          }),
          input.before,
        ),
      };
    }
    const adapter = yield* registry.getByProvider("codex");
    const snapshot = adapter.readExternalThreadPage
      ? yield* adapter.readExternalThreadPage({
          externalThreadId: input.nativeId,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        })
      : yield* new ProjectImportError({
          message: "Codex paginated history discovery is unavailable.",
        });
    return {
      nextCursor: snapshot.nextCursor,
      messages: orderOlderPage(
        mapCodexSnapshotMessages({
          threadId: input.threadId,
          importedAt: input.sourceCreatedAt,
          turns: snapshot.turns,
        }),
        input.before,
      ),
    };
  });
}
