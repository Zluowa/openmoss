// FILE: dispatchCommandNormalization.test.ts
// Purpose: Verifies client command normalization for managed workspaces and uploads.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  type ClientOrchestrationCommand,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import {
  HTML_RENDER_ACTIVITY_KIND,
  htmlRenderActivityPayload,
} from "@synara/shared/htmlRenderActivity";
import { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeDispatchCommandNormalizer,
  type DispatchCommandNormalizerResult,
} from "./dispatchCommandNormalization";

function projectCreateCommand(
  overrides: Partial<Extract<ClientOrchestrationCommand, { type: "project.create" }>> = {},
): Extract<ClientOrchestrationCommand, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: CommandId.makeUnsafe("cmd-project-create"),
    projectId: ProjectId.makeUnsafe("project-chat"),
    kind: "chat",
    title: "Chat",
    workspaceRoot: "/Users/tester/Documents/Moss/2026-06-11/chat",
    createWorkspaceRootIfMissing: true,
    createdAt: "2026-06-11T21:30:43.000Z",
    ...overrides,
  };
}

// Runs the normalized command's deferred `prepareWorkspaceRoot` effect (if any), mirroring
// what the wsRpc dispatchCommand handler does after a successful `orchestrationEngine.dispatch`.
async function runPrepareWorkspaceRoot<E>(result: DispatchCommandNormalizerResult<E>) {
  if (result.prepareWorkspaceRoot) {
    await Effect.runPromise(result.prepareWorkspaceRoot);
  }
}

describe("makeDispatchCommandNormalizer", () => {
  it("rejects client-dispatched html_render activities but passes other activities through", async () => {
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    });
    const appendActivity = (kind: string): ClientOrchestrationCommand => ({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`cmd-${kind}`),
      threadId: ThreadId.makeUnsafe("thread-1"),
      activity: {
        id: EventId.makeUnsafe(`activity-${kind}`),
        tone: "info",
        kind,
        summary: "Chart",
        payload: htmlRenderActivityPayload({
          attachmentId: "thread-1-00000000-0000-4000-8000-000000000001",
          title: "Chart",
          height: 400,
        }),
        turnId: null,
        createdAt: "2026-10-07T00:00:00.000Z",
      },
      createdAt: "2026-10-07T00:00:00.000Z",
    });

    const rejected = await Effect.runPromise(
      Effect.flip(normalizer({ command: appendActivity(HTML_RENDER_ACTIVITY_KIND) })),
    );
    expect(String(rejected)).toContain("published by html_render");

    const passed = await Effect.runPromise(normalizer({ command: appendActivity("tool.started") }));
    expect(passed.command).toMatchObject({ type: "thread.activity.append" });
  });

  it.each([
    { itemType: "image_generation" },
    { data: { itemType: "image_generation" } },
    { data: { item: { type: "image_generation" } } },
    { data: { item: { kind: "image_generation" } } },
    { type: "image_generation" },
    { kind: "image_generation" },
  ])("rejects client-forged generated image carriers (%j)", async (carrier) => {
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (root) => Effect.succeed(root),
    });
    const command: ClientOrchestrationCommand = {
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe("forged-image"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: "2026-10-15T00:00:00Z",
      activity: {
        id: EventId.makeUnsafe("forged-image"),
        kind: "tool.completed",
        tone: "tool",
        summary: "Generated image",
        turnId: null,
        createdAt: "2026-10-15T00:00:00Z",
        payload: {
          status: "completed",
          ...carrier,
          data: {
            kind: "moss.generated_image",
            path: "/tmp/forged.png",
            callId: "forged",
            ...carrier.data,
          },
        },
      },
    };
    const rejected = await Effect.runPromise(Effect.flip(normalizer({ command })));
    expect(String(rejected)).toContain("published by the server");
  });

  it("returns a deferred prepare effect instead of scaffolding during normalization", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Moss",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const result = await Effect.runPromise(normalizer({ command: projectCreateCommand() }));

    // Normalization alone must not have scaffolded anything yet.
    expect(preparedRoots).toEqual([]);
    expect(result.prepareWorkspaceRoot).not.toBeNull();

    await runPrepareWorkspaceRoot(result);

    // Only after the caller explicitly runs the deferred effect does scaffolding happen.
    expect(preparedRoots).toEqual(["/Users/tester/Documents/Moss/2026-06-11/chat"]);
  });

  it("retries the deferred prepare effect on transient failures before succeeding", async () => {
    let callCount = 0;
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Moss",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: () =>
        Effect.suspend(() => {
          callCount += 1;
          if (callCount < 3) {
            return Effect.fail(new Error("transient FS error"));
          }
          return Effect.void;
        }),
    });

    const result = await Effect.runPromise(normalizer({ command: projectCreateCommand() }));
    expect(result.prepareWorkspaceRoot).not.toBeNull();

    await runPrepareWorkspaceRoot(result);

    expect(callCount).toBe(3);
  });

  it("does not prepare ordinary projects or the chat workspace root itself", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Moss",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const first = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "project",
          workspaceRoot: "/Users/tester/Documents/Moss/2026-06-11/app",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(first);
    const second = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          workspaceRoot: "/Users/tester/Documents/Moss",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(second);

    expect(preparedRoots).toEqual([]);
  });

  it("prepares the Studio workspace root itself", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Moss",
      studioWorkspaceRoot: "/Users/tester/Documents/Moss/Studio",
      groupsWorkspaceRoot: "/Users/tester/Documents/Moss/Groups",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: () => Effect.void,
      prepareStudioWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const result = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/Users/tester/Documents/Moss/Studio",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(result);

    expect(preparedRoots).toEqual(["/Users/tester/Documents/Moss/Studio"]);
  });

  it("prepares nested Studio workspace roots but not ordinary projects under Studio", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      studioWorkspaceRoot: "/Users/tester/Documents/Moss/Studio",
      groupsWorkspaceRoot: "/Users/tester/Documents/Moss/Groups",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareStudioWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const first = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "studio",
          workspaceRoot: "/Users/tester/Documents/Moss/Studio/Outbox",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(first);
    const second = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "project",
          workspaceRoot: "/Users/tester/Documents/Moss/Studio/SomeProject",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(second);

    expect(preparedRoots).toEqual(["/Users/tester/Documents/Moss/Studio/Outbox"]);
  });

  it("roots a group create under Groups/<slug> and prepares that folder", async () => {
    const preparedRoots: string[] = [];
    const canonicalized: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      groupsWorkspaceRoot: "/Users/tester/Documents/Moss/Groups",
      fileSystem: {} as FileSystem.FileSystem,
      path: { join: (...parts: string[]) => parts.join("/") } as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => {
        canonicalized.push(workspaceRoot);
        return Effect.succeed(workspaceRoot);
      },
      prepareGroupWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const result = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "group",
          title: "Alpha Bot",
          workspaceRoot: "/tmp/ignored",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(result);

    expect(canonicalized).toEqual(["/Users/tester/Documents/Moss/Groups/alpha-bot"]);
    expect(result.command.type).toBe("project.create");
    if (result.command.type === "project.create") {
      expect(result.command.workspaceRoot).toBe("/Users/tester/Documents/Moss/Groups/alpha-bot");
    }
    expect(preparedRoots).toEqual(["/Users/tester/Documents/Moss/Groups/alpha-bot"]);
  });

  it("allocates a unique group folder when the slug is already taken", async () => {
    const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moss-groups-"));
    const takenDir = path.join(groupsRoot, "alpha-bot");
    fs.mkdirSync(takenDir, { recursive: true });
    const fileSystem = {
      readDirectory: (dir: string) =>
        Effect.try({
          try: () => fs.readdirSync(dir) as ReadonlyArray<string>,
          catch: () => new Error("readDirectory failed"),
        }),
    } as unknown as FileSystem.FileSystem;
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      groupsWorkspaceRoot: groupsRoot,
      fileSystem,
      path: path as unknown as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      listGroupWorkspaceRoots: () => Effect.succeed([]),
    });

    try {
      const result = await Effect.runPromise(
        normalizer({
          command: projectCreateCommand({
            kind: "group",
            title: "Alpha Bot",
            workspaceRoot: "/tmp/ignored",
          }),
        }),
      );

      expect(result.command.type).toBe("project.create");
      if (result.command.type === "project.create") {
        expect(result.command.workspaceRoot).toBe(path.join(groupsRoot, "alpha-bot-2"));
      }
    } finally {
      fs.rmSync(groupsRoot, { recursive: true, force: true });
    }
  });

  it("skips the folder claimed by another group project in the read model", async () => {
    const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moss-groups-"));
    const takenDir = path.join(groupsRoot, "alpha-bot");
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      groupsWorkspaceRoot: groupsRoot,
      fileSystem: {} as FileSystem.FileSystem,
      path: path as unknown as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      listGroupWorkspaceRoots: () =>
        Effect.succeed([
          {
            projectId: ProjectId.makeUnsafe("project-other-group"),
            workspaceRoot: takenDir,
          },
        ]),
    });

    try {
      const result = await Effect.runPromise(
        normalizer({
          command: projectCreateCommand({
            kind: "group",
            projectId: ProjectId.makeUnsafe("project-new-group"),
            title: "Alpha Bot",
            workspaceRoot: "/tmp/ignored",
          }),
        }),
      );

      expect(result.command.type).toBe("project.create");
      if (result.command.type === "project.create") {
        expect(result.command.workspaceRoot).toBe(path.join(groupsRoot, "alpha-bot-2"));
      }
    } finally {
      fs.rmSync(groupsRoot, { recursive: true, force: true });
    }
  });

  it("keeps the group's own folder on meta.update instead of bumping to a suffix", async () => {
    const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moss-groups-"));
    const ownDir = path.join(groupsRoot, "alpha-bot");
    fs.mkdirSync(ownDir, { recursive: true });
    const fileSystem = {
      readDirectory: (dir: string) =>
        Effect.try({
          try: () => fs.readdirSync(dir) as ReadonlyArray<string>,
          catch: () => new Error("readDirectory failed"),
        }),
    } as unknown as FileSystem.FileSystem;
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      groupsWorkspaceRoot: groupsRoot,
      fileSystem,
      path: path as unknown as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      listGroupWorkspaceRoots: () =>
        Effect.succeed([
          {
            projectId: ProjectId.makeUnsafe("project-alpha"),
            workspaceRoot: ownDir,
          },
        ]),
    });

    try {
      const result = await Effect.runPromise(
        normalizer({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-meta-update"),
            projectId: ProjectId.makeUnsafe("project-alpha"),
            kind: "group",
            title: "Alpha Bot",
            workspaceRoot: ownDir,
          } satisfies Extract<ClientOrchestrationCommand, { type: "project.meta.update" }>,
        }),
      );

      expect(result.command.type).toBe("project.meta.update");
      if (result.command.type === "project.meta.update") {
        expect(result.command.workspaceRoot).toBe(ownDir);
      }
    } finally {
      fs.rmSync(groupsRoot, { recursive: true, force: true });
    }
  });

  it("defers binary attachment authority to the transactional managed ledger", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-dispatch-normalize-"));
    const validId = "thread-rollback-attachments-11111111-1111-4111-8111-111111111111";
    const validPath = path.join(attachmentsDir, `${validId}.png`);
    fs.writeFileSync(validPath, Buffer.from([1]));
    const fileSystem = {
      stat: (filePath: string) =>
        Effect.try({
          try: () => {
            const info = fs.statSync(filePath);
            return { type: "File", size: BigInt(info.size) };
          },
          catch: (cause) => new Error("stat failed", { cause }),
        }),
    } as unknown as FileSystem.FileSystem;
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir,
      fileSystem,
      path: path as unknown as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    });

    try {
      const result = await Effect.runPromise(
        normalizer({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-attachments"),
            threadId: ThreadId.makeUnsafe("thread-rollback-attachments"),
            message: {
              messageId: MessageId.makeUnsafe("msg-attachments"),
              role: "user",
              text: "send files",
              attachments: [
                {
                  type: "image",
                  id: validId,
                  name: "ok.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
                {
                  type: "image",
                  id: "thread-rollback-attachments-22222222-2222-4222-8222-222222222222",
                  name: "bad.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
          } satisfies Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
        }),
      );

      expect(result.command.type).toBe("thread.turn.start");
      if (result.command.type === "thread.turn.start") {
        expect(result.command.message.attachments).toHaveLength(2);
      }
      expect(fs.readFileSync(validPath)).toEqual(Buffer.from([1]));
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
