// FILE: runtime.review.test.ts
// Purpose: Regression tests for the #456 review of the Mossbot room runtime: bounded storage,
//          coded failures, the hidden room kind, per-job turn binding, damaged files and delete.
// Layer: Server unit tests (in-memory orchestration fake, real files in a temp folder)

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProjectKind,
} from "@moss/contracts";
import { MossbotRoomError } from "@moss/shared/mossbotRoom";

import {
  compactRecord,
  MossbotRoomRuntime,
  ROOM_LIMITS,
  type RoomRuntimeDeps,
  type Stored,
} from "./runtime";
import { mossbotRoomToolErrorText, toMossbotRoomRpcError } from "./errors";

const runtimes: MossbotRoomRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Thread = {
  id: string;
  messages: Array<{
    id: string;
    role: string;
    text: string;
    turnId: string | null;
    createdAt: string;
  }>;
  latestTurn: { turnId: string; state: string; requestedAt: string } | null;
  session: { status: string; lastError: string | null } | null;
};

async function harness(options: { directory?: string } = {}) {
  const directory = options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "mossbot-review-")));
  if (!options.directory) directories.push(directory);
  const threads = new Map<string, Thread>();
  const projects = new Map<string, ProjectKind>();
  const commands: OrchestrationCommand[] = [];
  const deps: RoomRuntimeDeps = {
    directory,
    loadMember: async (id) => ({
      name: id === "a" ? "Nova" : "Atlas",
      icon: null,
      color: null,
      modelSelection: { provider: "codex", model: "chosen", instanceId: `${id}-account` },
      instructions: `Persona of ${id}`,
    }),
    projectKind: async (id) => projects.get(id) ?? null,
    thread: async (id) => (threads.get(id) ?? null) as unknown as OrchestrationThread | null,
    dispatch: async (command) => {
      commands.push(structuredClone(command));
      if (command.type === "project.create")
        projects.set(command.projectId, command.kind ?? "project");
      if (command.type === "project.meta.update" && command.kind)
        projects.set(command.projectId, command.kind);
      if (command.type === "project.delete") projects.delete(command.projectId);
      if (command.type === "thread.create")
        threads.set(command.threadId, {
          id: command.threadId,
          messages: [],
          latestTurn: null,
          session: null,
        });
      if (command.type === "thread.delete") threads.delete(command.threadId);
      if (command.type === "thread.turn.start") {
        const thread = threads.get(command.threadId)!;
        const turnId = `turn-${command.message.messageId}`;
        thread.messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
          turnId,
          createdAt: command.createdAt,
        });
        thread.latestTurn = { turnId, state: "running", requestedAt: command.createdAt };
        thread.session = { status: "running", lastError: null };
      }
      if (command.type === "thread.turn.interrupt") {
        const thread = threads.get(command.threadId)!;
        if (thread.latestTurn && (!command.turnId || command.turnId === thread.latestTurn.turnId)) {
          thread.latestTurn = { ...thread.latestTurn, state: "interrupted" };
          thread.session = { status: "ready", lastError: null };
        }
      }
    },
  };
  const runtime = new MossbotRoomRuntime(deps);
  runtimes.push(runtime);
  await runtime.start();
  return { directory, deps, runtime, threads, projects, commands };
}

const createRoom = (runtime: MossbotRoomRuntime) =>
  runtime.create({
    requestId: "room-one",
    name: "Study group",
    memberProjectIds: [ProjectId.makeUnsafe("a"), ProjectId.makeUnsafe("b")],
    responder: "mentions",
  });

function reply(thread: Thread, text: string) {
  thread.messages.push({
    id: `reply-${thread.messages.length}`,
    role: "assistant",
    text,
    turnId: thread.latestTurn!.turnId,
    createdAt: new Date().toISOString(),
  });
  thread.latestTurn = { ...thread.latestTurn!, state: "completed" };
  thread.session = { status: "ready", lastError: null };
}

describe("bounded room storage", () => {
  it("drops settled prompts and trims lines, jobs, receipts and counters", () => {
    const job = (i: number, state: "completed" | "running") => ({
      requestId: `r${i}`,
      memberId: ProjectId.makeUnsafe("a"),
      createdAt: new Date(i).toISOString(),
      text: "x",
      prompt: "p".repeat(10_000),
      attempts: 1,
      stopAt: null,
      rootId: `r${i}`,
      depth: 0,
      state,
      error: null,
      turnId: `t${i}`,
    });
    const record = {
      room: {
        id: "room",
        name: "Room",
        projectId: ProjectId.makeUnsafe("mossbot-room-room"),
        createdAt: "",
        responder: "mentions",
        members: [],
        lines: Array.from({ length: 1000 }, (_, i) => ({
          id: `r${i}`,
          senderId: null,
          text: "y".repeat(2_000),
          createdAt: new Date(i).toISOString(),
        })),
        deliveries: [],
      },
      instructions: {},
      jobs: [...Array.from({ length: 500 }, (_, i) => job(i, "completed")), job(999, "running")],
      fingerprint: "{}",
      receipts: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`r${i}`, "f"])),
      postCounts: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`r${i}`, 1])),
    } as unknown as Stored;
    const compact = compactRecord(record);
    expect(compact.room.lines.length).toBeLessThanOrEqual(ROOM_LIMITS.lines);
    expect(compact.room.lines.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(
      ROOM_LIMITS.lineChars,
    );
    expect(compact.room.lines.at(-1)!.id).toBe("r999");
    expect(compact.jobs.filter((j) => j.state === "completed")).toHaveLength(
      ROOM_LIMITS.finishedJobs,
    );
    expect(
      compact.jobs.filter((j) => j.state === "completed").every((j) => j.prompt === null),
    ).toBe(true);
    expect(compact.jobs.find((j) => j.state === "running")!.prompt).toHaveLength(10_000);
    expect(Object.keys(compact.receipts).length).toBe(compact.room.lines.length);
    expect(Object.keys(compact.postCounts).length).toBeLessThanOrEqual(
      compact.room.lines.length + compact.jobs.length,
    );
    expect(compactRecord(compact)).toBe(compact);
  });

  it("shrinks an oversized file on start and keeps it bounded while the room is used", async () => {
    const first = await harness();
    await createRoom(first.runtime);
    for (let i = 0; i < 40; i += 1) {
      await first.runtime.send({
        roomId: "room-one",
        requestId: `m${i}`,
        text: `@Nova ${"z".repeat(30_000)}`,
      });
      await first.runtime.reconcile();
      reply(first.threads.get("mossbot-room-room-one-0")!, `answer ${i}`);
      await first.runtime.reconcile();
    }
    const file = path.join(first.directory, "rooms.json");
    const size = (await stat(file)).size;
    // 40 posts of 30 000 characters, each also once embedded in a 48 000-character prompt,
    // would be several megabytes without the limits.
    expect(size).toBeLessThan(ROOM_LIMITS.lineChars + 200_000);
    const stored = JSON.parse(await readFile(file, "utf8")).rooms[0];
    expect(stored.jobs.every((j: { prompt: unknown }) => j.prompt === null)).toBe(true);
    const mtime = (await stat(file)).mtimeMs;
    await first.runtime.reconcile();
    await first.runtime.reconcile();
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });
});

describe("coded room failures", () => {
  it("keeps the code and message for the client and the member agent", async () => {
    const f = await harness();
    const error = await f.runtime
      .send({ roomId: "missing", requestId: "x", text: "hi" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(MossbotRoomError);
    expect(error.code).toBe("room_not_found");
    const wire = toMossbotRoomRpcError(error);
    expect(wire.code).toBe("mossbot.room_not_found");
    expect(wire.message).toBe("Room not found.");
    expect(wire.retryable).toBe(false);
    expect(mossbotRoomToolErrorText(error)).toContain("room_not_found; do not retry");
    expect(toMossbotRoomRpcError(new Error("disk full")).code).toBe("mossbot.unavailable");
  });

  it("codes an ambiguous mention", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    f.deps.loadMember = async () => ({
      name: "Nova",
      icon: null,
      color: null,
      modelSelection: { provider: "codex", model: "m" },
      instructions: "",
    });
    await f.runtime.update({
      roomId: "room-one",
      memberProjectIds: [
        ProjectId.makeUnsafe("a"),
        ProjectId.makeUnsafe("b"),
        ProjectId.makeUnsafe("c"),
      ],
      expectedMemberProjectIds: [ProjectId.makeUnsafe("a"), ProjectId.makeUnsafe("b")],
      responder: "mentions",
    });
    const error = await f.runtime
      .send({ roomId: "room-one", requestId: "amb", text: "@Nova hi" })
      .catch((e) => e);
    expect(error.code).toBe("ambiguous_name");
  });
});

describe("hidden room container", () => {
  it("creates the room container with the room kind", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    const created = f.commands.find((c) => c.type === "project.create");
    expect(created && "kind" in created ? created.kind : undefined).toBe("room");
  });

  it("moves a room created before the room kind out of the ordinary projects once", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    f.projects.set("mossbot-room-room-one", "project");
    await f.runtime.stop();
    const restarted = new MossbotRoomRuntime(f.deps);
    runtimes.push(restarted);
    await restarted.start();
    await restarted.reconcile();
    const updates = f.commands.filter((c) => c.type === "project.meta.update");
    expect(updates).toHaveLength(1);
    expect(f.projects.get("mossbot-room-room-one")).toBe("room");
  });
});

describe("per-job turn binding", () => {
  it("follows only its own turn behind a direct conversation, and stops only that turn", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    await f.runtime.send({ roomId: "room-one", requestId: "ask", text: "@Nova plan it" });
    await f.runtime.reconcile();
    const thread = f.threads.get("mossbot-room-room-one-0")!;
    // The member thread was busy with a direct conversation: our message waits in its queue.
    const ours = thread.messages.find((m) => m.id.startsWith("room:room-one:ask"))!;
    ours.turnId = null;
    const later = new Date(Date.now() + 60_000).toISOString();
    thread.latestTurn = { turnId: "turn-direct", state: "running", requestedAt: later };
    await f.runtime.reconcile();
    const state = async () => (await f.runtime.get("room-one")).room.deliveries.at(-1)!.state;
    expect(await state()).toBe("running");
    // The direct turn ends, even with an error, before ours starts: our job is untouched.
    thread.latestTurn = { turnId: "turn-direct", state: "error", requestedAt: later };
    thread.session = { status: "ready", lastError: "provider exploded" };
    await f.runtime.reconcile();
    expect(await state()).toBe("running");
    thread.latestTurn = { turnId: "turn-direct", state: "completed", requestedAt: later };
    thread.session = { status: "ready", lastError: null };
    await f.runtime.reconcile();
    expect(await state()).toBe("running");
    // Stopping the room never interrupts the direct conversation.
    thread.latestTurn = { turnId: "turn-direct-2", state: "running", requestedAt: later };
    await f.runtime.cancel("room-one");
    await f.runtime.reconcile();
    expect(f.commands.filter((c) => c.type === "thread.turn.interrupt")).toHaveLength(0);
    // Once our own turn starts, exactly that turn is interrupted.
    ours.turnId = "turn-room";
    thread.latestTurn = { turnId: "turn-room", state: "running", requestedAt: later };
    await f.runtime.reconcile();
    const interrupts = f.commands.filter((c) => c.type === "thread.turn.interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.type === "thread.turn.interrupt" && interrupts[0]!.turnId).toBe(
      "turn-room",
    );
    await f.runtime.reconcile();
    expect(await state()).toBe("cancelled");
  });

  it("settles from its own turn even after a newer direct turn started", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    await f.runtime.send({ roomId: "room-one", requestId: "ask", text: "@Nova plan it" });
    await f.runtime.reconcile();
    await f.runtime.reconcile();
    const thread = f.threads.get("mossbot-room-room-one-0")!;
    reply(thread, "Our answer");
    thread.latestTurn = {
      turnId: "turn-direct",
      state: "running",
      requestedAt: new Date().toISOString(),
    };
    await f.runtime.reconcile();
    const view = await f.runtime.get("room-one");
    expect(view.room.deliveries.at(-1)).toMatchObject({ state: "completed", error: null });
  });
});

describe("damaged room file", () => {
  it("sets the file aside and starts with no rooms", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mossbot-corrupt-"));
    directories.push(directory);
    await writeFile(path.join(directory, "rooms.json"), "{ not json");
    const f = await harness({ directory });
    expect(f.runtime.list()).toEqual([]);
    const names = await readdir(directory);
    expect(names.some((name) => name.startsWith("rooms.json.corrupt-"))).toBe(true);
    await createRoom(f.runtime);
    expect(f.runtime.list()).toHaveLength(1);
  });

  it("decodes a file written before turn ids and keeps its rooms", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    await f.runtime.stop();
    const file = path.join(f.directory, "rooms.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    for (const job of stored.rooms[0].jobs) delete job.turnId;
    stored.rooms[0].futureField = { kept: true };
    await writeFile(file, JSON.stringify(stored));
    const restarted = new MossbotRoomRuntime(f.deps);
    runtimes.push(restarted);
    await restarted.start();
    expect(restarted.list()).toHaveLength(1);
  });
});

describe("room delete", () => {
  it("removes the threads, the container, the workspace and the record, and survives a restart", async () => {
    const f = await harness();
    await createRoom(f.runtime);
    await f.runtime.send({ roomId: "room-one", requestId: "ask", text: "@Nova plan it" });
    await f.runtime.reconcile();
    const dispatch = f.deps.dispatch;
    let failOnce = true;
    f.deps.dispatch = async (command) => {
      if (command.type === "project.delete" && failOnce) {
        failOnce = false;
        throw new Error("connection lost");
      }
      return dispatch(command);
    };
    await expect(f.runtime.delete("room-one")).rejects.toThrow("connection lost");
    expect(f.runtime.list()).toEqual([]);
    await f.runtime.stop();
    const restarted = new MossbotRoomRuntime(f.deps);
    runtimes.push(restarted);
    await restarted.start();
    expect(restarted.list()).toEqual([]);
    expect(f.projects.has("mossbot-room-room-one")).toBe(false);
    expect(f.threads.size).toBe(0);
    expect(
      f.commands.some(
        (c) => c.type === "thread.turn.interrupt" && c.turnId === "turn-room:room-one:ask:a",
      ),
    ).toBe(true);
    expect((await readdir(f.directory)).filter((name) => name === "room-one")).toEqual([]);
    expect(JSON.parse(await readFile(path.join(f.directory, "rooms.json"), "utf8")).rooms).toEqual(
      [],
    );
    await expect(restarted.get("room-one")).rejects.toMatchObject({ code: "room_not_found" });
  });
});
