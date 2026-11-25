import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ClientOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationThreadShell,
  ThreadMetaUpdatedPayload,
} from "./orchestration";

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);

// WALK-7 N7-1: only the server records that a conversation's 画布 has content.
describe("the 画布 content mark is server only", () => {
  const record = {
    type: "thread.canvas-edited.record",
    commandId: "canvas-edited:thread-a",
    threadId: "thread-a",
    editedAt: "2026-11-24T10:01:00.000Z",
  };

  it("is a command the server can dispatch", () => {
    expect(decodeCommand(record)).toEqual(record);
  });

  it("is not a command a window or the phone can send", () => {
    expect(() => decodeClientCommand(record)).toThrow();
  });

  it("cannot ride on a client thread.meta.update", () => {
    const decoded = decodeClientCommand({
      type: "thread.meta.update",
      commandId: "cmd-meta",
      threadId: "thread-a",
      title: "x",
      canvasEditedAt: "2026-11-24T10:01:00.000Z",
    });
    expect(decoded).not.toHaveProperty("canvasEditedAt");
  });
});

// A build that predates `canvasEditedAt` must still read the events and shells that carry it.

/** The schema as an older build has it: the same struct without the new field. */
function withoutCanvasEditedAt<F extends Schema.Struct.Fields>(fields: F) {
  const { canvasEditedAt: _dropped, ...older } = fields as F & { canvasEditedAt?: unknown };
  return Schema.Struct(older);
}

const createdAt = "2026-11-24T10:00:00.000Z";
const drawnAt = "2026-11-24T10:01:00.000Z";

describe("canvasEditedAt in an older build", () => {
  it("decodes a thread.meta-updated that carries only it, and drops it", () => {
    // What the server emits when the 画布 first holds content (decider.ts).
    const payload = { threadId: "thread-new-chat", canvasEditedAt: drawnAt, updatedAt: createdAt };
    expect(Schema.decodeUnknownSync(ThreadMetaUpdatedPayload)(payload)).toHaveProperty(
      "canvasEditedAt",
      drawnAt,
    );
    const older = withoutCanvasEditedAt(ThreadMetaUpdatedPayload.fields);
    const decoded = Schema.decodeUnknownSync(older)(payload);
    expect(decoded).not.toHaveProperty("canvasEditedAt");
    expect(decoded).toEqual({ threadId: "thread-new-chat", updatedAt: createdAt });
  });

  it("decodes a thread shell that carries it, and drops it", () => {
    const shell = {
      id: "thread-new-chat",
      projectId: "project-a",
      title: "New thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      listedAfterFirstSend: true,
      canvasEditedAt: drawnAt,
    };
    expect(Schema.decodeUnknownSync(OrchestrationThreadShell)(shell)).toHaveProperty(
      "canvasEditedAt",
      drawnAt,
    );
    const older = withoutCanvasEditedAt(OrchestrationThreadShell.fields);
    const decoded = Schema.decodeUnknownSync(older)(shell);
    expect(decoded).not.toHaveProperty("canvasEditedAt");
    expect(decoded).toHaveProperty("listedAfterFirstSend", true);
  });
});
