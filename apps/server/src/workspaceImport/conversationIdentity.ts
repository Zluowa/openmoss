// FILE: conversationIdentity.ts
// Purpose: The one identity both importers agree on for a conversation, so the workspace
//          import's automatic chat sync and the project import panel never bring in the
//          same conversation twice.
// Layer: Server import helper
// Exports: nativeConversationIdentity, nativeConversationKey, chatSyncAddsNewChats

import type { ProjectImportProvider, WorkspaceImportSourceKind } from "@moss/contracts";
import { normalizeWorkspaceImportSource } from "@moss/contracts";

export interface NativeConversationIdentity {
  readonly provider: ProjectImportProvider;
  /** The agent's own session id: what project import stores as `externalId`. */
  readonly externalId: string;
}

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl?$/iu;

/**
 * The agent's own session id for a chat the workspace import collected, or null when it
 * cannot be told reliably.
 *
 * - Claude Code: the source id is `<project folder>/<session id>`, and the transcript file
 *   is named after the session.
 * - Codex: the source id is the rollout's path, and Codex names each rollout
 *   `rollout-<time>-<thread id>.jsonl`.
 *
 * Cursor, Grok and OpenCode chats are read from files whose names are not the session ids
 * the project import uses (OpenCode, for one, now keeps its history in SQLite), so they
 * get no identity and are not synced as new chats (see `chatSyncAddsNewChats`).
 */
export function nativeConversationIdentity(
  source: WorkspaceImportSourceKind,
  sourceId: string,
): NativeConversationIdentity | null {
  const canonical = normalizeWorkspaceImportSource(source);
  if (canonical === "claude") {
    const sessionId = sourceId.split("/").at(-1)?.trim();
    return sessionId ? { provider: "claudeAgent", externalId: sessionId } : null;
  }
  if (canonical === "codex") {
    const threadId = UUID_AT_END.exec(sourceId)?.[1];
    return threadId ? { provider: "codex", externalId: threadId.toLowerCase() } : null;
  }
  return null;
}

export function nativeConversationKey(identity: NativeConversationIdentity): string {
  return `${identity.provider}:${identity.externalId.toLowerCase()}`;
}

/**
 * Whether the workspace import may add chats from `source` that it has not imported
 * before. The project import covers every agent's conversations, so a new chat is only
 * added when it has an identity to check against the project import. Chats from the other
 * sources (Cursor, Grok, OpenCode) are left to the project import panel; ones the
 * workspace import already brought in keep updating.
 */
export function chatSyncAddsNewChats(source: WorkspaceImportSourceKind): boolean {
  const canonical = normalizeWorkspaceImportSource(source);
  return canonical === "claude" || canonical === "codex";
}
