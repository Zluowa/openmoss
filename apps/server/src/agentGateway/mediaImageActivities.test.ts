import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MossConversationImageObservation } from "../mossMediaJobsService";
import { conversationImageActivityCommands } from "./mediaImageActivities";

const observation: MossConversationImageObservation = {
  accountScope: "a".repeat(64),
  origin: { threadId: "thread-1", turnId: "turn-original" },
  outputs: [],
  projectionFailed: false,
  snapshot: {
    success: true,
    jobId: "moss_job_1",
    projectId: "thread:thread-1",
    createdAt: "2026-10-14T00:00:00.000Z",
    prompt: "PRIVATE_PROMPT",
    modelId: "seedream-5-0",
    operation: "text_to_image",
    status: "queued",
    imageUrls: [],
    videoUrls: [],
    persistenceStatus: "pending",
    billingStatus: "pending",
    errorCategory: "none",
    retryCount: 0,
  },
};

describe("conversation image activities", () => {
  it("replays one stable pending command per job, independent of polling revision or billing", () => {
    const pending = conversationImageActivityCommands(observation);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: "thread-1",
      activity: {
        kind: "tool.started",
        turnId: "turn-original",
        payload: { itemType: "image_generation", status: "inProgress" },
      },
    });
    expect(
      conversationImageActivityCommands({
        ...observation,
        snapshot: {
          ...observation.snapshot,
          status: "running",
          revision: 12,
          billingStatus: "unknown",
        },
      }),
    ).toEqual(pending);
  });

  it("emits one local-file artifact per output and keeps complete replay commands identical", () => {
    const completed: MossConversationImageObservation = {
      ...observation,
      outputs: [
        { index: 0, path: resolve("canvas-assets/first.png") },
        { index: 1, path: resolve("canvas-assets/second.png") },
      ],
      snapshot: {
        ...observation.snapshot,
        status: "succeeded",
        persistenceStatus: "ready",
        imageUrls: ["https://supplier.invalid/SECRET_OUTPUT"],
        metadata: { token: "SECRET_TOKEN" },
      },
    };
    const commands = conversationImageActivityCommands(completed);
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(2);
    expect(commands[0]).toMatchObject({
      activity: {
        kind: "tool.completed",
        payload: {
          status: "completed",
          data: {
            kind: "moss.generated_image",
            jobId: "moss_job_1",
            outputIndex: 0,
            path: completed.outputs[0]!.path,
          },
        },
      },
    });
    expect(
      conversationImageActivityCommands({
        ...completed,
        snapshot: {
          ...completed.snapshot,
          revision: 25,
          billingStatus: "captured",
        },
      }),
    ).toEqual(commands);
    const encoded = JSON.stringify(commands);
    for (const secret of ["PRIVATE_PROMPT", "SECRET_OUTPUT", "SECRET_TOKEN", "https://"])
      expect(encoded).not.toContain(secret);
  });

  it.each(["failed_terminal", "reconciliation_required", "succeeded"] as const)(
    "settles the placeholder without inventing success for %s with no saved file",
    (status) => {
      const commands = conversationImageActivityCommands({
        ...observation,
        snapshot: {
          ...observation.snapshot,
          status,
          imageUrls: ["https://supplier.invalid/result.png"],
        },
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        activity: {
          kind: "tool.completed",
          tone: "error",
          payload: {
            status: "failed",
            data: { kind: "moss.image_generation.failure", jobStatus: status },
          },
        },
      });
      expect(JSON.stringify(commands)).not.toContain("https://");
    },
  );

  it("scopes identities to the owning account and rejects inconsistent thread/video origins", () => {
    const own = conversationImageActivityCommands(observation);
    expect(
      conversationImageActivityCommands({ ...observation, accountScope: "b".repeat(64) })[0]
        ?.commandId,
    ).not.toBe(own[0]?.commandId);
    for (const change of [
      { accountScope: "not-an-account-scope" },
      { origin: { ...observation.origin, threadId: "other-thread" } },
      { snapshot: { ...observation.snapshot, operation: "video" as const } },
    ])
      expect(conversationImageActivityCommands({ ...observation, ...change })).toEqual([]);
  });
});
