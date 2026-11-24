// FILE: agentCanvasOpen.ts
// Purpose: When the agent calls moss_canvas_open, the conversation's 画布 shows beside the chat.
// Layer: Chat right-dock behaviour
// Exports: claimAgentCanvasOpen, agentCanvasOpenRequest, useAgentCanvasOpenCatchUp
// Why: The window acts on the live event (routes/_chat.tsx). On 2026-11-23 the owner saw the
//      turn say 画布已打开 while the panel stayed empty; the link to the backend had been
//      dropping and reconnecting during that turn, and a request the live stream misses was
//      never acted on. The conversation's recorded activity is the second chance.

import { ThreadId, type OrchestrationThreadActivity } from "@moss/contracts";
import { useEffect, useMemo } from "react";

import { sanitizeMossCanvasImageFocus, type MossCanvasImageFocus } from "~/lib/mossCanvasBridge";
import { useRightDockStore } from "~/rightDockStore";
import { useStore } from "~/store";
import { createThreadSelector } from "~/storeSelectors";

export const AGENT_CANVAS_OPEN_ACTIVITY_KIND = "canvas.open.requested";
/** A recorded request older than this is history (a reload, a later visit), not a request. */
export const AGENT_CANVAS_OPEN_CATCH_UP_MS = 2 * 60_000;

const handledRequests = new Set<string>();

/** True the first time a request is seen: each request opens the 画布 once, never again. */
export function claimAgentCanvasOpen(activityId: string): boolean {
  if (handledRequests.has(activityId)) return false;
  handledRequests.add(activityId);
  return true;
}

export function resetAgentCanvasOpenClaimsForTests(): void {
  handledRequests.clear();
}

/** The open request an activity records, or null when it is not one from the agent tool. */
export function agentCanvasOpenRequest(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): { readonly image: MossCanvasImageFocus | undefined } | null {
  if (activity.kind !== AGENT_CANVAS_OPEN_ACTIVITY_KIND) return null;
  const value: unknown = activity.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.source !== "moss-mcp-canvas") return null;
  return {
    image: sanitizeMossCanvasImageFocus({
      jobId: payload.jobId,
      imageIndex: payload.imageIndex,
      action: "canvas",
    }),
  };
}

/** Opens the 画布 for a recent open request the live event did not deliver. */
export function useAgentCanvasOpenCatchUp(threadId: ThreadId): void {
  const thread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const activities = thread?.activities;
  useEffect(() => {
    if (!activities) return;
    const now = Date.now();
    for (const activity of activities) {
      const request = agentCanvasOpenRequest(activity);
      if (!request || !claimAgentCanvasOpen(String(activity.id))) continue;
      const age = now - Date.parse(activity.createdAt);
      if (!(age <= AGENT_CANVAS_OPEN_CATCH_UP_MS)) continue;
      useRightDockStore.getState().openPane(ThreadId.makeUnsafe(threadId), {
        kind: "canvas",
        ...(request.image ? { canvasImage: request.image } : {}),
      });
    }
  }, [activities, threadId]);
}
