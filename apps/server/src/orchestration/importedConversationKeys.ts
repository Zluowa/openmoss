// FILE: importedConversationKeys.ts
// Purpose: Every agent conversation Moss already holds a thread for, from either importer,
//          as `<provider>:<agent session id>` keys. The project import panel and the
//          workspace import's chat sync both check it so neither brings a conversation in
//          twice.
// Layer: Orchestration import helper
// Exports: listProjectImportedConversationKeys, listWorkspaceImportedConversationKeys

import { Effect } from "effect";

import type { ProjectImportRepository } from "../persistence/projectImportRepository";
import {
  nativeConversationIdentity,
  nativeConversationKey,
} from "../workspaceImport/conversationIdentity";
import { readWorkspaceImportLedger } from "../workspaceImport/ledger";
import { nativeImportId } from "./projectImportHistory";

const key = (provider: string, externalId: string) => `${provider}:${externalId.toLowerCase()}`;

/**
 * Conversations the project import registered (pending or done), plus every thread bound
 * to a native Codex or Claude session, including Moss's own conversations, whose sessions
 * the agents also keep in the same history folders.
 */
export const listProjectImportedConversationKeys = (repository: ProjectImportRepository) =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    for (const origin of yield* repository.list())
      keys.add(key(origin.provider, origin.externalId));
    for (const binding of yield* repository.listNativeBindings()) {
      if (binding.provider !== "codex" && binding.provider !== "claudeAgent") continue;
      let cursor: unknown;
      try {
        cursor = JSON.parse(binding.cursor ?? "null");
      } catch {
        continue;
      }
      const externalId = nativeImportId(binding.provider, cursor);
      if (externalId) keys.add(key(binding.provider, externalId));
    }
    return keys as ReadonlySet<string>;
  });

/**
 * Conversations the workspace import's chat sync brought in whose thread still exists.
 * Only Claude Code and Codex chats have an identity the project import can match.
 */
export async function listWorkspaceImportedConversationKeys(input: {
  readonly stateDir: string;
  readonly threadExists: (threadId: string) => boolean;
}): Promise<ReadonlySet<string>> {
  const ledger = await readWorkspaceImportLedger(input.stateDir);
  const keys = new Set<string>();
  for (const entry of Object.values(ledger.entries)) {
    if (!input.threadExists(entry.threadId)) continue;
    const identity = nativeConversationIdentity(entry.source, entry.sourceId);
    if (identity) keys.add(nativeConversationKey(identity));
  }
  return keys;
}
