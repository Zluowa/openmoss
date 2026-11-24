import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as { threadId: string; payload: Record<string, unknown> }[]);
const opened = vi.hoisted(() => [] as { threadId: string; kind: string }[]);

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    orchestration: {
      dispatchCommand: async (command: {
        threadId: string;
        activity: { payload: Record<string, unknown> };
      }) => {
        sent.push({ threadId: command.threadId, payload: command.activity.payload });
        return { sequence: 1 };
      },
    },
  }),
}));
vi.mock("~/rightDockStore", () => ({
  useRightDockStore: {
    getState: () => ({
      openPane: (threadId: string, input: { kind: string }) =>
        opened.push({ threadId, kind: input.kind }),
    }),
  },
}));

const {
  answerCanvasOpsRequest,
  canvasOpsDone,
  canvasOpsRequest,
  releaseCanvasAfterStorageWrite,
  resetCanvasAgentOpsForTests,
} = await import("./canvasAgentOps");
const { isMossCanvasLoadHeld, noteMossCanvasMounted, registerMossCanvasLiveEditor } =
  await import("~/lib/mossCanvasLiveEditors");

const request = {
  requestId: "canvas-ops:1",
  ops: [{ op: "addNote", text: "代理写入" }],
  turnId: null,
};
const statuses = () => sent.map((entry) => entry.payload.status);

describe("the window answers an agent's 画布 edit", () => {
  beforeEach(() => {
    sent.length = 0;
    opened.length = 0;
    resetCanvasAgentOpsForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("reads only the gateway's request", () => {
    expect(
      canvasOpsRequest({
        kind: "canvas.ops.requested",
        payload: { source: "moss-mcp-canvas", requestId: "canvas-ops:1", ops: [{ op: "clear" }] },
      }),
    ).toEqual({ requestId: "canvas-ops:1", ops: [{ op: "clear" }], turnId: null });
    expect(
      canvasOpsRequest({
        kind: "canvas.ops.requested",
        payload: { source: "page", requestId: "canvas-ops:1", ops: [{ op: "clear" }] },
      }),
    ).toBeNull();
    expect(
      canvasOpsRequest({
        kind: "canvas.ops.requested",
        payload: { source: "moss-mcp-canvas", requestId: "canvas-ops:1", ops: [] },
      }),
    ).toBeNull();
  });

  it("applies it in the open editor and reports what it made, once per request", async () => {
    const apply = vi.fn(async () => ({ ok: true, created: { n: "shape:n" }, shapes: [] }));
    const unregister = registerMossCanvasLiveEditor("thread-a", { apply });
    try {
      await answerCanvasOpsRequest({ threadId: "thread-a", request, onScreen: false });
      await answerCanvasOpsRequest({ threadId: "thread-a", request, onScreen: false });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(statuses()).toEqual(["accepted", "applied"]);
      expect(sent[1]!.payload.result).toMatchObject({ created: { n: "shape:n" } });
    } finally {
      unregister();
    }
  });

  it("says no editor when its chat is not on screen, and holds a 画布 that opens until the write ends", async () => {
    await answerCanvasOpsRequest({ threadId: "thread-b", request, onScreen: false });
    expect(statuses()).toEqual(["no-editor"]);
    expect(opened).toEqual([]);
    // A 画布 opened now waits, so it loads the agent's edit rather than saving over it.
    expect(isMossCanvasLoadHeld("thread-b")).toBe(true);
    const done = canvasOpsDone({
      kind: "canvas.ops.done",
      payload: { source: "moss-mcp-canvas", requestId: request.requestId },
    });
    expect(done).toBe(request.requestId);
    releaseCanvasAfterStorageWrite("thread-b", done!);
    expect(isMossCanvasLoadHeld("thread-b")).toBe(false);
  });

  it("waits for a 画布 that is still loading instead of having storage written under it", async () => {
    const unmount = noteMossCanvasMounted("thread-e");
    try {
      const answering = answerCanvasOpsRequest({ threadId: "thread-e", request, onScreen: false });
      await vi.waitFor(() => expect(statuses()).toEqual(["accepted"]));
      expect(opened).toEqual([]);
      const unregister = registerMossCanvasLiveEditor("thread-e", {
        apply: async () => ({ ok: true, created: {}, saved: false }),
      });
      try {
        await answering;
        expect(statuses()).toEqual(["accepted", "applied"]);
        // Drawn but not saved yet: reported as applied, never as a failure to retry.
        expect(sent[1]!.payload.result).toMatchObject({ saved: false });
      } finally {
        unregister();
      }
    } finally {
      unmount();
    }
  });

  it("opens the 画布 beside the chat on screen, then applies it there", async () => {
    const apply = vi.fn(async () => ({ ok: true, created: {} }));
    const answering = answerCanvasOpsRequest({ threadId: "thread-c", request, onScreen: true });
    await vi.waitFor(() => expect(opened).toEqual([{ threadId: "thread-c", kind: "canvas" }]));
    const unregister = registerMossCanvasLiveEditor("thread-c", { apply });
    try {
      await answering;
      expect(statuses()).toEqual(["accepted", "applied"]);
    } finally {
      unregister();
    }
  });

  it("opens the 画布 once per turn: after the person closes it, later edits of that turn stay off screen", async () => {
    const apply = vi.fn(async () => ({ ok: true, created: {} }));
    const edit = (requestId: string, turnId: string) => ({ ...request, requestId, turnId });
    // First edit of turn A opens it beside the chat and applies there.
    const first = answerCanvasOpsRequest({
      threadId: "thread-t",
      request: edit("canvas-ops:a1", "turn-a"),
      onScreen: true,
    });
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    let unregister = registerMossCanvasLiveEditor("thread-t", { apply });
    await first;
    // The person closes it.
    unregister();
    await answerCanvasOpsRequest({
      threadId: "thread-t",
      request: edit("canvas-ops:a2", "turn-a"),
      onScreen: true,
    });
    expect(opened).toHaveLength(1);
    expect(statuses()).toEqual(["accepted", "applied", "no-editor"]);
    // The next turn's first edit opens it again.
    const next = answerCanvasOpsRequest({
      threadId: "thread-t",
      request: edit("canvas-ops:b1", "turn-b"),
      onScreen: true,
    });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    unregister = registerMossCanvasLiveEditor("thread-t", { apply });
    try {
      await next;
      expect(statuses()).toEqual(["accepted", "applied", "no-editor", "accepted", "applied"]);
    } finally {
      unregister();
    }
  });

  it("keeps a 画布 that was open before the turn closed once the person closes it mid-turn", async () => {
    const apply = vi.fn(async () => ({ ok: true, created: {} }));
    const edit = (requestId: string, turnId: string) => ({ ...request, requestId, turnId });
    // The person had the 画布 open already: the turn's first edit applies there.
    const unregister = registerMossCanvasLiveEditor("thread-o", { apply });
    await answerCanvasOpsRequest({
      threadId: "thread-o",
      request: edit("canvas-ops:o1", "turn-o"),
      onScreen: true,
    });
    // The person closes it.
    unregister();
    await answerCanvasOpsRequest({
      threadId: "thread-o",
      request: edit("canvas-ops:o2", "turn-o"),
      onScreen: true,
    });
    expect(opened).toEqual([]);
    expect(statuses()).toEqual(["accepted", "applied", "no-editor"]);
  });

  it("passes the editor's refusal on without falling back", async () => {
    const unregister = registerMossCanvasLiveEditor("thread-d", {
      apply: async () => ({ ok: false, errorCode: "canvas_ops_invalid" }),
    });
    try {
      await answerCanvasOpsRequest({ threadId: "thread-d", request, onScreen: true });
      expect(statuses()).toEqual(["accepted", "failed"]);
      expect(sent[1]!.payload.errorCode).toBe("canvas_ops_invalid");
    } finally {
      unregister();
    }
  });
});
