import { TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { makeActivity } from "./storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "./workLog";
import {
  groupGeneratedImagesByTurn,
  omitGeneratedImageWorkEntries,
} from "./components/chat/MessagesTimeline.logic";
import { parseImageGenerationCompletionActivity } from "./components/chat/imageGenerationLimit.logic";

const pending = makeActivity({
  id: "moss-image-start",
  kind: "tool.started",
  turnId: "turn-image",
  sequence: 1,
  payload: { itemType: "image_generation", status: "inProgress", data: { callId: "job:0" } },
});
const completed = makeActivity({
  id: "moss-image-done",
  kind: "tool.completed",
  turnId: "turn-image",
  sequence: 2,
  payload: {
    itemType: "image_generation",
    status: "completed",
    data: {
      kind: "moss.generated_image",
      path: "/workspace/.moss/canvas/image.png",
      callId: "job:0",
      jobId: "moss_image_job",
      outputIndex: 0,
    },
  },
});
const failed = makeActivity({
  id: "moss-image-failed",
  kind: "tool.completed",
  turnId: "turn-image",
  sequence: 2,
  tone: "error",
  payload: {
    itemType: "image_generation",
    status: "failed",
    data: {
      kind: "moss.image_generation.failure",
      callId: "job:0",
      jobId: "moss_image_job",
      jobStatus: "reconciliation_required",
      errorCode: "media_outcome_unknown",
    },
  },
});
const live = { activeTurnId: TurnId.makeUnsafe("turn-image"), latestTurnState: "running" as const };

describe("official media transcript lifecycle", () => {
  it("replaces the pending item with a durable gallery image without any assistant Markdown", () => {
    const entries = deriveWorkLogEntries([pending, completed], undefined, live);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.generatedImage).toEqual({
      state: "completed",
      path: "/workspace/.moss/canvas/image.png",
      callId: "job:0",
    });
    const gallery = groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).get(
      "turn-image",
    );
    expect(gallery).toMatchObject({
      pendingImageCount: 0,
      images: [{ id: "job:0", path: "/workspace/.moss/canvas/image.png" }],
    });
    expect(deriveWorkLogEntries([completed], undefined)[0]?.generatedImage?.state).toBe(
      "completed",
    );
  });

  it("removes the spinner and retains a visible error for terminal or uncertain outcomes", () => {
    const entries = deriveWorkLogEntries([pending, failed], undefined, live);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      generatedImage: { state: "failed", callId: "job:0" },
      toolStatus: "failed",
    });
    expect(groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).size).toBe(0);
    expect(omitGeneratedImageWorkEntries(entries)).toEqual(entries);
    // Pagination/replay can hand the timeline independent lifecycle records.
    const unmerged = [
      ...deriveWorkLogEntries([pending], undefined, live),
      ...deriveWorkLogEntries([failed], undefined, live),
      ...deriveWorkLogEntries([pending], undefined, live),
    ];
    expect(groupGeneratedImagesByTurn(deriveTimelineEntries([], [], unmerged)).size).toBe(0);
  });

  it("replaces a recoverable missing-file failure when the same saved job becomes available", () => {
    const recovered = makeActivity({
      ...completed,
      id: "moss-recovered",
      sequence: 3,
      turnId: "turn-image",
    });
    const entries = deriveWorkLogEntries([pending, failed, recovered], undefined, live);
    const gallery = groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).get(
      "turn-image",
    );
    expect(gallery?.pendingImageCount).toBe(0);
    expect(gallery?.images).toHaveLength(1);
    expect(entries.filter((entry) => entry.generatedImage?.state === "failed")).toEqual([]);
  });

  it("keeps distinct outputs together and ignores stale starts after a completed replay", () => {
    const second = makeActivity({
      ...completed,
      id: "moss-second-done",
      turnId: "turn-image",
      sequence: 3,
      payload: {
        itemType: "image_generation",
        status: "completed",
        data: {
          kind: "moss.generated_image",
          path: "/workspace/.moss/canvas/second.png",
          callId: "job:1",
          jobId: "moss_image_job",
          outputIndex: 1,
        },
      },
    });
    const stale = makeActivity({
      ...pending,
      id: "moss-stale-start",
      turnId: "turn-image",
      sequence: 4,
    });
    const entries = deriveWorkLogEntries([pending, completed, second, stale], undefined, live);
    const gallery = groupGeneratedImagesByTurn(deriveTimelineEntries([], [], entries)).get(
      "turn-image",
    );
    expect(gallery?.images).toHaveLength(2);
    expect(gallery?.pendingImageCount).toBe(0);
  });

  it("never promotes a plain MCP JSON output, arbitrary kind or Markdown into an image", () => {
    const ordinary = makeActivity({
      id: "ordinary-mcp",
      kind: "tool.completed",
      turnId: "turn-image",
      payload: {
        itemType: "mcp_tool_call",
        data: { kind: "moss.generated_image", path: "/tmp/false.png" },
      },
    });
    const lookalike = makeActivity({
      id: "lookalike",
      kind: "tool.completed",
      turnId: "turn-image",
      payload: {
        itemType: "image_generation",
        detail: "![Image](/tmp/false.png)",
        data: { kind: "arbitrary", path: "/tmp/false.png" },
      },
    });
    expect(
      deriveWorkLogEntries([ordinary, lookalike], undefined).every(
        (entry) => !entry.generatedImage,
      ),
    ).toBe(true);
  });

  it("does not clear a Codex account's own image quota limit with a Moss supplier result", () => {
    const moss = makeActivity({
      ...completed,
      sequence: completed.sequence ?? 1,
      turnId: "turn-image",
      payload: {
        ...(completed.payload as Record<string, unknown>),
        providerInstanceId: "codex-personal",
      },
    });
    expect(parseImageGenerationCompletionActivity(moss, "thread-image")).toBeNull();
  });
});
