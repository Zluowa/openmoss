// FILE: boardRooms.test.ts
// Purpose: Tests for pure-TS live 白板 rooms (peer identity, rich presence, ops relay,
//          record-level delta merge, shared AI claims + disconnect cleanup, workshop timer,
//          emoji sticker votes, snapshot save debounce, and conflict sync).

import {
  createBoardCanvasDocument,
  type BoardCanvasDocument,
  type BoardCanvasRecord,
} from "@moss/shared/spaceItems/boardCanvas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardRooms, type BoardRoomServerMessage } from "./boardRooms";

function makeClient(
  sessionId: string,
  readOnly = false,
  extra?: { name?: string; color?: string },
) {
  const sent: BoardRoomServerMessage[] = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    conn: {
      sessionId,
      readOnly,
      ...(extra?.name ? { name: extra.name } : {}),
      ...(extra?.color ? { color: extra.color } : {}),
      send: (payload: string) => sent.push(JSON.parse(payload) as BoardRoomServerMessage),
      close: () => {
        closed = true;
      },
    },
  };
}

describe("BoardRooms", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays presence and ops across peers and debounces validated saves", async () => {
    vi.useFakeTimers();
    let revision = 3;
    const initial = JSON.stringify({
      version: 2,
      storage: "isolated",
      canvasProjectKey: "proj-1",
      note: "Initial",
    });
    let savedData = initial;
    const saves: Array<{ data: string; expectedRevision: number }> = [];

    const rooms = new BoardRooms({
      read: async () => ({ data: savedData, revision }),
      save: async (_pageId, _scope, data, expectedRevision) => {
        saves.push({ data, expectedRevision });
        revision += 1;
        savedData = data;
        return revision;
      },
    });

    const a = makeClient("sess-a");
    const b = makeClient("sess-b");
    const leaveA = await rooms.join("board-1", null, a.conn);
    const leaveB = await rooms.join("board-1", null, b.conn);

    expect(a.sent[0]).toMatchObject({ type: "welcome", pageId: "board-1", revision: 3 });
    expect(b.sent[0]).toMatchObject({ type: "welcome", pageId: "board-1", revision: 3 });

    rooms.handleMessage(
      "board-1",
      "sess-a",
      JSON.stringify({ type: "presence", presence: { cursor: { x: 10, y: 20 } } }),
    );
    expect(b.sent.at(-1)).toEqual({
      type: "presence",
      sessionId: "sess-a",
      presence: { cursor: { x: 10, y: 20 } },
    });

    rooms.handleMessage(
      "board-1",
      "sess-a",
      JSON.stringify({ type: "ops", ops: [{ op: "addNote", text: "Hello" }] }),
    );
    expect(b.sent.at(-1)).toMatchObject({
      type: "ops",
      sessionId: "sess-a",
      ops: [{ op: "addNote", text: "Hello" }],
    });

    rooms.handleMessage(
      "board-1",
      "sess-a",
      JSON.stringify({ type: "note", note: "Updated note" }),
    );
    expect(saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(650);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.expectedRevision).toBe(3);
    expect(JSON.parse(saves[0]!.data)).toMatchObject({
      note: "Updated note",
      canvasProjectKey: "proj-1",
    });
    expect(a.sent.at(-1)).toEqual({ type: "saved", revision: 4 });

    leaveA();
    expect(b.sent.at(-1)).toEqual({ type: "presence", sessionId: "sess-a", presence: null });
    leaveB();
    await rooms.dispose();
  });

  it("rejects edits from read-only clients and handles v2 board snapshots", async () => {
    const doc = createBoardCanvasDocument();
    const rooms = new BoardRooms({
      read: async () => ({ data: JSON.stringify(doc), revision: 1 }),
      save: async () => 2,
    });
    const viewer = makeClient("viewer-1", true);
    await rooms.join("board-2", "space-1", viewer.conn);
    rooms.handleMessage(
      "board-2",
      "viewer-1",
      JSON.stringify({ type: "ops", ops: [{ op: "addNote", text: "Denied" }] }),
    );
    expect(viewer.sent.at(-1)).toMatchObject({ type: "error", code: "read_only" });

    rooms.handleMessage(
      "board-2",
      "viewer-1",
      JSON.stringify({
        type: "records",
        added: { "shape:denied": { id: "shape:denied", typeName: "shape", type: "note" } },
        updated: {},
        removed: [],
      }),
    );
    expect(viewer.sent.at(-1)).toMatchObject({ type: "error", code: "read_only" });

    // Read-only clients can still identify themselves and share cursor presence.
    rooms.handleMessage(
      "board-2",
      "viewer-1",
      JSON.stringify({ type: "hello", name: "旁观者", color: "#2b72d6" }),
    );
    expect(viewer.sent.at(-1)).toMatchObject({
      type: "peers",
      peers: [{ sessionId: "viewer-1", name: "旁观者", color: "#2b72d6", readOnly: true }],
    });
    await rooms.dispose();
  });

  it("merges multi-peer record deltas without clobbering and supports shapes, bindings, assets, and comments", async () => {
    vi.useFakeTimers();
    let revision = 1;
    let savedData = JSON.stringify(createBoardCanvasDocument());
    const saves: string[] = [];

    const rooms = new BoardRooms({
      read: async () => ({ data: savedData, revision }),
      save: async (_pageId, _scope, data) => {
        saves.push(data);
        revision += 1;
        savedData = data;
        return revision;
      },
    });

    const a = makeClient("peer-a");
    const b = makeClient("peer-b");
    await rooms.join("board-crdt", null, a.conn);
    await rooms.join("board-crdt", null, b.conn);

    const shapeA: BoardCanvasRecord = {
      id: "shape:noteA",
      typeName: "shape",
      type: "note",
      parentId: "page:page",
      x: 100,
      y: 120,
      props: { text: "Peer A note" },
    };
    const commentA: BoardCanvasRecord = {
      id: "comment:c1",
      typeName: "comment",
      threadId: "comment-thread:t1",
      pageId: "page:page",
      body: { type: "doc", content: [] },
    };
    const shapeB: BoardCanvasRecord = {
      id: "shape:noteB",
      typeName: "shape",
      type: "note",
      parentId: "page:page",
      x: 420,
      y: 120,
      props: { text: "Peer B note" },
    };
    const bindingB: BoardCanvasRecord = {
      id: "binding:b1",
      typeName: "binding",
      type: "arrow",
      fromId: "shape:arrow1",
      toId: "shape:noteB",
    };
    const assetB: BoardCanvasRecord = {
      id: "asset:img1",
      typeName: "asset",
      type: "image",
      props: { w: 320, h: 200 },
    };

    // Peer A and Peer B edit different records concurrently before debounce save fires.
    rooms.handleMessage(
      "board-crdt",
      "peer-a",
      JSON.stringify({
        type: "records",
        added: { [shapeA.id]: shapeA, [commentA.id]: commentA },
        updated: {},
        removed: [],
      }),
    );
    expect(b.sent.at(-1)).toMatchObject({
      type: "records",
      sessionId: "peer-a",
      added: { "shape:noteA": shapeA, "comment:c1": commentA },
    });

    rooms.handleMessage(
      "board-crdt",
      "peer-b",
      JSON.stringify({
        type: "records",
        added: { [shapeB.id]: shapeB, [bindingB.id]: bindingB, [assetB.id]: assetB },
        updated: {},
        removed: [],
      }),
    );
    expect(a.sent.at(-1)).toMatchObject({
      type: "records",
      sessionId: "peer-b",
      added: { "shape:noteB": shapeB, "binding:b1": bindingB, "asset:img1": assetB },
    });

    // Peer A updates shapeA and removes nothing; Peer B's records remain intact.
    const movedShapeA: BoardCanvasRecord = { ...shapeA, x: 260, y: 180 };
    rooms.handleMessage(
      "board-crdt",
      "peer-a",
      JSON.stringify({
        type: "records",
        added: {},
        updated: { [movedShapeA.id]: movedShapeA },
        removed: [],
      }),
    );

    await vi.advanceTimersByTimeAsync(650);
    expect(saves).toHaveLength(1);
    const persisted = JSON.parse(saves[0]!) as BoardCanvasDocument;
    expect(persisted.snapshot.store["shape:noteA"]).toMatchObject({ x: 260, y: 180 });
    expect(persisted.snapshot.store["comment:c1"]).toBeDefined();
    expect(persisted.snapshot.store["shape:noteB"]).toMatchObject({ x: 420, y: 120 });
    expect(persisted.snapshot.store["binding:b1"]).toBeDefined();
    expect(persisted.snapshot.store["asset:img1"]).toBeDefined();

    // Peer B removes shapeA; Peer B's shape stays intact.
    rooms.handleMessage(
      "board-crdt",
      "peer-b",
      JSON.stringify({
        type: "records",
        added: {},
        updated: {},
        removed: ["shape:noteA"],
      }),
    );
    await vi.advanceTimersByTimeAsync(650);
    const afterRemove = JSON.parse(saves[1]!) as BoardCanvasDocument;
    expect(afterRemove.snapshot.store["shape:noteA"]).toBeUndefined();
    expect(afterRemove.snapshot.store["shape:noteB"]).toBeDefined();

    // Late joiner receives the merged snapshot with Peer B's records intact.
    const c = makeClient("peer-c");
    await rooms.join("board-crdt", null, c.conn);
    const welcomeC = c.sent[0] as Extract<BoardRoomServerMessage, { type: "welcome" }>;
    expect((welcomeC.data as BoardCanvasDocument).snapshot.store["shape:noteB"]).toBeDefined();
    expect(welcomeC.peers.map((p) => p.sessionId)).toEqual(["peer-a", "peer-b", "peer-c"]);

    await rooms.dispose();
  });

  it("relays record deltas on isolated BoardItem rooms and hydrates late joiners via welcome.records", async () => {
    const initial = JSON.stringify({
      version: 2,
      storage: "isolated",
      canvasProjectKey: "proj-iso",
    });
    const saveSpy = vi.fn(async () => 2);
    const rooms = new BoardRooms({
      read: async () => ({ data: initial, revision: 1 }),
      save: saveSpy,
    });

    const a = makeClient("iso-a");
    const b = makeClient("iso-b");
    await rooms.join("board-iso", null, a.conn);
    await rooms.join("board-iso", null, b.conn);

    const shape: BoardCanvasRecord = {
      id: "shape:iso1",
      typeName: "shape",
      type: "geo",
      x: 50,
      y: 60,
    };
    rooms.handleMessage(
      "board-iso",
      "iso-a",
      JSON.stringify({ type: "records", added: { [shape.id]: shape }, updated: {}, removed: [] }),
    );
    expect(b.sent.at(-1)).toMatchObject({
      type: "records",
      sessionId: "iso-a",
      added: { "shape:iso1": shape },
    });

    const c = makeClient("iso-c");
    await rooms.join("board-iso", null, c.conn);
    const welcomeC = c.sent[0] as Extract<BoardRoomServerMessage, { type: "welcome" }>;
    expect(welcomeC.records?.["shape:iso1"]).toMatchObject({ id: "shape:iso1", x: 50, y: 60 });
    expect(saveSpy).not.toHaveBeenCalled();

    await rooms.dispose();
  });

  it("syncs peer identity, rich presence, AI working claims, and cleans up claims on disconnect", async () => {
    const doc = createBoardCanvasDocument();
    const rooms = new BoardRooms({
      read: async () => ({ data: JSON.stringify(doc), revision: 1 }),
      save: async () => 2,
    });

    const a = makeClient("alice");
    const b = makeClient("bob");
    const leaveA = await rooms.join("board-claims", null, a.conn);
    await rooms.join("board-claims", null, b.conn);

    rooms.handleMessage(
      "board-claims",
      "alice",
      JSON.stringify({ type: "hello", name: "林晓", color: "#d97757" }),
    );
    expect(b.sent.at(-1)).toMatchObject({
      type: "peers",
      peers: expect.arrayContaining([
        expect.objectContaining({ sessionId: "alice", name: "林晓", color: "#d97757" }),
      ]),
    });

    rooms.handleMessage(
      "board-claims",
      "alice",
      JSON.stringify({
        type: "presence",
        presence: {
          cursor: { x: 120, y: 240 },
          selected: ["shape:1"],
          view: { x: 0, y: 0, w: 1280, h: 720 },
          tool: "select",
        },
      }),
    );
    expect(b.sent.at(-1)).toEqual({
      type: "presence",
      sessionId: "alice",
      presence: {
        cursor: { x: 120, y: 240 },
        selected: ["shape:1"],
        view: { x: 0, y: 0, w: 1280, h: 720 },
        tool: "select",
      },
    });

    // Alice broadcasts an AI working claim.
    rooms.handleMessage(
      "board-claims",
      "alice",
      JSON.stringify({
        type: "claim",
        claim: {
          id: "ask-1",
          area: { x: 80, y: 90, w: 420, h: 300 },
          word: "绘制架构图",
          authorName: "林晓",
        },
      }),
    );
    expect(b.sent.at(-1)).toMatchObject({
      type: "claim",
      sessionId: "alice",
      claimId: "ask-1",
      claim: {
        id: "ask-1",
        sessionId: "alice",
        area: { x: 80, y: 90, w: 420, h: 300 },
        word: "绘制架构图",
        authorName: "林晓",
      },
    });

    // A third collaborator joining sees the active claim in welcome.claims.
    const c = makeClient("carol");
    await rooms.join("board-claims", null, c.conn);
    const welcomeC = c.sent[0] as Extract<BoardRoomServerMessage, { type: "welcome" }>;
    expect(welcomeC.claims).toHaveLength(1);
    expect(welcomeC.claims[0]).toMatchObject({
      id: "ask-1",
      sessionId: "alice",
      word: "绘制架构图",
    });

    // When Alice disconnects without releasing the claim, the room auto-cleans it and notifies peers.
    const bLenBeforeLeave = b.sent.length;
    leaveA();
    const afterLeave = b.sent.slice(bLenBeforeLeave);
    expect(afterLeave).toContainEqual({
      type: "claim",
      sessionId: "alice",
      claimId: "ask-1",
      claim: null,
    });
    expect(afterLeave.at(-1)).toEqual({ type: "presence", sessionId: "alice", presence: null });

    // A fourth joiner sees no stale claims left behind.
    const d = makeClient("dave");
    await rooms.join("board-claims", null, d.conn);
    const welcomeD = d.sent[0] as Extract<BoardRoomServerMessage, { type: "welcome" }>;
    expect(welcomeD.claims).toEqual([]);

    await rooms.dispose();
  });

  it("syncs shared workshop countdown timer and emoji sticker votes across peers and persists stickers", async () => {
    vi.useFakeTimers();
    let revision = 1;
    let savedData = JSON.stringify(createBoardCanvasDocument());
    const rooms = new BoardRooms({
      read: async () => ({ data: savedData, revision }),
      save: async (_pageId, _scope, data) => {
        revision += 1;
        savedData = data;
        return revision;
      },
    });

    const a = makeClient("host-a", false, { name: "主持人" });
    const b = makeClient("guest-b", false, { name: "参与者" });
    await rooms.join("board-workshop", null, a.conn);
    await rooms.join("board-workshop", null, b.conn);

    // Start 5-minute workshop timer.
    const endsAt = Date.now() + 300_000;
    rooms.handleMessage(
      "board-workshop",
      "host-a",
      JSON.stringify({
        type: "timer",
        timer: {
          durationMs: 300_000,
          remainingMs: 300_000,
          running: true,
          endsAt,
          label: "头脑风暴",
        },
      }),
    );
    expect(a.sent.at(-1)).toMatchObject({
      type: "timer",
      sessionId: "host-a",
      timer: {
        durationMs: 300_000,
        remainingMs: 300_000,
        running: true,
        endsAt,
        label: "头脑风暴",
      },
    });
    expect(b.sent.at(-1)).toMatchObject({
      type: "timer",
      sessionId: "host-a",
      timer: { durationMs: 300_000, running: true, label: "头脑风暴" },
    });

    // Place emoji sticker votes from both peers.
    rooms.handleMessage(
      "board-workshop",
      "host-a",
      JSON.stringify({
        type: "sticker",
        action: "add",
        sticker: {
          id: "stk-1",
          emoji: "👍",
          x: 200,
          y: 160,
          targetId: "shape:idea1",
          authorId: "host-a",
          authorName: "主持人",
        },
      }),
    );
    rooms.handleMessage(
      "board-workshop",
      "guest-b",
      JSON.stringify({
        type: "sticker",
        action: "add",
        sticker: {
          id: "stk-2",
          emoji: "🔥",
          x: 340,
          y: 220,
          authorId: "guest-b",
          authorName: "参与者",
        },
      }),
    );

    expect(a.sent.at(-1)).toMatchObject({
      type: "sticker",
      action: "add",
      sticker: { id: "stk-2", emoji: "🔥", authorId: "guest-b", authorName: "参与者" },
    });

    // Late joiner receives both the live timer and all stickers in welcome.
    const c = makeClient("late-c");
    await rooms.join("board-workshop", null, c.conn);
    const welcomeC = c.sent[0] as Extract<BoardRoomServerMessage, { type: "welcome" }>;
    expect(welcomeC.timer).toMatchObject({ durationMs: 300_000, running: true, label: "头脑风暴" });
    expect(welcomeC.stickers).toHaveLength(2);
    expect(welcomeC.stickers.map((s) => s.id)).toEqual(["stk-1", "stk-2"]);

    // Remove one sticker and verify persistence into board document metadata.
    rooms.handleMessage(
      "board-workshop",
      "host-a",
      JSON.stringify({ type: "sticker", action: "remove", stickerId: "stk-1" }),
    );
    expect(b.sent.at(-1)).toEqual({
      type: "sticker",
      sessionId: "host-a",
      action: "remove",
      stickerId: "stk-1",
    });

    await vi.advanceTimersByTimeAsync(650);
    const persisted = JSON.parse(savedData) as BoardCanvasDocument;
    const savedStickers = persisted.snapshot.store["document:document"]?.meta?.mossStickers as
      | Array<{ id: string; emoji: string }>
      | undefined;
    expect(savedStickers).toHaveLength(1);
    expect(savedStickers?.[0]).toMatchObject({ id: "stk-2", emoji: "🔥" });

    // Clear timer.
    rooms.handleMessage("board-workshop", "host-a", JSON.stringify({ type: "timer", timer: null }));
    expect(b.sent.at(-1)).toEqual({ type: "timer", sessionId: "host-a", timer: null });

    await rooms.dispose();
  });
});
