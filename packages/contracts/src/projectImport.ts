import { Schema } from "effect";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderInstanceId } from "./providerInstance";

/** Agents whose conversations are copied natively, so the copy continues in that agent. */
export const PROJECT_IMPORT_NATIVE_PROVIDERS = ["codex", "claudeAgent"] as const;
/** Agents whose conversations are read from their local files and copied as messages. */
export const PROJECT_IMPORT_TRANSCRIPT_PROVIDERS = [
  "cursor",
  "gemini",
  "antigravity",
  "grok",
  "opencode",
  "pi",
  "hermes",
  "devin",
  "omp",
  "zcode",
] as const;
/**
 * Agents whose conversations Moss can find and count but not copy: their history is
 * encrypted or in a format Moss cannot read yet. They are reported, never imported.
 */
export const PROJECT_IMPORT_UNREADABLE_PROVIDERS = ["antigravity", "kimi"] as const;
export type ProjectImportUnreadableProvider = (typeof PROJECT_IMPORT_UNREADABLE_PROVIDERS)[number];
/** Every agent whose local conversations Moss can find and import, in display order. */
export const PROJECT_IMPORT_PROVIDERS = [
  ...PROJECT_IMPORT_NATIVE_PROVIDERS,
  ...PROJECT_IMPORT_TRANSCRIPT_PROVIDERS,
] as const;
export type ProjectImportNativeProvider = (typeof PROJECT_IMPORT_NATIVE_PROVIDERS)[number];
export type ProjectImportTranscriptProvider = (typeof PROJECT_IMPORT_TRANSCRIPT_PROVIDERS)[number];

export const ProjectImportProvider = Schema.Literals(PROJECT_IMPORT_PROVIDERS);
export type ProjectImportProvider = typeof ProjectImportProvider.Type;

export const ProjectImportThread = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: ProjectImportProvider,
  /** Account the conversation was found in and will be copied into. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Display name of a non-default account; absent for the default account. */
  accountLabel: Schema.optional(Schema.String),
  title: Schema.String,
  cwd: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archived: Schema.Boolean,
  alreadyImported: Schema.Boolean,
});
export type ProjectImportThread = typeof ProjectImportThread.Type;

export const ProjectImportProject = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: Schema.String,
  workspaceRoot: Schema.String,
  directoryExists: Schema.Boolean,
  /** The folder is in a temp directory (an agent's test or scratch run): not selected by default. */
  temporary: Schema.optional(Schema.Boolean),
  existingProjectId: Schema.NullOr(ProjectId),
  providers: Schema.Array(ProjectImportProvider),
  threads: Schema.Array(ProjectImportThread),
});
export type ProjectImportProject = typeof ProjectImportProject.Type;

export const ListProjectImportsInput = Schema.Struct({
  providers: Schema.Array(ProjectImportProvider),
});
export type ListProjectImportsInput = typeof ListProjectImportsInput.Type;

export const ListProjectImportsResult = Schema.Struct({
  projects: Schema.Array(ProjectImportProject),
  sources: Schema.Array(
    Schema.Struct({
      provider: ProjectImportProvider,
      providerInstanceId: Schema.optional(ProviderInstanceId),
      accountLabel: Schema.optional(Schema.String),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  /** Conversations found on this computer that Moss cannot copy, with the reason. */
  unreadable: Schema.optional(
    Schema.Array(
      Schema.Struct({
        provider: Schema.Literals(PROJECT_IMPORT_UNREADABLE_PROVIDERS),
        conversationCount: NonNegativeInt,
        reason: Schema.Literals(["encrypted", "unsupported-format"]),
      }),
    ),
  ),
});
export type ListProjectImportsResult = typeof ListProjectImportsResult.Type;

// One item per request gives progress and cancellation between durable imports.
// A null thread key links an empty project without creating any conversation.
export const ImportProjectInput = Schema.Struct({
  projectKey: TrimmedNonEmptyString,
  threadKey: Schema.NullOr(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
});
export type ImportProjectInput = typeof ImportProjectInput.Type;

export const ImportProjectResult = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  status: Schema.Literals(["imported", "already-present", "project-linked"]),
});
export type ImportProjectResult = typeof ImportProjectResult.Type;

export const LoadProjectImportHistoryInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to inspect availability; echo the returned cursor to load one older page. */
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type LoadProjectImportHistoryInput = typeof LoadProjectImportHistoryInput.Type;

export const LoadProjectImportHistoryResult = Schema.Struct({
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    }),
  ),
});
export type LoadProjectImportHistoryResult = typeof LoadProjectImportHistoryResult.Type;
