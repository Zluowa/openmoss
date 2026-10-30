import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ThreadId, TurnId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { projectCodexMcpToolCall } from "../../provider/Layers/CodexAdapter.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const tempDirectories: string[] = [];

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-mcp-activity-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectionThreadActivityRepository MCP projection durability", () => {
  it("round-trips the bounded typed result across a SQLite restart", async () => {
    const dbPath = await makeDbPath();
    const threadId = ThreadId.makeUnsafe("thread-mcp-persistence");
    const base64Sentinel = "r1-persistence-base64-sentinel";
    const blobSentinel = "r1-persistence-blob-sentinel";
    const bytesSentinel = "r1-persistence-bytes-sentinel";
    const dataUrlSentinel = "r1-persistence-data-url-sentinel";
    const originalTypeSentinel = "r1-persistence-credential-original-type-sentinel";
    const suppliedSentinels = [
      base64Sentinel,
      blobSentinel,
      bytesSentinel,
      dataUrlSentinel,
      originalTypeSentinel,
    ];
    const projection = projectCodexMcpToolCall(
      {
        type: "mcpToolCall",
        id: "call-mcp-persistence",
        server: "filesystem",
        tool: "read_file",
        arguments: {
          path: "/tmp/readme.txt",
          nested: {
            base64: base64Sentinel,
            blob: blobSentinel,
            bytes: bytesSentinel,
            media: `data:image/png;base64,${dataUrlSentinel}`,
          },
        },
        status: "completed",
        result: {
          content: [
            {
              type: "future",
              data: { ordinary: true },
              nested: { blob: blobSentinel },
            },
            { type: originalTypeSentinel, bytes: bytesSentinel },
            { type: "image", mimeType: "image/png", data: "r1-persistence-image-bytes" },
          ],
          structuredContent: {
            ordinaryData: { retained: true },
            nested: { bytes: bytesSentinel },
          },
        },
      },
      "item.completed",
    );
    if (!projection) {
      throw new Error("expected the persistence source to produce a projection");
    }
    expect(projection.truncation.deferredBinary).toBe(true);
    // Binary values are deferred to the attachment path, but this fixture is
    // still below the textual/structural projection limits.
    expect(projection.truncation.truncated).toBe(false);
    expect(projection.result?.structuredContent).toMatchObject({
      ordinaryData: { retained: true },
      nested: { mossBinaryDeferred: true },
    });
    const row = {
      activityId: EventId.makeUnsafe("activity-mcp-persistence"),
      threadId,
      turnId: TurnId.makeUnsafe("turn-mcp-persistence"),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "MCP tool call",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        data: projection,
      },
      sequence: 9,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    const repositoryLayer = ProjectionThreadActivityRepositoryLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        yield* repository.upsert(row);
        const stored = yield* repository.listByThreadId({ threadId });
        expect(stored).toEqual([row]);
      }).pipe(Effect.provide(repositoryLayer)),
    );

    const rawDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const storedPayload = rawDb
        .prepare(
          "SELECT payload_json AS payloadJson FROM projection_thread_activities WHERE activity_id = ?",
        )
        .get(row.activityId) as { payloadJson?: string } | undefined;
      expect(storedPayload?.payloadJson).toContain("codex.mcp_tool_call");
      for (const sentinel of suppliedSentinels) {
        expect(storedPayload?.payloadJson).not.toContain(sentinel);
      }
      expect(storedPayload?.payloadJson).not.toContain("data:image");
    } finally {
      rawDb.close();
    }

    const restored = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        return yield* repository.listByThreadId({ threadId });
      }).pipe(Effect.provide(repositoryLayer)),
    );
    expect(restored).toEqual([row]);
    for (const sentinel of suppliedSentinels) {
      expect(JSON.stringify(restored)).not.toContain(sentinel);
    }
    expect(JSON.stringify(restored)).not.toContain("data:image");
  });
});
