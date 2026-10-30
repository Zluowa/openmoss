// FILE: contextCompaction.ts
// Purpose: Recognizes a manual context compaction, both the `/compact` command text
// and a live turn that exists only to compact. Providers cannot take steering input
// in such a turn (Codex rejects `turn/steer` on a compact turn; Claude holds the
// message until compaction ends), so steering stops the compaction and sends next.
// Layer: Shared util
// Exports: isCompactionCommandText, isManualCompactionTurnActive

import type { OrchestrationThreadActivity } from "@synara/contracts";

const COMPACTION_COMMAND_PATTERN = /^\/compact(?:\s|$)/;
const CONTEXT_COMPACTION_ACTIVITY_KIND = "context-compaction";
const TERMINAL_COMPACTION_ITEM_STATUSES = new Set(["completed", "failed", "declined"]);

export function isCompactionCommandText(text: string | null | undefined): boolean {
  return COMPACTION_COMMAND_PATTERN.test(text?.trim() ?? "");
}

function compactionActivityPayload(
  activity: Pick<OrchestrationThreadActivity, "payload">,
): Record<string, unknown> | null {
  const payload = activity.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/**
 * True while `activeTurnId` runs a manual compaction that has not settled yet.
 * Adapters tag a manual compaction's progress with `source: "manual"`; an
 * automatic compaction inside ordinary work never matches, so steering into
 * that work still rides the live turn.
 */
export function isManualCompactionTurnActive(input: {
  readonly activeTurnId: string | null | undefined;
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "turnId" | "payload">
  >;
}): boolean {
  const { activeTurnId } = input;
  if (!activeTurnId) return false;
  let manualInProgress = false;
  for (const activity of input.activities) {
    if (activity.kind !== CONTEXT_COMPACTION_ACTIVITY_KIND || activity.turnId !== activeTurnId) {
      continue;
    }
    const payload = compactionActivityPayload(activity);
    // A turn compacts once, so any terminal row settles it regardless of order.
    if (
      payload?.state === "compacted" ||
      (typeof payload?.status === "string" && TERMINAL_COMPACTION_ITEM_STATUSES.has(payload.status))
    ) {
      return false;
    }
    if (payload?.status === "inProgress" && payload.source === "manual") {
      manualInProgress = true;
    }
  }
  return manualInProgress;
}
