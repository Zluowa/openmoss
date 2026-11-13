import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { assert, it } from "@effect/vitest";
import {
  MossbotRoomSendInput,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProjectKind,
} from "@moss/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { attachmentPrincipalForSession } from "../managedAttachmentPrincipal.ts";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../managedAttachmentStore.ts";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import { makeRoomAttachmentStore } from "./attachments.ts";
import { MossbotRoomRuntime } from "./runtime.ts";

const layer = ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const phone = attachmentPrincipalForSession("phone-session");

type Fixture = {
  repository: ManagedAttachmentRepositoryShape;
  attachmentsDir: string;
  runtime: MossbotRoomRuntime;
  commands: OrchestrationCommand[];
  threads: Map<string, OrchestrationThread>;
};

/** A room runtime over a real attachment repository, with the engine replaced by a recorder. */
function withRoom<A, E>(run: (fixture: Fixture) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    Effect.tryPromise(() => fs.mkdtemp(path.join(os.tmpdir(), "room-attachments-"))),
    (root) =>
      Effect.gen(function* () {
        const repository = yield* ManagedAttachmentRepository;
        const attachmentsDir = path.join(root, "attachments");
        const threads = new Map<string, OrchestrationThread>();
        const projects = new Map<string, ProjectKind>();
        const commands: OrchestrationCommand[] = [];
        const runtime = new MossbotRoomRuntime({
          directory: path.join(root, "rooms"),
          attachments: makeRoomAttachmentStore({ repository, attachmentsDir }),
          loadMember: async (id) => ({
            name: id === "a" ? "Nova" : "Atlas",
            icon: null,
            color: null,
            modelSelection: { provider: "codex", model: "chosen" },
            instructions: "",
          }),
          projectKind: async (id) => projects.get(id) ?? null,
          thread: async (id) => threads.get(id) ?? null,
          dispatch: async (command) => {
            commands.push(structuredClone(command));
            if (command.type === "project.create")
              projects.set(command.projectId, command.kind ?? "project");
            if (command.type === "project.delete") projects.delete(command.projectId);
            if (command.type === "thread.delete") threads.delete(command.threadId);
            if (command.type === "thread.create")
              threads.set(command.threadId, {
                id: command.threadId,
                messages: [],
                latestTurn: null,
              } as unknown as OrchestrationThread);
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
                    turnId,
                  },
                ],
                latestTurn: { state: "completed", turnId },
              } as unknown as OrchestrationThread);
            }
          },
        });
        yield* Effect.promise(() => runtime.start());
        return yield* run({ repository, attachmentsDir, runtime, commands, threads }).pipe(
          Effect.ensuring(Effect.promise(() => runtime.stop())),
        );
      }),
    (root) =>
      Effect.tryPromise(() => fs.rm(root, { recursive: true, force: true })).pipe(Effect.orDie),
  ).pipe(Effect.provide(layer));
}

/** What the phone does before a post: one upload staged under the room's project id. */
function upload(fixture: Fixture, ownerThreadId: string, name = "plan.png", body = "picture") {
  return Effect.gen(function* () {
    const now = new Date().toISOString();
    const reservation = yield* reserveManagedAttachmentUpload({
      type: "image",
      threadId: ownerThreadId,
      name,
      mimeType: "image/png",
      reservedBytes: body.length,
      now,
      principal: phone,
      repository: fixture.repository,
    });
    return yield* persistReservedManagedAttachment({
      reservation,
      bytes: Buffer.from(body),
      attachmentsDir: fixture.attachmentsDir,
      now,
      principal: phone,
      repository: fixture.repository,
    });
  });
}

const createRoom = (fixture: Fixture) =>
  Effect.promise(() =>
    fixture.runtime.create({
      requestId: "room-one",
      name: "Study group",
      memberProjectIds: [ProjectId.makeUnsafe("a"), ProjectId.makeUnsafe("b")],
      responder: "everyone",
    }),
  );

const turnStarts = (commands: OrchestrationCommand[]) =>
  commands.flatMap((command) => (command.type === "thread.turn.start" ? [command] : []));

it.effect("keeps a post's attachment on its line and gives every member its own copy", () =>
  withRoom((fixture) =>
    Effect.gen(function* () {
      const room = yield* createRoom(fixture);
      const uploaded = yield* upload(fixture, room.projectId);
      const send = () =>
        fixture.runtime.send(
          { roomId: room.id, requestId: "post-1", text: "", attachments: [uploaded] },
          undefined,
          phone,
        );
      const posted = yield* Effect.promise(send);
      assert.deepEqual(posted.lines.at(-1)?.attachments, [uploaded]);
      // A retried request is the same post, not a second claim.
      assert.equal((yield* Effect.promise(send)).lines.length, 1);

      // Members answer in turn: each pass starts or settles one of them.
      for (let pass = 0; pass < 4; pass++) yield* Effect.promise(() => fixture.runtime.reconcile());
      const starts = turnStarts(fixture.commands);
      assert.equal(starts.length, 2);
      const copies = starts.map((start) => start.message.attachments[0]!);
      for (const [index, start] of starts.entries()) {
        const copy = copies[index]!;
        assert.notEqual(copy.id, uploaded.id);
        assert.include(start.message.text, "plan.png");
        // The copy waits in the member's thread for the engine (the loopback principal) to claim.
        const staged = yield* fixture.repository.findServerOwned({
          attachmentId: copy.id,
          ownerThreadId: start.threadId,
          ownerKind: "local-loopback",
          ownerId: "local-loopback",
          now: new Date().toISOString(),
        });
        assert.equal(Option.getOrThrow(staged).sizeBytes, uploaded.sizeBytes);
      }
      assert.notEqual(copies[0]!.id, copies[1]!.id);

      const view = yield* Effect.promise(() => fixture.runtime.get(room.id));
      assert.deepEqual(
        view.room.lines.map((line) => line.attachments?.map((attachment) => attachment.name)),
        [["plan.png"]],
      );
      // The room's own copy stays readable for the transcript until the room goes.
      assert.isTrue(
        Option.isSome(yield* fixture.repository.findClaimedById({ attachmentId: uploaded.id })),
      );
      yield* Effect.promise(() => fixture.runtime.delete(room.id));
      assert.isTrue(
        Option.isNone(yield* fixture.repository.findClaimedById({ attachmentId: uploaded.id })),
      );
    }),
  ),
);

it.effect("refuses an attachment another session uploaded or one staged for another room", () =>
  withRoom((fixture) =>
    Effect.gen(function* () {
      const room = yield* createRoom(fixture);
      const mine = yield* upload(fixture, room.projectId);
      const elsewhere = yield* upload(fixture, "some-other-thread", "other.png");
      const attempt = (attachment: typeof mine, uploader = phone) =>
        Effect.promise(() =>
          fixture.runtime
            .send(
              { roomId: room.id, requestId: "post-1", text: "look", attachments: [attachment] },
              undefined,
              uploader,
            )
            .then(
              () => "sent",
              (error: { code?: string }) => error.code,
            ),
        );
      assert.equal(
        yield* attempt(mine, attachmentPrincipalForSession("someone-else")),
        "attachment_unavailable",
      );
      assert.equal(yield* attempt(elsewhere), "attachment_unavailable");
      const view = yield* Effect.promise(() => fixture.runtime.get(room.id));
      assert.equal(view.room.lines.length, 0);
      assert.equal(yield* attempt(mine), "sent");
    }),
  ),
);

it("accepts a post with attachments and no text, and refuses an empty one", () => {
  const decode = Schema.decodeUnknownSync(MossbotRoomSendInput);
  const attachment = {
    type: "file",
    id: "att_1",
    name: "a.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
  };
  assert.equal(
    decode({ roomId: "r", requestId: "q", text: "", attachments: [attachment] }).attachments
      ?.length,
    1,
  );
  assert.throws(() => decode({ roomId: "r", requestId: "q", text: "" }));
  assert.throws(() =>
    decode({
      roomId: "r",
      requestId: "q",
      text: "x",
      attachments: Array.from({ length: 9 }, () => attachment),
    }),
  );
});
