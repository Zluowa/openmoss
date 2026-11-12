import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MossConversationImageObservation } from "../mossMediaJobsService";
import {
  conversationImageActivityCommands,
  requestedImageAspectRatio,
} from "./mediaImageActivities";

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
  it("gives the pending placeholder the requested image shape", () => {
    const [pending] = conversationImageActivityCommands({
      ...observation,
      requestedShape: { aspectRatio: "16:9" },
    });
    expect(pending).toMatchObject({
      activity: { payload: { data: { jobId: "moss_job_1", aspectRatio: 1.7778 } } },
    });
    const [square] = conversationImageActivityCommands(observation);
    expect(square).toMatchObject({ activity: { payload: { data: { jobId: "moss_job_1" } } } });
    expect(JSON.stringify(square)).not.toContain("aspectRatio");
  });

  it("reads ratios and sizes, and ignores shapes a chat cannot draw", () => {
    expect(requestedImageAspectRatio({ aspectRatio: "3:4" })).toBe(0.75);
    expect(requestedImageAspectRatio({ resolution: "1536x1024" })).toBe(1.5);
    expect(requestedImageAspectRatio({ aspectRatio: "auto", resolution: "1024*1024" })).toBe(1);
    expect(requestedImageAspectRatio({ aspectRatio: "1:9" })).toBeUndefined();
    expect(requestedImageAspectRatio({ resolution: "2K" })).toBeUndefined();
    expect(requestedImageAspectRatio(undefined)).toBeUndefined();
  });

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

  it("gives a video the same lifecycle: a video placeholder, then a playable video, or a failure", () => {
    const video: MossConversationImageObservation = {
      ...observation,
      snapshot: {
        ...observation.snapshot,
        operation: "video",
        modelId: "doubao-seedance-2.0-fast",
      },
      requestedShape: { aspectRatio: "16:9" },
    };
    const [pending] = conversationImageActivityCommands(video);
    expect(pending).toMatchObject({
      activity: {
        kind: "tool.started",
        summary: "Generating video",
        payload: {
          itemType: "image_generation",
          status: "inProgress",
          data: { jobId: "moss_job_1", media: "video", aspectRatio: 1.7778 },
        },
      },
    });
    const path = `/api/moss/media/assets/moss_job_1/0?accountScope=${"a".repeat(64)}`;
    const [finished] = conversationImageActivityCommands({
      ...video,
      outputs: [{ index: 0, path }],
      snapshot: { ...video.snapshot, status: "succeeded", persistenceStatus: "ready" },
    });
    expect(finished).toMatchObject({
      activity: {
        kind: "tool.completed",
        summary: "Generated video",
        payload: {
          status: "completed",
          data: { kind: "moss.generated_video", media: "video", path },
        },
      },
    });
    // The finished video settles the same placeholder identity.
    const callIdOf = (command: unknown) =>
      (command as { activity: { payload: { data: { callId: string } } } }).activity.payload.data
        .callId;
    expect(callIdOf(finished)).toBe(callIdOf(pending));
    const [failed] = conversationImageActivityCommands({
      ...video,
      snapshot: { ...video.snapshot, status: "failed_terminal" },
    });
    expect(failed).toMatchObject({
      activity: {
        tone: "error",
        payload: {
          status: "failed",
          data: { kind: "moss.image_generation.failure", media: "video" },
        },
      },
    });
    // Images keep their exact commands (no new field), so earlier replays still match.
    expect(JSON.stringify(conversationImageActivityCommands(observation))).not.toContain("media");
  });

  it("scopes identities to the owning account and rejects inconsistent thread origins", () => {
    const own = conversationImageActivityCommands(observation);
    expect(
      conversationImageActivityCommands({ ...observation, accountScope: "b".repeat(64) })[0]
        ?.commandId,
    ).not.toBe(own[0]?.commandId);
    for (const change of [
      { accountScope: "not-an-account-scope" },
      { origin: { ...observation.origin, threadId: "other-thread" } },
    ])
      expect(conversationImageActivityCommands({ ...observation, ...change })).toEqual([]);
  });
});
