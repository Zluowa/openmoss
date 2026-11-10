import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProjectKind,
} from "@moss/contracts";
import { MossbotRoomRuntime, type RoomRuntimeDeps } from "./runtime";

const runtimes: MossbotRoomRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mossbot-room-"));
  directories.push(directory);
  const threads = new Map<string, OrchestrationThread>();
  const projects = new Map<string, ProjectKind>();
  const commands: OrchestrationCommand[] = [];
  let failAfterAccept = false;
  const deps: RoomRuntimeDeps = {
    directory,
    loadMember: async (id) => ({
      name: id === "a" ? "Nova" : "Atlas",
      icon: "mossbot-orbit",
      color: null,
      modelSelection: {
        provider: id === "a" ? "codex" : "hermes",
        model: "chosen",
        instanceId: `${id}-account`,
      },
      instructions: `Persona of ${id}`,
    }),
    projectKind: async (id) => projects.get(id) ?? null,
    thread: async (id) => threads.get(id) ?? null,
    dispatch: async (command) => {
      commands.push(structuredClone(command));
      if (command.type === "project.create")
        projects.set(command.projectId, command.kind ?? "project");
      if (command.type === "project.meta.update" && command.kind)
        projects.set(command.projectId, command.kind);
      if (command.type === "project.delete") projects.delete(command.projectId);
      if (command.type === "thread.delete") threads.delete(command.threadId);
      if (command.type === "thread.create")
        threads.set(command.threadId, {
          id: command.threadId,
          projectId: command.projectId,
          messages: [],
          latestTurn: null,
          session: null,
        } as unknown as OrchestrationThread);
      if (command.type === "thread.turn.interrupt") {
        const thread = threads.get(command.threadId)!;
        threads.set(thread.id, {
          ...thread,
          latestTurn: null,
          session: { status: "stopped", lastError: null },
        } as unknown as OrchestrationThread);
      }
      if (command.type === "thread.turn.start") {
        const thread = threads.get(command.threadId)!;
        const turnId = `turn-${command.message.messageId}`;
        threads.set(thread.id, {
          ...thread,
          messages: [
            ...thread.messages,
            {
              ...command.message,
              id: command.message.messageId,
              createdAt: command.createdAt,
              // The snapshot read links each user message to the turn it started.
              turnId,
            },
          ],
          latestTurn: { state: "running", turnId, requestedAt: command.createdAt },
          session: { status: "running", lastError: null },
        } as unknown as OrchestrationThread);
        if (failAfterAccept) {
          failAfterAccept = false;
          throw new Error("Response lost after commit");
        }
      }
    },
  };
  const runtime = new MossbotRoomRuntime(deps);
  runtimes.push(runtime);
  await runtime.start();
  const input = {
    requestId: "room-one",
    name: "Study group",
    memberProjectIds: [ProjectId.makeUnsafe("a"), ProjectId.makeUnsafe("b")],
    responder: "everyone" as const,
  };
  const room = await runtime.create(input);
  function finish(threadId: string, text = "Verified result") {
    const thread = threads.get(threadId)!;
    threads.set(threadId, {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: `reply-${thread.messages.length}`,
          role: "assistant",
          turnId: thread.latestTurn?.turnId ?? null,
          text,
          createdAt: new Date().toISOString(),
          streaming: false,
        },
      ],
      latestTurn: { ...thread.latestTurn, state: "completed" },
      session: { status: "ready", lastError: null },
    } as unknown as OrchestrationThread);
  }
  return {
    runtime,
    deps,
    input,
    room,
    commands,
    threads,
    finish,
    loseResponse: () => {
      failAfterAccept = true;
    },
  };
}
const sends = (commands: OrchestrationCommand[]) =>
  commands.filter((c) => c.type === "thread.turn.start");

describe("Mossbot shared group runtime", () => {
  it("runs members sequentially on their selected CLI/account, carrying preceding replies", async () => {
    const f = await setup();
    await f.runtime.send({
      roomId: f.room.id,
      requestId: "human-one",
      text: "Compare these approaches",
    });
    await f.runtime.reconcile();
    expect(sends(f.commands)).toHaveLength(1);
    expect(sends(f.commands)[0]).toMatchObject({
      threadId: f.room.members[0]!.threadId,
      modelSelection: { provider: "codex", instanceId: "a-account" },
      runtimeMode: "approval-required",
    });
    await f.runtime.reconcile();
    expect(sends(f.commands)).toHaveLength(1);
    f.finish(f.room.members[0]!.threadId, "Primary-source finding");
    await f.runtime.reconcile();
    await f.runtime.reconcile();
    expect(sends(f.commands)[1]).toMatchObject({
      threadId: f.room.members[1]!.threadId,
      modelSelection: { provider: "hermes", instanceId: "b-account" },
    });
    expect(sends(f.commands)[1]!.message.text).toContain("Primary-source finding");
    expect((await f.runtime.get(f.room.id)).replies[0]?.memberId).toBe("a");
  });
  it("uses current native assistant model and instructions for a new group turn", async () => {
    const f = await setup();
    const original = f.deps.loadMember;
    f.deps.loadMember = async (id) => ({
      ...(await original(id)),
      modelSelection: { provider: "codex", instanceId: "selected-account", model: "new-model" },
      instructions: "Updated native persona",
    });
    await f.runtime.send({ roomId: f.room.id, requestId: "updated-profile", text: "@Nova help" });
    await f.runtime.reconcile();
    expect(sends(f.commands)[0]).toMatchObject({
      modelSelection: { instanceId: "selected-account", model: "new-model" },
    });
    expect(sends(f.commands)[0]!.message.text).toContain("Updated native persona");
    expect((await f.runtime.get(f.room.id)).room.members[0]!.modelSelection.model).toBe(
      "new-model",
    );
  });
  it("does not execute a paused or removed assistant through a previously created room", async () => {
    const f = await setup();
    const original = f.deps.loadMember;
    f.deps.loadMember = async (id) => {
      if (id === "a") throw new Error("Assistant is paused");
      return original(id);
    };
    await f.runtime.send({
      roomId: f.room.id,
      requestId: "paused-profile",
      text: "@everyone help",
    });
    await f.runtime.reconcile();
    expect(sends(f.commands)).toHaveLength(0);
    expect((await f.runtime.get(f.room.id)).room.deliveries[0]).toMatchObject({
      state: "failed",
      error: "assistant_unavailable",
    });
    await f.runtime.reconcile();
    expect(sends(f.commands)).toHaveLength(1);
    expect(sends(f.commands)[0]!.threadId).toBe(f.room.members[1]!.threadId);
  });
  it("persists a bounded actual reply preview without truncating or duplicating room history", async () => {
    const f = await setup();
    await f.runtime.send({
      roomId: f.room.id,
      requestId: "preview-request",
      text: "@Nova show the source",
    });
    await f.runtime.reconcile();
    const text = "A verified source with details. ".repeat(20);
    f.finish(f.room.members[0]!.threadId, text);
    await f.runtime.reconcile();
    const preview = f.runtime.list()[0]!.lines[0]!;
    expect(preview.senderId).toBe("a");
    expect(preview.text).toBe(text.slice(0, 240));
    expect(preview.createdAt).toMatch(/^\d{4}-/);
    const detail = await f.runtime.get(f.room.id);
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0]!.message.text).toBe(text);
    expect(detail.room.lines).toHaveLength(1);
    await f.runtime.stop();
    const restarted = new MossbotRoomRuntime(f.deps);
    runtimes.push(restarted);
    await restarted.start();
    expect(restarted.list()[0]!.lines).toEqual([preview]);
  });
  it("reuses creation and send identities after a lost accepted response and restart", async () => {
    const f = await setup();
    await f.runtime.create(f.input);
    expect(f.commands.filter((c) => c.type === "thread.create")).toHaveLength(2);
    f.loseResponse();
    const input = { roomId: f.room.id, requestId: "human-one", text: "@Nova research this" };
    await f.runtime.send(input);
    await f.runtime.reconcile();
    await f.runtime.stop();
    const recovered = new MossbotRoomRuntime(f.deps);
    runtimes.push(recovered);
    await recovered.start();
    await recovered.send(input);
    await recovered.reconcile();
    expect(sends(f.commands)).toHaveLength(1);
    expect((await recovered.get(f.room.id)).room.lines).toHaveLength(1);
    await expect(recovered.send({ ...input, text: "different" })).rejects.toThrow(
      "different content",
    );
  });
  it("accepts peer posts only from an active room member, and never rebroadcasts ordinary replies", async () => {
    const f = await setup();
    await expect(
      f.runtime.send(
        { roomId: f.room.id, requestId: "outsider", text: "@Atlas work" },
        "other-thread",
      ),
    ).rejects.toThrow("not a member");
    await f.runtime.send({
      roomId: f.room.id,
      requestId: "human-one",
      text: "@Nova delegate a check",
    });
    await f.runtime.reconcile();
    await f.runtime.send(
      { roomId: f.room.id, requestId: "peer-one", text: "@Atlas verify this source" },
      f.room.members[0]!.threadId,
    );
    await f.runtime.send(
      { roomId: f.room.id, requestId: "peer-two", text: "I found a useful reference" },
      f.room.members[0]!.threadId,
    );
    expect((await f.runtime.get(f.room.id)).room.deliveries).toHaveLength(2);
    f.finish(f.room.members[0]!.threadId);
    await f.runtime.reconcile();
    await f.runtime.reconcile();
    expect(sends(f.commands)[1]?.threadId).toBe(f.room.members[1]!.threadId);
  });
  it("stops the active native turn and cancels queued speakers", async () => {
    const f = await setup();
    await f.runtime.send({ roomId: f.room.id, requestId: "human-one", text: "@everyone work" });
    await f.runtime.reconcile();
    await f.runtime.cancel(f.room.id);
    await f.runtime.reconcile();
    expect(sends(f.commands)).toHaveLength(1);
    expect(
      f.commands.some(
        (c) => c.type === "thread.turn.interrupt" && c.threadId === f.room.members[0]!.threadId,
      ),
    ).toBe(true);
    expect(
      (await f.runtime.get(f.room.id)).room.deliveries.every((d) => d.state === "cancelled"),
    ).toBe(true);
  });
  it("rejects ambiguous mentions before writing the human line", async () => {
    const f = await setup();
    const duplicateDeps = {
      ...f.deps,
      directory: path.join(f.deps.directory, "duplicate"),
      loadMember: async (id: ProjectId) => ({ ...(await f.deps.loadMember(id)), name: "Same" }),
    };
    const runtime = new MossbotRoomRuntime(duplicateDeps);
    runtimes.push(runtime);
    await runtime.start();
    const room = await runtime.create({ ...f.input, requestId: "duplicates" });
    await expect(
      runtime.send({ roomId: room.id, requestId: "message", text: "@Same research" }),
    ).rejects.toThrow("share this name");
    expect((await runtime.get(room.id)).room.lines).toHaveLength(0);
  });
  it("bounds peer exchanges even when posts do not request another reply", async () => {
    const f = await setup();
    await f.runtime.send({ roomId: f.room.id, requestId: "human-one", text: "@Nova research" });
    await f.runtime.reconcile();
    for (let i = 0; i < 23; i++)
      await f.runtime.send(
        { roomId: f.room.id, requestId: `note-${i}`, text: "A progress note" },
        f.room.members[0]!.threadId,
      );
    await expect(
      f.runtime.send(
        { roomId: f.room.id, requestId: "excess", text: "Another note" },
        f.room.members[0]!.threadId,
      ),
    ).rejects.toThrow("message limit");
    await f.runtime.cancel(f.room.id);
    await expect(
      f.runtime.send(
        { roomId: f.room.id, requestId: "after-stop", text: "@Atlas work" },
        f.room.members[0]!.threadId,
      ),
    ).rejects.toThrow("active room turn");
  });
  it("retries the same stop after a lost interruption request without starting queued work", async () => {
    const f = await setup();
    await f.runtime.send({ roomId: f.room.id, requestId: "human-one", text: "@everyone research" });
    await f.runtime.reconcile();
    const dispatch = f.deps.dispatch;
    let lost = false;
    f.deps.dispatch = async (command) => {
      if (command.type === "thread.turn.interrupt" && !lost) {
        lost = true;
        throw new Error("connection lost");
      }
      return dispatch(command);
    };
    await expect(f.runtime.cancel(f.room.id)).rejects.toThrow("connection lost");
    await f.runtime.reconcile();
    await f.runtime.reconcile();
    expect(sends(f.commands)).toHaveLength(1);
    expect(
      (await f.runtime.get(f.room.id)).room.deliveries.every((d) => d.state === "cancelled"),
    ).toBe(true);
  });
  it("keeps secret cards scoped to the member's native thread and exposes only their outcome", async () => {
    const f = await setup();
    const member = f.room.members[0]!;
    const thread = f.threads.get(member.threadId)!;
    f.threads.set(member.threadId, {
      ...thread,
      activities: [
        {
          kind: "secret.requested",
          payload: {
            requestId: `secret-request:${"a".repeat(32)}`,
            label: "Research key",
            reason: "Connect selected source",
            secret: "never-forward-this",
          },
        },
      ],
    } as unknown as OrchestrationThread);
    const view = await f.runtime.get(f.room.id);
    expect(view.secretRequests[0]?.threadId).toBe(member.threadId);
    expect(JSON.stringify(view)).not.toContain("never-forward-this");
  });
});

describe("upstream member controls backed by native rooms", () => {
  it("persists context and roster changes, retains removed history and revokes peer access", async () => {
    const f = await setup();
    const a = f.room.members[0]!,
      b = f.room.members[1]!;
    f.finish(a.threadId, "A historical answer");
    const updated = await f.runtime.update({
      roomId: f.room.id,
      expectedMemberProjectIds: [a.id, b.id],
      memberProjectIds: [b.id],
      responder: "mentions",
    });
    expect(updated.members.find((m) => m.id === a.id)?.hidden).toBe(true);
    expect((await f.runtime.get(f.room.id)).replies[0]?.message.text).toBe("A historical answer");
    await expect(
      f.runtime.send(
        { roomId: f.room.id, requestId: "removed-post", text: "@everyone hello" },
        a.threadId,
      ),
    ).rejects.toThrow("not a member");
    await f.runtime.send({
      roomId: f.room.id,
      requestId: "everyone-after-remove",
      text: "@everyone hello",
    });
    expect((await f.runtime.get(f.room.id)).room.deliveries.map((d) => d.memberId)).toEqual([b.id]);
    await f.runtime.stop();
    const restarted = new MossbotRoomRuntime(f.deps);
    runtimes.push(restarted);
    await restarted.start();
    expect((await restarted.get(f.room.id)).room.members.find((m) => m.id === a.id)?.hidden).toBe(
      true,
    );
  });
  it("adds a native member with its chosen provider and retries a lost settings acknowledgement", async () => {
    const f = await setup();
    const ids = f.room.members.map((m) => m.id);
    const c = ProjectId.makeUnsafe("c");
    const input = {
      roomId: f.room.id,
      expectedMemberProjectIds: ids,
      memberProjectIds: [c, ...ids],
      responder: "lead" as const,
    };
    const first = await f.runtime.update(input),
      retry = await f.runtime.update(input);
    expect(retry).toEqual(first);
    expect(first.members[0]?.modelSelection).toEqual({
      provider: "hermes",
      model: "chosen",
      instanceId: "c-account",
    });
    expect(f.commands.filter((c) => c.type === "thread.create")).toHaveLength(3);
    await f.runtime.send({ roomId: f.room.id, requestId: "new-lead", text: "Please review" });
    expect((await f.runtime.get(f.room.id)).room.deliveries.map((d) => d.memberId)).toEqual([c]);
  });
  it("rejects stale membership and changes while work is queued", async () => {
    const f = await setup();
    const ids = f.room.members.map((m) => m.id);
    await expect(
      f.runtime.update({
        roomId: f.room.id,
        expectedMemberProjectIds: [],
        memberProjectIds: ids,
        responder: "lead",
      }),
    ).rejects.toThrow("changed");
    await f.runtime.send({ roomId: f.room.id, requestId: "queued", text: "Hello" });
    await expect(
      f.runtime.update({
        roomId: f.room.id,
        expectedMemberProjectIds: ids,
        memberProjectIds: ids,
        responder: "mentions",
      }),
    ).rejects.toThrow("Stop the group");
  });
  it("stores the optional context and includes it in the native turn", async () => {
    const f = await setup();
    const room = await f.runtime.create({
      ...f.input,
      requestId: "with-context",
      section: "Launch review",
    });
    await f.runtime.send({ roomId: room.id, requestId: "context-message", text: "Review this" });
    await f.runtime.reconcile();
    expect((await f.runtime.get(room.id)).room.section).toBe("Launch review");
    expect(
      f.commands.some(
        (c) => c.type === "thread.turn.start" && c.message.text.includes("Launch review"),
      ),
    ).toBe(true);
  });
});

it("recovers an interrupted member save without resurrecting removed conversations", async () => {
  const f = await setup();
  const a = f.room.members[0]!,
    b = f.room.members[1]!;
  await f.runtime.update({
    roomId: f.room.id,
    expectedMemberProjectIds: [a.id, b.id],
    memberProjectIds: [b.id],
    responder: "mentions",
  });
  f.threads.delete(a.threadId);
  const dispatch = f.deps.dispatch;
  let fail = true;
  f.deps.dispatch = async (command) => {
    await dispatch(command);
    if (command.type === "thread.create" && fail) {
      fail = false;
      throw new Error("Lost member create acknowledgement");
    }
  };
  const input = {
    roomId: f.room.id,
    expectedMemberProjectIds: [b.id],
    memberProjectIds: [b.id, ProjectId.makeUnsafe("c")],
    responder: "everyone" as const,
  };
  await expect(f.runtime.update(input)).rejects.toThrow("Lost member");
  await f.runtime.stop();
  const recovered = new MossbotRoomRuntime(f.deps);
  runtimes.push(recovered);
  await recovered.start();
  expect(
    (await recovered.get(f.room.id)).room.members.filter((m) => !m.hidden).map((m) => m.id),
  ).toEqual(input.memberProjectIds);
  expect(f.threads.has(a.threadId)).toBe(false);
  await expect(recovered.update(input)).resolves.toMatchObject({ responder: "everyone" });
  expect(f.commands.filter((c) => c.type === "thread.create")).toHaveLength(3);
});

it("retries a pending native member save while the server stays online and blocks premature turns", async () => {
  const f = await setup(),
    dispatch = f.deps.dispatch;
  let fail = true;
  f.deps.dispatch = async (command) => {
    if (command.type === "thread.create" && fail) {
      fail = false;
      throw new Error("Connection interrupted");
    }
    return dispatch(command);
  };
  const input = {
    roomId: f.room.id,
    expectedMemberProjectIds: f.room.members.map((m) => m.id),
    memberProjectIds: [...f.room.members.map((m) => m.id), ProjectId.makeUnsafe("c")],
    responder: "everyone" as const,
  };
  await expect(f.runtime.update(input)).rejects.toThrow("interrupted");
  await expect(
    f.runtime.send({ roomId: f.room.id, requestId: "too-early", text: "Hello" }),
  ).rejects.toThrow("still being saved");
  await f.runtime.reconcile();
  await expect(
    f.runtime.send({ roomId: f.room.id, requestId: "after-recovery", text: "Hello" }),
  ).resolves.toMatchObject({ responder: "everyone" });
  expect(f.commands.filter((c) => c.type === "thread.create")).toHaveLength(3);
});

it("keeps other rooms and startup available while one native roster cannot initialize", async () => {
  const f = await setup();
  const other = await f.runtime.create({ ...f.input, requestId: "other-room" });
  const dispatch = f.deps.dispatch;
  f.deps.dispatch = async (command) => {
    if (command.type === "thread.create") throw new Error("Native thread unavailable");
    return dispatch(command);
  };
  await expect(
    f.runtime.update({
      roomId: f.room.id,
      expectedMemberProjectIds: f.room.members.map((m) => m.id),
      memberProjectIds: [...f.room.members.map((m) => m.id), ProjectId.makeUnsafe("c")],
      responder: "everyone",
    }),
  ).rejects.toThrow("unavailable");
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.runtime.send({ roomId: other.id, requestId: "other-work", text: "Hello" });
    await f.runtime.reconcile();
    expect(
      f.commands.some(
        (c) => c.type === "thread.turn.start" && c.threadId === other.members[0]!.threadId,
      ),
    ).toBe(true);
    await f.runtime.stop();
    const restarted = new MossbotRoomRuntime(f.deps);
    runtimes.push(restarted);
    await expect(restarted.start()).resolves.toBeUndefined();
    expect(restarted.list()).toHaveLength(2);
  } finally {
    warning.mockRestore();
  }
});

it("never shares a native identity when adding leads after removals and reordering", async () => {
  const f = await setup();
  let room = f.room;
  const change = async (ids: string[]) => {
    room = await f.runtime.update({
      roomId: room.id,
      expectedMemberProjectIds: room.members.filter((m) => !m.hidden).map((m) => m.id),
      memberProjectIds: ids.map((id) => ProjectId.makeUnsafe(id)),
      responder: "lead",
    });
  };
  await change(["a", "b", "c"]);
  await change(["d", "b", "c"]);
  await change(["e", "d", "b", "c"]);
  expect(new Set(room.members.map((m) => m.threadId)).size).toBe(room.members.length);
  for (const member of room.members)
    expect(f.commands).toContainEqual(
      expect.objectContaining({
        type: "thread.create",
        threadId: member.threadId,
        modelSelection: member.modelSelection,
      }),
    );
  expect(f.commands.filter((c) => c.type === "thread.create")).toHaveLength(5);
});
