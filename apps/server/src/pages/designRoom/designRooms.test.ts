// FILE: designRooms.test.ts
// Purpose: A live 设计 room merges two people's ops in order, relays presence, saves once after
//          changes, saves on top of a conflicting outside write, and pushes an agent's write in.
// Layer: Server pages (plain TypeScript, fake store and sockets)

import { createDesignCanvas, type DesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignRooms, type DesignRoomSocket } from "./designRooms";

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const socket: DesignRoomSocket & { sent: typeof sent; closed: number | null } = {
    readyState: 1,
    sent,
    closed: null,
    send: (data) => void sent.push(JSON.parse(data) as Record<string, unknown>),
    close(code) {
      this.closed = code ?? 1000;
    },
  };
  return socket;
}

function fakeStore(initial: DesignCanvas) {
  const state = { data: JSON.stringify(initial), revision: 1, saves: 0, conflictOnce: false };
  return {
    state,
    store: {
      read: async () => ({ data: state.data, revision: state.revision }),
      save: async (_page: string, _scope: string | null, data: string, expected: number) => {
        if (state.conflictOnce) {
          state.conflictOnce = false;
          state.revision += 1;
          throw Object.assign(new Error("conflict"), {
            code: "conflict",
            currentRevision: state.revision,
          });
        }
        if (expected !== state.revision)
          throw Object.assign(new Error("conflict"), {
            code: "conflict",
            currentRevision: state.revision,
          });
        state.data = data;
        state.revision += 1;
        state.saves += 1;
        return state.revision;
      },
    },
  };
}

const board = (id: string) => ({
  op: "upsertBoard" as const,
  board: { id, name: id, page: "page-1", x: 0, y: 0, w: 390, h: 844, html: "<div></div>" },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DesignRooms", () => {
  it("welcomes, merges ops from two people in order and relays presence", async () => {
    const { store } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const a = fakeSocket();
    const b = fakeSocket();
    const left = await rooms.join("design-1", null, "peer-a", a, false);
    const right = await rooms.join("design-1", null, "peer-b", b, false);
    expect(a.sent[0]).toMatchObject({ t: "welcome", self: "peer-a", seq: 0, readOnly: false });
    left.receive(JSON.stringify({ t: "hello", name: "甲", color: "oklch(0.6 0.2 30)" }));
    left.receive(JSON.stringify({ t: "ops", id: "1", ops: [board("home")] }));
    right.receive(JSON.stringify({ t: "ops", id: "1", ops: [board("detail")] }));
    await vi.waitFor(() =>
      expect(b.sent.filter((message) => message.t === "ops").map((m) => m.seq)).toEqual([1, 2]),
    );
    const peers = b.sent.filter((message) => message.t === "peers").at(-1) as {
      peers: { id: string; name: string }[];
    };
    expect(peers.peers.find((peer) => peer.id === "peer-a")?.name).toBe("甲");
    right.receive(JSON.stringify({ t: "presence", presence: { cursor: { x: 1, y: 2 } } }));
    await vi.waitFor(() => expect(a.sent.at(-1)).toMatchObject({ t: "presence", id: "peer-b" }));
    // The sender never hears its own presence back.
    expect(b.sent.some((message) => message.t === "presence")).toBe(false);
  });

  it("rejects ops that do not apply and keeps the room as it was", async () => {
    const { store } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const a = fakeSocket();
    const joined = await rooms.join("design-1", null, "peer-a", a, false);
    joined.receive(JSON.stringify({ t: "ops", id: "x", ops: [{ op: "deleteBoard", id: "nope" }] }));
    await vi.waitFor(() => expect(a.sent.at(-1)).toMatchObject({ t: "reject", id: "x", seq: 0 }));
  });

  it("refuses edits from a read-only window", async () => {
    const { store } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const a = fakeSocket();
    const joined = await rooms.join("design-1", null, "peer-a", a, true);
    joined.receive(JSON.stringify({ t: "ops", id: "x", ops: [board("home")] }));
    await vi.waitFor(() => expect(a.sent.at(-1)).toMatchObject({ t: "reject", id: "x" }));
  });

  it("saves once after a burst and saves on top of an outside write", async () => {
    vi.useFakeTimers();
    const { store, state } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const a = fakeSocket();
    const joined = await rooms.join("design-1", null, "peer-a", a, false);
    joined.receive(JSON.stringify({ t: "ops", id: "1", ops: [board("one")] }));
    joined.receive(JSON.stringify({ t: "ops", id: "2", ops: [board("two")] }));
    await vi.advanceTimersByTimeAsync(700);
    expect(state.saves).toBe(1);
    expect(JSON.parse(state.data).boards.map((entry: { id: string }) => entry.id)).toEqual([
      "one",
      "two",
    ]);
    state.conflictOnce = true;
    joined.receive(JSON.stringify({ t: "ops", id: "3", ops: [board("three")] }));
    await vi.advanceTimersByTimeAsync(700);
    expect(state.saves).toBe(2);
    expect(a.sent.filter((message) => message.t === "saved").at(-1)).toMatchObject({
      revision: state.revision,
    });
  });

  it("answers a flush with the saved revision and pushes an agent's write to everyone", async () => {
    const { store, state } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const a = fakeSocket();
    const joined = await rooms.join("design-1", null, "peer-a", a, false);
    joined.receive(JSON.stringify({ t: "ops", id: "1", ops: [board("one")] }));
    joined.receive(JSON.stringify({ t: "flush", id: "f" }));
    await vi.waitFor(() => expect(a.sent.at(-1)).toMatchObject({ t: "flushed", id: "f" }));
    expect((a.sent.at(-1) as { revision: number }).revision).toBe(state.revision);
    const agent = { ...createDesignCanvas(), boards: [] };
    rooms.replaced("design-1", JSON.stringify(agent), state.revision + 1);
    expect(a.sent.at(-1)).toMatchObject({ t: "doc", revision: state.revision + 1 });
  });

  it("refuses a window that sends ops faster than the limit", async () => {
    const { store } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const a = fakeSocket();
    const joined = await rooms.join("design-1", null, "peer-a", a, false);
    for (let index = 0; index < 31; index += 1)
      joined.receive(JSON.stringify({ t: "ops", id: String(index), ops: [board(`b${index}`)] }));
    await vi.waitFor(() =>
      expect(a.sent.filter((message) => message.t === "reject")).toHaveLength(1),
    );
    expect(a.sent.filter((message) => message.t === "ops")).toHaveLength(30);
  });

  it("a second window of the same peer replaces the first", async () => {
    const { store } = fakeStore(createDesignCanvas());
    const rooms = new DesignRooms(store);
    const first = fakeSocket();
    const second = fakeSocket();
    const old = await rooms.join("design-1", null, "peer-a", first, false);
    await rooms.join("design-1", null, "peer-a", second, false);
    expect(first.closed).toBe(4000);
    // The old connection's late close does not remove the new one.
    old.leave();
    expect(rooms.isOpen("design-1")).toBe(true);
  });
});
