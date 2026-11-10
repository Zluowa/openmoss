import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { PageVersionContributor } from "@moss/contracts";

import {
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  PageRealtimeRoom,
  sourceKey,
  type RoomConnection,
  type RoomCheckpoint,
  type RoomPublishCut,
  type RoomPageState,
  type StoredRoomState,
} from "./PageRealtimeRoom";
import { applyPlateValue, readPageDoc } from "./pageYjsContent";
import { batchContributors } from "./pageRoomContributors";

const p = (text: string) => ({ type: "p", children: [{ text }] });

function memoryStore() {
  let stored: StoredRoomState | null = null;
  let nextSequence = 1;
  let journal: { seq: number; update: Uint8Array; sources: readonly PageVersionContributor[] }[] =
    [];
  const sources = () =>
    batchContributors(journal.flatMap((row) => row.sources.map((source) => ({ source }))));
  const snapshots = new Map<number, Uint8Array>();
  return {
    get stored() {
      return stored;
    },
    load: async () => stored,
    append: async (
      _generation: string,
      update: Uint8Array,
      accepted: readonly PageVersionContributor[],
    ) => {
      const seq = nextSequence++;
      journal.push({ seq, update, sources: accepted });
      stored = {
        ...stored!,
        lastSequence: seq,
        updates: journal.map((row) => row.update),
        unpublishedContributors: sources(),
      };
      return seq;
    },
    compacted: async (input: RoomCheckpoint) => {
      journal = journal.filter((row) => row.seq > input.throughSequence);
      stored = {
        generation: input.generation,
        state: input.state,
        compactedRevision: input.revision,
        compactedKey: input.key,
        compactedThroughSequence: input.throughSequence,
        lastSequence: nextSequence - 1,
        updates: journal.map((row) => row.update),
        unpublishedContributors: sources(),
      };
      snapshots.set(input.revision, input.state);
    },
    snapshot: async (_generation: string, revision: number) => snapshots.get(revision) ?? null,
    clear: async () => {
      stored = null;
      nextSequence = 1;
      journal = [];
      snapshots.clear();
    },
  };
}

function memoryPages(initial: unknown[] | null, content = "") {
  let page: RoomPageState = {
    revision: 1,
    richContent: initial ? JSON.stringify(initial) : null,
    content,
    trashed: false,
  };
  const writes: Array<{ writer: string; richContent: string }> = [];
  return {
    writes,
    get page() {
      return page;
    },
    set page(next: RoomPageState) {
      page = next;
    },
    read: async () => page,
    write: async (input: {
      expectedRevision: number;
      richContent: string;
      writer: { kind: string };
    }) => {
      if (input.expectedRevision !== page.revision) return null;
      page = { ...page, revision: page.revision + 1, richContent: input.richContent };
      writes.push({ writer: input.writer.kind, richContent: input.richContent });
      return page;
    },
  };
}

function memoryRoomPages(
  store: ReturnType<typeof memoryStore>,
  pages: ReturnType<typeof memoryPages>,
) {
  return {
    read: pages.read,
    publish: async (cut: RoomPublishCut) => {
      const page = cut.checkpointOnly
        ? pages.page.revision === cut.expectedRevision &&
          sourceKey(pages.page) === cut.baseContentKey
          ? pages.page
          : null
        : await pages.write(cut);
      if (page)
        await store.compacted({
          generation: cut.generation,
          state: cut.state,
          revision: page.revision,
          key: sourceKey(page),
          throughSequence: cut.throughSequence,
        });
      return page;
    },
  };
}

/** A y-protocols client like the editor's, wired straight to the room. */
function client(room: PageRealtimeRoom, mode: "edit" | "view" = "edit") {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const controls: Array<Record<string, unknown>> = [];
  const connection: RoomConnection = {
    mode,
    send: (message) => {
      if (typeof message === "string") {
        controls.push(JSON.parse(message) as Record<string, unknown>);
        return;
      }
      const decoder = decoding.createDecoder(message);
      const type = decoding.readVarUint(decoder);
      if (type === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, "remote");
        if (encoding.length(encoder) > 1) room.receive(connection, encoding.toUint8Array(encoder));
      } else if (type === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          "remote",
        );
      }
    },
    close: vi.fn(),
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    room.receive(connection, encoding.toUint8Array(encoder));
  });
  awareness.on(
    "update",
    ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === "remote") return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [...added!, ...updated!, ...removed!]),
      );
      room.receive(connection, encoding.toUint8Array(encoder));
    },
  );
  room.connect(connection);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  room.receive(connection, encoding.toUint8Array(encoder));
  return { doc, awareness, connection, controls };
}

const fast = { persistMs: 1, compactIdleMs: 5, compactMaxMs: 50, agentPresenceMs: 30 };
const rooms: PageRealtimeRoom[] = [];
const makeRoom = (store = memoryStore(), pages = memoryPages([p("hello")]), timers = fast) => {
  let generation = 0;
  const room = new PageRealtimeRoom({
    pageId: "page-1",
    store,
    pages: memoryRoomPages(store, pages),
    newGeneration: () => `gen-${++generation}`,
    timers,
  });
  rooms.push(room);
  return { room, store, pages };
};
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const room of rooms.splice(0)) await room.close();
});

describe("PageRealtimeRoom", () => {
  it.each([false, true])(
    "acks only the appended batch while a later update arrives (first append fails=%s)",
    async (failFirst) => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = memoryStore();
      const append = store.append;
      let calls = 0;
      store.append = async (generation, update, sources) => {
        if (++calls === 1) {
          enter();
          await blocked;
          if (failFirst) throw new Error("fixture append failure");
        }
        return append(generation, update, sources);
      };
      const { room } = makeRoom(store, memoryPages([p("hello")]), {
        ...fast,
        persistMs: 60_000,
        compactIdleMs: 60_000,
        compactMaxMs: 60_000,
      });
      await room.open();
      const editor = client(room);
      const durable = new Y.Doc();
      editor.controls.length = 0; // Exclude the already-durable initial handshake acknowledgement.
      const saved = () => editor.controls.filter((control) => control.type === "saved");
      const vector = (value: unknown) =>
        Y.decodeStateVector(Buffer.from(value as string, "base64"));
      try {
        applyPlateValue(editor.doc, [p("first accepted")], null);
        const first = room.persist();
        await entered;
        // The actual sync client calls room.receive synchronously while append is awaiting IO.
        applyPlateValue(editor.doc, [p("first accepted"), p("arrived during append")], null);
        expect(saved()).toEqual([]);
        release();
        await first;
        Y.applyUpdate(durable, store.stored!.state);
        for (const update of store.stored!.updates) Y.applyUpdate(durable, update);
        expect(readPageDoc(durable)).toEqual(failFirst ? [p("hello")] : [p("first accepted")]);
        expect(readPageDoc(room.doc)).toEqual([p("first accepted"), p("arrived during append")]);
        if (failFirst) expect(saved()).toEqual([]);
        else {
          expect(saved()).toHaveLength(1);
          expect(vector(saved()[0]!.stateVector)).toEqual(
            Y.decodeStateVector(Y.encodeStateVector(durable)),
          );
          expect(vector(saved()[0]!.stateVector)).not.toEqual(
            Y.decodeStateVector(Y.encodeStateVector(room.doc)),
          );
        }
        await room.persist();
        for (const update of store.stored!.updates) Y.applyUpdate(durable, update);
        expect(readPageDoc(durable)).toEqual(readPageDoc(room.doc));
        expect(vector(saved().at(-1)!.stateVector)).toEqual(
          Y.decodeStateVector(Y.encodeStateVector(durable)),
        );
        expect(saved()).toHaveLength(failFirst ? 1 : 2);
      } finally {
        release();
        durable.destroy();
        room.disconnect(editor.connection);
        editor.awareness.destroy();
        editor.doc.destroy();
      }
    },
  );

  it("does not acknowledge an in-flight append to a newly connected editor", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = memoryStore();
    const append = store.append;
    store.append = async (...args) => {
      enter();
      await blocked;
      return append(...args);
    };
    const { room } = makeRoom(store, memoryPages([p("hello")]), {
      ...fast,
      persistMs: 60_000,
      compactIdleMs: 60_000,
      compactMaxMs: 60_000,
    });
    await room.open();
    const first = client(room);
    let late: ReturnType<typeof client> | undefined;
    try {
      applyPlateValue(first.doc, [p("still appending")], null);
      const persisting = room.persist();
      await entered;
      late = client(room);
      expect(readPageDoc(late.doc)).toEqual([p("still appending")]);
      expect(store.stored!.updates).toEqual([]);
      expect(late.controls.filter((control) => control.type === "saved")).toEqual([]);
      release();
      await persisting;
      expect(late.controls.filter((control) => control.type === "saved")).toHaveLength(1);
    } finally {
      release();
      for (const peer of [first, late])
        if (peer) {
          room.disconnect(peer.connection);
          peer.awareness.destroy();
          peer.doc.destroy();
        }
    }
  });

  it.each(["append", "publish"])(
    "freezes Page body and Yjs state before deferred %s",
    async (pause) => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = memoryStore();
      const pages = memoryPages([p("hello")]);
      const append = store.append;
      const write = pages.write;
      if (pause === "append")
        store.append = async (...args) => {
          enter();
          await blocked;
          return append(...args);
        };
      else
        pages.write = async (input) => {
          enter();
          await blocked;
          return write(input);
        };
      const { room } = makeRoom(store, pages, {
        ...fast,
        persistMs: 60_000,
        compactIdleMs: 60_000,
        compactMaxMs: 60_000,
      });
      await room.open();
      const editor = client(room);
      const snapshot = new Y.Doc();
      try {
        applyPlateValue(editor.doc, [p("A")], null);
        const first = room.compact();
        await entered;
        applyPlateValue(editor.doc, [p("A"), p("B after cut")], null);
        release();
        await first;
        Y.applyUpdate(snapshot, store.stored!.state);
        expect(JSON.parse(pages.page.richContent!)).toEqual([p("A")]);
        expect(readPageDoc(snapshot)).toEqual([p("A")]);
        expect(store.stored!.compactedThroughSequence).toBe(1);
        expect(readPageDoc(room.doc)).toEqual([p("A"), p("B after cut")]);
        await room.persist();
        expect(store.stored!.updates).toHaveLength(1);
        await room.compact();
        expect(JSON.parse(pages.page.richContent!)).toEqual([p("A"), p("B after cut")]);
        expect(store.stored!.compactedThroughSequence).toBe(2);
      } finally {
        release();
        snapshot.destroy();
        room.disconnect(editor.connection);
        editor.awareness.destroy();
        editor.doc.destroy();
      }
    },
  );

  it("retains an unpersisted close prefix, refuses new peers, and retries only on an explicit close", async () => {
    const store = memoryStore();
    const pages = memoryPages([p("hello")]);
    const append = store.append;
    let attempts = 0;
    store.append = async () => {
      attempts++;
      throw new Error("fixture append unavailable");
    };
    const { room } = makeRoom(store, pages, {
      ...fast,
      persistMs: 60_000,
      compactIdleMs: 60_000,
      compactMaxMs: 60_000,
    });
    await room.open();
    const editor = client(room);
    applyPlateValue(editor.doc, [p("keep volatile")], null);
    await expect(room.close()).rejects.toMatchObject({ hasVolatileUpdates: true });
    expect(attempts).toBe(1);
    expect(readPageDoc(room.doc)).toEqual([p("keep volatile")]);
    const peer = { mode: "edit" as const, send: vi.fn(), close: vi.fn() };
    room.connect(peer);
    expect(peer.close).toHaveBeenCalledWith(1013, "room closed");
    expect(room.receive(peer, new Uint8Array())).toBe(false);
    store.append = append;
    await room.close();
    expect(JSON.parse(pages.page.richContent!)).toEqual([p("keep volatile")]);
    expect(store.stored!.compactedThroughSequence).toBe(1);
    editor.awareness.destroy();
    editor.doc.destroy();
  });

  it("reports a failed publication with a durable journal and replays it before replacement admission", async () => {
    const store = memoryStore();
    const pages = memoryPages([p("hello")]);
    const write = pages.write;
    const { room } = makeRoom(store, pages, {
      ...fast,
      persistMs: 60_000,
      compactIdleMs: 60_000,
      compactMaxMs: 60_000,
    });
    await room.open();
    const editor = client(room);
    applyPlateValue(editor.doc, [p("recovered tail")], null);
    pages.write = async () => {
      throw new Error("fixture publish unavailable");
    };
    await expect(room.close()).rejects.toMatchObject({ hasVolatileUpdates: false });
    expect(store.stored!.updates).toHaveLength(1);
    expect(pages.page.revision).toBe(1);
    pages.write = write;
    const replacement = makeRoom(store, pages).room;
    await replacement.open();
    expect(pages.page.revision).toBe(2);
    expect(readPageDoc(replacement.doc)).toEqual([p("recovered tail")]);
    expect(store.stored!.updates).toEqual([]);
    editor.awareness.destroy();
    editor.doc.destroy();
  });

  it("refuses a new source before applying its update when an unpublished cut reaches the contributor limit", async () => {
    const pages = memoryPages([p("initial")]);
    const store = memoryStore();
    const { room } = makeRoom(store, pages, {
      ...fast,
      persistMs: 60_000,
      compactIdleMs: 60_000,
      compactMaxMs: 60_000,
    });
    await room.open();
    const editor = client(room);
    const write = pages.write;
    pages.write = async () => {
      throw new Error("fixture publication unavailable");
    };
    try {
      for (let index = 0; index < 128; index++) {
        await expect(
          room.applyWrite({
            richContent: JSON.stringify([p("agent " + index)]),
            baseRevision: 1,
            writer: { kind: "agent", threadId: "agent-" + index },
          }),
        ).rejects.toThrow("fixture publication unavailable");
      }
      const before = readPageDoc(room.doc);
      const journalCount = store.stored!.updates.length;
      await expect(
        room.applyWrite({
          richContent: JSON.stringify([p("over budget")]),
          baseRevision: 1,
          writer: { kind: "agent", threadId: "agent-129" },
        }),
      ).rejects.toThrow("before accepting another source");
      applyPlateValue(editor.doc, [p("rejected owner frame")], null);
      expect(editor.controls).toContainEqual({
        type: "rejected",
        reason: "当前版本的编辑来源已满，请在保存后重试。",
      });
      expect(readPageDoc(room.doc)).toEqual(before);
      expect(store.stored!.updates).toHaveLength(journalCount);
      expect(store.stored!.unpublishedContributors).toHaveLength(128);
      pages.write = write;
      await room.compact();
      const saved = await room.applyWrite({
        richContent: JSON.stringify([p("accepted after publish")]),
        baseRevision: room.currentRevision,
        writer: { kind: "agent", threadId: "agent-129" },
      });
      expect(JSON.parse(saved!.richContent!)).toEqual([p("accepted after publish")]);
    } finally {
      pages.write = write;
      room.disconnect(editor.connection);
      editor.awareness.destroy();
      editor.doc.destroy();
    }
  });

  it("syncs two editors and compacts their merged edits into one revision", async () => {
    const { room, pages, store } = makeRoom();
    await room.open();
    const left = client(room);
    const right = client(room);
    expect(readPageDoc(left.doc)).toEqual([p("hello")]);
    applyPlateValue(left.doc, [p("hello world")], null);
    applyPlateValue(right.doc, [p("hello world"), p("second")], null);
    expect(readPageDoc(left.doc)).toEqual(readPageDoc(right.doc));
    await settle();
    expect(pages.page.revision).toBe(2);
    expect(JSON.parse(pages.page.richContent!)).toEqual([p("hello world"), p("second")]);
    expect(store.stored?.updates).toEqual([]);
    expect(left.controls).toContainEqual({ type: "revision", revision: 2 });
    expect(left.controls.some((control) => control.type === "saved")).toBe(true);
  });

  it("drops a viewer's edits but still sends it the document", async () => {
    const { room, pages } = makeRoom();
    await room.open();
    const viewer = client(room, "view");
    expect(readPageDoc(viewer.doc)).toEqual([p("hello")]);
    applyPlateValue(viewer.doc, [p("vandal")], null);
    await settle();
    expect(readPageDoc(room.doc)).toEqual([p("hello")]);
    expect(pages.writes).toEqual([]);
  });

  it("shares presence and removes it when a window leaves", async () => {
    const { room } = makeRoom();
    await room.open();
    const left = client(room);
    const right = client(room);
    left.awareness.setLocalStateField("user", { name: "左" });
    expect(right.awareness.getStates().get(left.doc.clientID)).toEqual({ user: { name: "左" } });
    room.disconnect(left.connection);
    expect(right.awareness.getStates().has(left.doc.clientID)).toBe(false);
  });

  it("merges an agent write made against an older revision with live typing", async () => {
    const { room, pages } = makeRoom(memoryStore(), memoryPages([p("alpha"), p("beta")]));
    await room.open();
    const person = client(room);
    const watcher = client(room);
    applyPlateValue(person.doc, [p("alpha typed"), p("beta")], null);
    await settle();
    expect(pages.page.revision).toBe(2);
    const saved = await room.applyWrite({
      richContent: JSON.stringify([p("alpha"), p("beta by agent")]),
      baseRevision: 1,
      writer: { kind: "agent", threadId: "thread-1" },
    });
    expect(saved?.revision).toBe(3);
    expect(JSON.parse(pages.page.richContent!)).toEqual([p("alpha typed"), p("beta by agent")]);
    expect(pages.writes.at(-1)?.writer).toBe("agent");
    expect(readPageDoc(watcher.doc)).toEqual([p("alpha typed"), p("beta by agent")]);
    const agentState = [...watcher.awareness.getStates().values()].find(
      (state) => (state as { moss?: unknown }).moss,
    );
    expect(agentState).toEqual({
      moss: { kind: "agents", agents: [{ id: "thread-1", name: "智能体" }] },
    });
    await settle(80);
    expect(
      [...watcher.awareness.getStates().values()].some(
        (state) => (state as { moss?: unknown }).moss,
      ),
    ).toBe(false);
  });

  it("recovers uncompacted updates after a crash and folds in an outside write", async () => {
    const store = memoryStore();
    const pages = memoryPages([p("one")]);
    const first = new PageRealtimeRoom({
      pageId: "page-1",
      store,
      pages: memoryRoomPages(store, pages),
      newGeneration: () => "gen-1",
      timers: { ...fast, compactIdleMs: 60_000, compactMaxMs: 60_000 },
    });
    await first.open();
    const editor = client(first);
    applyPlateValue(editor.doc, [p("one"), p("unsaved")], null);
    await first.persist();
    expect(store.stored?.updates.length).toBe(1);
    // The process dies without compacting; an older window writes the page meanwhile.
    pages.page = {
      ...pages.page,
      revision: 2,
      richContent: JSON.stringify([{ type: "h1", children: [{ text: "one" }] }]),
    };
    const { room } = makeRoom(store, pages);
    await room.open();
    expect(room.generation).toBe("gen-1");
    // The outside write turned the block into a heading in place and, ending on a heading,
    // gained the editor's trailing paragraph. That paragraph and the recovered one were inserted
    // concurrently at the same spot, so their order is Yjs's to pick.
    const value = readPageDoc(room.doc);
    expect(value[0]).toEqual({ type: "h1", children: [{ text: "one" }] });
    expect(value.slice(1)).toHaveLength(2);
    expect(value.slice(1)).toContainEqual(p("unsaved"));
    expect(value.slice(1)).toContainEqual(p(""));
    await room.compact();
    expect(pages.page.revision).toBe(3);
  });

  it("retries compaction after a title-only revision", async () => {
    const { room, pages } = makeRoom();
    await room.open();
    const editor = client(room);
    pages.page = { ...pages.page, revision: 2 };
    applyPlateValue(editor.doc, [p("hello again")], null);
    await room.compact();
    expect(pages.page.revision).toBe(3);
    expect(sourceKey(pages.page)).toBe(JSON.stringify([p("hello again")]));
  });

  it("asks the first editor to seed a Markdown page and resets everyone after", async () => {
    const { room, pages } = makeRoom(memoryStore(), memoryPages(null, "# 标题"));
    await room.open();
    expect(room.seeded).toBe(false);
    const editor = client(room);
    expect(editor.controls).toContainEqual({ type: "need-seed" });
    room.receive(
      editor.connection,
      JSON.stringify({
        type: "seed",
        richContent: JSON.stringify([{ type: "h1", children: [{ text: "标题" }] }]),
      }),
    );
    await settle();
    expect(room.seeded).toBe(true);
    expect(editor.controls).toContainEqual({
      type: "reset",
      reason: "seeded",
      generation: "gen-1",
    });
    // Seeding alone is not an edit: the Markdown page stays as it was.
    await room.compact();
    expect(pages.writes).toEqual([]);
  });
});
