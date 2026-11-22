// FILE: boardRooms.test.ts
// Purpose: Tests for pure-TS live 白板 rooms (presence, ops relay, snapshot save debounce, and conflict sync).

import { createBoardCanvasDocument } from "@moss/shared/spaceItems/boardCanvas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardRooms, type BoardRoomServerMessage } from "./boardRooms";

function makeClient(sessionId: string, readOnly = false) {
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
    await rooms.dispose();
  });
});
