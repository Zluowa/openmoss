// FILE: canvasAgentOps.ts
// Purpose: Answers the agent gateway's request to apply an agent's 画布 edit (moss_canvas_mutate)
//          in the open editor, and opens the 画布 for it when its chat is on screen.
// Layer: Chat right dock. routes/_chat.tsx calls it for each `canvas.ops.requested` activity.
// Why: The server must not write a board an editor holds (the person's last strokes could be lost
//      or overwrite the agent's edit). The window applies it in the editor and tells the gateway
//      the outcome as a `canvas.ops.reply` activity; "no-editor" lets the gateway write storage.

import { CommandId, EventId, ThreadId } from "@moss/contracts";

import {
  getMossCanvasLiveEditor,
  holdMossCanvasLoad,
  isMossCanvasMounted,
  releaseMossCanvasLoad,
  waitForMossCanvasLiveEditor,
} from "~/lib/mossCanvasLiveEditors";
import { ensureNativeApi } from "~/nativeApi";
import { useRightDockStore } from "~/rightDockStore";

export const CANVAS_OPS_REQUESTED_KIND = "canvas.ops.requested";
export const CANVAS_OPS_REPLY_KIND = "canvas.ops.reply";
export const CANVAS_OPS_DONE_KIND = "canvas.ops.done";
const READY_WAIT_MS = 15_000;

export interface CanvasOpsRequest {
  readonly requestId: string;
  readonly ops: readonly Record<string, unknown>[];
  /** The agent turn that sent it: only a turn's first edit may open the 画布. */
  readonly turnId: string | null;
}

/** The edit a `canvas.ops.requested` activity carries, or null when it is not one. */
export function canvasOpsRequest(activity: {
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId?: string | null;
}): CanvasOpsRequest | null {
  if (activity.kind !== CANVAS_OPS_REQUESTED_KIND) return null;
  const payload = activity.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value.source !== "moss-mcp-canvas" || typeof value.requestId !== "string") return null;
  if (!/^canvas-ops:[A-Za-z0-9-]{1,80}$/u.test(value.requestId)) return null;
  if (!Array.isArray(value.ops) || value.ops.length === 0 || value.ops.length > 100) return null;
  if (!value.ops.every((op) => op && typeof op === "object" && !Array.isArray(op))) return null;
  return {
    requestId: value.requestId,
    ops: value.ops as Record<string, unknown>[],
    turnId: typeof activity.turnId === "string" ? activity.turnId : null,
  };
}

const answered = new Set<string>();
// The last turn that sent each chat an edit. Only a turn's first edit may open the 画布; if the
// person closes it during the turn (whoever opened it), later edits of that turn go to the saved
// board instead of opening it again. A new turn may open it.
const lastTurnByThread = new Map<string, string>();

function reply(threadId: string, requestId: string, payload: Record<string, unknown>) {
  const id = `canvas-ops-reply:${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  return ensureNativeApi()
    .orchestration.dispatchCommand({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(id),
      threadId: ThreadId.makeUnsafe(threadId),
      createdAt,
      activity: {
        id: EventId.makeUnsafe(id),
        tone: "info",
        kind: CANVAS_OPS_REPLY_KIND,
        summary: "Canvas edit",
        payload: { source: "moss-canvas-window", requestId, ...payload },
        turnId: null,
        createdAt,
      },
    })
    .then(() => undefined);
}

/**
 * Applies the edit in this conversation's open 画布. When none is open and the chat is on screen,
 * opens it beside the chat first. Otherwise says "no-editor" so the gateway writes storage.
 */
export async function answerCanvasOpsRequest(input: {
  readonly threadId: string;
  readonly request: CanvasOpsRequest;
  readonly onScreen: boolean;
}): Promise<void> {
  const { threadId, request } = input;
  if (answered.has(request.requestId)) return;
  answered.add(request.requestId);
  let editor = getMossCanvasLiveEditor(threadId);
  // No 画布 frame at all (not even loading) and the chat is not on screen: the gateway writes
  // storage. Until it says it is done, a 画布 that opens waits, so it loads the agent's edit
  // instead of saving the older board over it.
  const laterEditOfTurn =
    request.turnId !== null && lastTurnByThread.get(threadId) === request.turnId;
  if (request.turnId !== null) lastTurnByThread.set(threadId, request.turnId);
  if (!editor && !isMossCanvasMounted(threadId) && (!input.onScreen || laterEditOfTurn)) {
    holdMossCanvasLoad(threadId, request.requestId);
    await reply(threadId, request.requestId, { status: "no-editor" });
    return;
  }
  // From here the window owns the edit: the gateway must not also write storage.
  await reply(threadId, request.requestId, { status: "accepted" });
  if (!editor) {
    if (!isMossCanvasMounted(threadId)) {
      useRightDockStore.getState().openPane(ThreadId.makeUnsafe(threadId), { kind: "canvas" });
    }
    editor = await waitForMossCanvasLiveEditor(threadId, READY_WAIT_MS);
  }
  if (!editor) {
    await reply(threadId, request.requestId, {
      status: "failed",
      errorCode: "canvas_open_required",
    });
    return;
  }
  const result = await editor.apply(request.requestId, request.ops);
  await reply(
    threadId,
    request.requestId,
    result.ok
      ? {
          status: "applied",
          result: {
            created: result.created ?? {},
            deletedCount: result.deletedCount ?? 0,
            shapes: (result.shapes ?? []).slice(0, 60),
            truncated: result.truncated === true || (result.shapes?.length ?? 0) > 60,
            saved: result.saved !== false,
          },
        }
      : { status: "failed", errorCode: result.errorCode ?? "canvas_ops_failed" },
  );
}

/** The `requestId` a `canvas.ops.done` activity names (the gateway's storage write ended). */
export function canvasOpsDone(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): string | null {
  if (activity.kind !== CANVAS_OPS_DONE_KIND) return null;
  const payload = activity.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  return value.source === "moss-mcp-canvas" && typeof value.requestId === "string"
    ? value.requestId
    : null;
}

export function releaseCanvasAfterStorageWrite(threadId: string, requestId: string): void {
  releaseMossCanvasLoad(threadId, requestId);
}

export function resetCanvasAgentOpsForTests(): void {
  answered.clear();
  lastTurnByThread.clear();
}
