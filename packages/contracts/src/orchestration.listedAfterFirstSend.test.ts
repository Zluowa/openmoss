import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ClientOrchestrationCommand,
  OrchestrationThreadShell,
  ThreadCreatedPayload,
} from "./orchestration";

// WALK-1 S-6: an item panel's warm-up chat is created with `listedAfterFirstSend`. A build that
// predates the field must still read events and shells that carry it.

/** The schema as an older build has it: the same struct without the new field. */
function withoutListedAfterFirstSend<F extends Schema.Struct.Fields>(fields: F) {
  const { listedAfterFirstSend: _dropped, ...older } = fields as F & {
    listedAfterFirstSend?: unknown;
  };
  return Schema.Struct(older);
}

const createdAt = "2026-11-24T10:00:00.000Z";
const createdPayload = {
  threadId: "thread-item-chat",
  projectId: "project-a",
  title: "周报",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  listedAfterFirstSend: true,
  createdAt,
  updatedAt: createdAt,
};

describe("listedAfterFirstSend", () => {
  it("rides on thread.create from a window", () => {
    const decoded = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
      type: "thread.create",
      commandId: "cmd-create",
      threadId: "thread-item-chat",
      projectId: "project-a",
      title: "周报",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      listedAfterFirstSend: true,
      createdAt,
    });
    expect(decoded).toHaveProperty("listedAfterFirstSend", true);
  });

  it("is kept on the thread.created event", () => {
    expect(Schema.decodeUnknownSync(ThreadCreatedPayload)(createdPayload)).toHaveProperty(
      "listedAfterFirstSend",
      true,
    );
  });

  it("an older build decodes a thread.created event that carries it, and drops it", () => {
    const older = withoutListedAfterFirstSend(ThreadCreatedPayload.fields);
    const decoded = Schema.decodeUnknownSync(older)(createdPayload);
    expect(decoded).not.toHaveProperty("listedAfterFirstSend");
    expect(decoded).toHaveProperty("title", "周报");
  });

  it("an older build decodes a thread shell that carries it, and drops it", () => {
    const shell = {
      id: "thread-item-chat",
      projectId: "project-a",
      title: "周报",
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
    };
    expect(Schema.decodeUnknownSync(OrchestrationThreadShell)(shell)).toHaveProperty(
      "listedAfterFirstSend",
      true,
    );
    const older = withoutListedAfterFirstSend(OrchestrationThreadShell.fields);
    expect(Schema.decodeUnknownSync(older)(shell)).not.toHaveProperty("listedAfterFirstSend");
  });
});
