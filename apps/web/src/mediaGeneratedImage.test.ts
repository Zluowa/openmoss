import { TurnId } from "@moss/contracts";
import { describe, expect, it } from "vitest";
import { makeActivity } from "./storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "./workLog";
import {
  deriveMessagesTimelineRows,
  groupGeneratedImagesByTurn,
  omitGeneratedImageWorkEntries,
} from "./components/chat/MessagesTimeline.logic";
import {
  generatedImagePendingStage,
  generatedVideoWaited,
} from "./components/chat/GeneratedImageGallery";
import { isMossMediaJobToolCall, isMossMediaToolSearch } from "./lib/toolCallLabel";
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
const workRows = (rows: ReturnType<typeof deriveMessagesTimelineRows>) =>
  rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));

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

  describe("one image card for a Moss image call, like Codex", () => {
    const tool = (
      id: string,
      sequence: number,
      kind: "tool.started" | "tool.completed",
      title: string,
      data: Record<string, string | Record<string, string>>,
      tone: "tool" | "error" = "tool",
    ) =>
      makeActivity({
        id,
        kind,
        sequence,
        tone,
        turnId: "turn-image",
        summary: title,
        payload: {
          itemType: "dynamic_tool_call",
          status:
            kind === "tool.started" ? "inProgress" : tone === "error" ? "failed" : "completed",
          title,
          detail: title,
          data,
        },
      });
    // Grok in the owner's run: a tool search, then use_tool wrapping moss__moss_media_generate.
    const grokCalls = [
      tool("search-1", 1, "tool.started", "search_tool", {
        toolCallId: "call-search",
        rawInput: { query: "moss media generate image" },
      }),
      tool("search-2", 2, "tool.started", 'Search tools: "moss media generate image"', {
        toolCallId: "call-search",
      }),
      tool("search-3", 3, "tool.completed", 'Search tools: "moss media generate image"', {
        toolCallId: "call-search",
      }),
      tool("use-1", 4, "tool.started", "use_tool", { toolCallId: "call-use" }),
      tool("use-2", 5, "tool.started", "moss__moss_media_generate", { toolCallId: "call-use" }),
      tool("use-3", 6, "tool.completed", "moss__moss_media_generate", { toolCallId: "call-use" }),
    ];
    // Pi in the owner's run: the bare tool name.
    const piCalls = [
      tool("pi-1", 1, "tool.started", "moss_media_generate", { toolCallId: "call-pi" }),
      tool("pi-2", 6, "tool.completed", "moss_media_generate", { toolCallId: "call-pi" }),
    ];
    const shaped = makeActivity({
      id: "moss-image-start",
      kind: "tool.started",
      turnId: "turn-image",
      sequence: 7,
      payload: {
        itemType: "image_generation",
        status: "inProgress",
        data: { callId: "job:0", jobId: "moss_image_job", aspectRatio: 1.5 },
      },
    });
    const finished = makeActivity({ ...completed, turnId: "turn-image", sequence: 8 });
    const rowsFor = (activities: ReturnType<typeof makeActivity>[]) => {
      const entries = deriveWorkLogEntries(activities, undefined, live);
      return deriveMessagesTimelineRows({
        isWorking: true,
        activeTurnInProgress: true,
        activeTurnId: TurnId.makeUnsafe("turn-image"),
        worktreeSetup: null,
        worktreeSetupOpen: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
        timelineEntries: deriveTimelineEntries([], [], entries),
      });
    };

    it("shows only the shaped placeholder while the image is generating", () => {
      for (const calls of [grokCalls, piCalls]) {
        const rows = rowsFor([...calls, shaped]);
        expect(rows.find((row) => row.kind === "generated-image-gallery")).toMatchObject({
          gallery: { pendingImageCount: 1, pendingAspectRatio: 1.5 },
        });
        expect(workRows(rows)).toEqual([]);
      }
    });

    it("shows only the finished image once it is ready", () => {
      const rows = rowsFor([...grokCalls, shaped, finished]);
      expect(rows.find((row) => row.kind === "generated-image-gallery")).toMatchObject({
        gallery: { pendingImageCount: 0, images: [{ id: "job:0" }] },
      });
      expect(workRows(rows)).toEqual([]);
    });

    it("keeps the tool rows when there is no image to show, and keeps a failed call", () => {
      expect(workRows(rowsFor(piCalls)).length).toBeGreaterThan(0);
      const failedCall = tool(
        "pi-fail",
        9,
        "tool.completed",
        "moss_media_generate",
        { toolCallId: "call-pi-2" },
        "error",
      );
      expect(workRows(rowsFor([...piCalls, shaped, finished, failedCall]))).toHaveLength(1);
    });

    // OpenCode in the owner's run (2026-11-11): its code runner `execute`, first a
    // tool search script, then a script that calls moss_media_generate.
    const codeTool = (
      id: string,
      sequence: number,
      kind: "tool.started" | "tool.completed",
      callId: string,
      code: string,
    ) =>
      makeActivity({
        id,
        kind,
        sequence,
        tone: "tool",
        turnId: "turn-image",
        summary: "execute",
        payload: {
          itemType: "dynamic_tool_call",
          status: kind === "tool.started" ? "inProgress" : "completed",
          title: "execute",
          data: { tool: "execute", toolName: "execute", toolCallId: callId, input: { code } },
        },
      });
    const searchCode =
      'const r = await search({query: "media generate image", namespace: "moss"});\nreturn r;';
    const generateCode =
      'const r = await tools.moss.moss_media_generate({\n  modelId: "gpt-image-2.5-flare",\n  prompt: "hedgehog"\n});\nreturn r;';
    const openCodeCalls = [
      codeTool("oc-1", 1, "tool.started", "call-oc-search", searchCode),
      codeTool("oc-2", 2, "tool.completed", "call-oc-search", searchCode),
      codeTool("oc-3", 3, "tool.started", "call-oc-generate", generateCode),
      codeTool("oc-4", 4, "tool.completed", "call-oc-generate", generateCode),
    ];

    it("reads OpenCode's code runner as the tool it calls, never as Execute", () => {
      const entries = deriveWorkLogEntries(openCodeCalls, undefined, live);
      expect(entries.map((entry) => entry.toolName)).toContain("moss_media_generate");
      expect(entries.some((entry) => /^search tools/iu.test(entry.toolTitle ?? ""))).toBe(true);
      expect(JSON.stringify(entries)).not.toMatch(/"toolTitle":"[Ee]xecute"/u);
      // Once the image is there, the search and the call are plumbing, as for Grok and Pi.
      expect(workRows(rowsFor([...openCodeCalls, shaped, finished]))).toEqual([]);
      // A script that is neither one call nor one search says it ran code.
      const both = deriveWorkLogEntries(
        [codeTool("oc-5", 5, "tool.completed", "call-oc-both", `${searchCode}\n${generateCode}`)],
        undefined,
        live,
      );
      expect(both[0]?.toolTitle).toBe("Ran code");
    });

    it("recognises each agent's spelling of the media tools and nothing else", () => {
      for (const name of [
        "moss_media_generate",
        "moss__moss_media_generate",
        "mcp__moss__moss_media_generate",
        "moss_media_get",
      ])
        expect(isMossMediaJobToolCall(name), name).toBe(true);
      for (const name of ["moss_media_list", "moss_canvas_open", "use_tool", "media_generate"])
        expect(isMossMediaJobToolCall(name), name).toBe(false);
      expect(isMossMediaToolSearch({ label: 'Search tools: "moss media generate image"' })).toBe(
        true,
      );
      expect(isMossMediaToolSearch({ label: 'Search tools: "browser"' })).toBe(false);
    });

    it("moves the caption on as the wait grows", () => {
      const start = "2026-11-10T08:00:00.000Z";
      const at = (seconds: number) => Date.parse(start) + seconds * 1000;
      expect([0, 9, 10, 25, 31, 60].map((s) => generatedImagePendingStage(start, at(s)))).toEqual([
        0, 0, 1, 2, 3, 4,
      ]);
      expect(generatedImagePendingStage("not a date", at(60))).toBe(0);
    });
  });
});

describe("official video transcript lifecycle", () => {
  const videoTurn = {
    activeTurnId: TurnId.makeUnsafe("turn-video"),
    latestTurnState: "running" as const,
  };
  const videoPending = makeActivity({
    id: "moss-video-start",
    kind: "tool.started",
    turnId: "turn-video",
    sequence: 1,
    payload: {
      itemType: "image_generation",
      status: "inProgress",
      data: {
        jobId: "moss_video_job",
        media: "video",
        aspectRatio: 1.7778,
        callId: "moss-image:v:0",
      },
    },
  });
  const videoPath = `/api/moss/media/assets/moss_video_job/0?accountScope=${"a".repeat(64)}`;
  const videoDone = makeActivity({
    id: "moss-video-done",
    kind: "tool.completed",
    turnId: "turn-video",
    sequence: 9,
    payload: {
      itemType: "image_generation",
      status: "completed",
      data: {
        kind: "moss.generated_video",
        media: "video",
        path: videoPath,
        callId: "moss-image:v:0",
        jobId: "moss_video_job",
        outputIndex: 0,
      },
    },
  });

  it("shows a video placeholder that knows its job, then the video in its place", () => {
    const waiting = deriveWorkLogEntries([videoPending], undefined, videoTurn);
    expect(waiting[0]?.generatedImage).toEqual({
      state: "pending",
      callId: "moss-image:v:0",
      aspectRatio: 1.7778,
      media: "video",
      jobId: "moss_video_job",
    });
    expect(
      groupGeneratedImagesByTurn(deriveTimelineEntries([], [], waiting)).get("turn-video"),
    ).toMatchObject({
      images: [],
      pendingImageCount: 1,
      pendingMedia: "video",
      pendingJobIds: ["moss_video_job"],
    });
    // The video lands minutes later, after the turn's answer: same turn, same item.
    const done = deriveWorkLogEntries([videoPending, videoDone], undefined);
    expect(done).toHaveLength(1);
    expect(done[0]?.generatedImage).toEqual({
      state: "completed",
      path: videoPath,
      callId: "moss-image:v:0",
      media: "video",
    });
    const gallery = groupGeneratedImagesByTurn(deriveTimelineEntries([], [], done)).get(
      "turn-video",
    );
    expect(gallery).toMatchObject({
      pendingImageCount: 0,
      images: [{ id: "moss-image:v:0", path: videoPath, media: "video" }],
    });
    expect(gallery?.pendingJobIds).toBeUndefined();
  });

  it("counts the wait in minutes and seconds", () => {
    const start = "2026-11-12T12:20:00.000Z";
    expect(generatedVideoWaited(start, Date.parse(start) + 358_400)).toEqual({
      minutes: 5,
      seconds: 58,
    });
    expect(generatedVideoWaited(start, Date.parse(start) - 5_000)).toEqual({
      minutes: 0,
      seconds: 0,
    });
    expect(generatedVideoWaited("not a time", 0)).toEqual({ minutes: 0, seconds: 0 });
  });
});
