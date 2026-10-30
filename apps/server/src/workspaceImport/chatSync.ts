// FILE: chatSync.ts
// Purpose: Decide create/update/unchanged for imported chats so re-import
//          never duplicates Moss threads.
// Layer: Server import helper

import type { WorkspaceImportChatResult } from "@synara/contracts";
import type { CollectedImportChat } from "./chats";
import {
  type WorkspaceImportLedger,
  type WorkspaceImportLedgerEntry,
  workspaceImportLedgerKey,
} from "./ledger";

export interface ChatSyncPlanItem {
  readonly action: WorkspaceImportChatResult["action"];
  readonly chat: CollectedImportChat;
  readonly threadId: string;
  readonly messagesToImport: CollectedImportChat["messages"];
  readonly ledgerEntry: WorkspaceImportLedgerEntry;
}

export function planChatSync(input: {
  readonly chats: readonly CollectedImportChat[];
  readonly ledger: WorkspaceImportLedger;
  readonly existingThreadIds: ReadonlySet<string>;
  readonly nowIso: string;
  readonly createThreadId: (chat?: CollectedImportChat) => string;
}): ChatSyncPlanItem[] {
  return input.chats.map((chat) => {
    const key = workspaceImportLedgerKey(chat.source, chat.sourceId);
    const existing = input.ledger.entries[key];
    const threadStillExists =
      existing !== undefined && input.existingThreadIds.has(existing.threadId);
    const threadId = threadStillExists ? existing.threadId : input.createThreadId(chat);
    const importedCount = threadStillExists ? existing.importedCount : 0;
    const messagesToImport = chat.messages.slice(importedCount);
    const unchanged =
      threadStillExists &&
      existing.title === chat.title &&
      existing.workingDirectory === chat.workingDirectory &&
      existing.sourceUpdatedAt === chat.updatedAt &&
      existing.replayFingerprint === chat.replayFingerprint &&
      messagesToImport.length === 0;
    const action: WorkspaceImportChatResult["action"] = !threadStillExists
      ? "created"
      : unchanged
        ? "unchanged"
        : "updated";
    return {
      action,
      chat,
      threadId,
      messagesToImport: unchanged ? [] : messagesToImport,
      ledgerEntry: {
        threadId,
        source: chat.source,
        sourceId: chat.sourceId,
        title: chat.title,
        workingDirectory: chat.workingDirectory,
        importedCount: chat.messages.length,
        ...(chat.replayFingerprint ? { replayFingerprint: chat.replayFingerprint } : {}),
        sourceUpdatedAt: chat.updatedAt,
        importedAt: threadStillExists ? existing.importedAt : input.nowIso,
        updatedAt: input.nowIso,
      },
    };
  });
}

/** Stable parent-first import order; cycles are broken so remaining chats still import. */
export function orderChatPlansForReplay(plans: readonly ChatSyncPlanItem[]): ChatSyncPlanItem[] {
  const byNativeId = new Map(
    plans.flatMap((plan) =>
      plan.chat.nativeThreadId ? [[plan.chat.nativeThreadId, plan] as const] : [],
    ),
  );
  const ordered: ChatSyncPlanItem[] = [];
  const done = new Set<ChatSyncPlanItem>();
  for (const plan of plans) {
    const path: ChatSyncPlanItem[] = [];
    const visiting = new Set<ChatSyncPlanItem>();
    let current: ChatSyncPlanItem | undefined = plan;
    while (current && !done.has(current)) {
      // Real Codex rollouts occasionally form parent cycles across subagents.
      // Aborting the whole import leaves Moss empty; break the edge instead.
      if (visiting.has(current)) break;
      visiting.add(current);
      path.push(current);
      current = current.chat.nativeParentThreadId
        ? byNativeId.get(current.chat.nativeParentThreadId)
        : undefined;
    }
    for (const entry of path.reverse()) {
      done.add(entry);
      ordered.push(entry);
    }
  }
  return ordered;
}
