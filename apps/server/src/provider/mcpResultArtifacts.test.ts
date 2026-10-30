import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CODEX_PROVIDER_RUNTIME_ATTACHMENT_PRINCIPAL,
  attachmentPrincipalForProviderRuntime,
} from "../managedAttachmentPrincipal.ts";
import { makeManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  MCP_RESULT_ARTIFACT_LIMITS,
  materializeMcpResultArtifacts,
  type McpImageResultCandidate,
  type McpAudioResultCandidate,
  type McpResultArtifact,
  type McpResultArtifactCandidate,
  type McpResultArtifactStore,
} from "./mcpResultArtifacts.ts";

const layer = it.layer(
  Layer.mergeAll(
    makeManagedAttachmentRepositoryLive().pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const resetSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM managed_attachment_cleanup_jobs`;
  yield* sql`DELETE FROM managed_attachment_blobs`;
});

const bytesForMime = (mimeType: string): Uint8Array => {
  switch (mimeType) {
    case "image/png":
      return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    case "image/jpeg":
      return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1]);
    case "image/webp":
      return Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);
    case "image/gif":
      return Uint8Array.from([...Buffer.from("GIF89a"), 1]);
    case "audio/mpeg":
      return Uint8Array.from([...Buffer.from("ID3"), 1]);
    case "audio/wav":
      return Uint8Array.from([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WAVE"), 1]);
    case "audio/ogg":
      return Uint8Array.from([...Buffer.from("OggS"), 1]);
    case "audio/webm":
      return Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
    case "audio/mp4":
      return Uint8Array.from([0, 0, 0, 0, ...Buffer.from("ftyp"), 0, 0, 0, 0, 1]);
    default:
      return Uint8Array.from([1, 2, 3]);
  }
};

const encoded = (mimeType: string) => Buffer.from(bytesForMime(mimeType)).toString("base64");

const candidate = (
  blockIndex: number,
  type: "image" | "audio",
  mimeType: string,
  data = encoded(mimeType),
): McpImageResultCandidate | McpAudioResultCandidate => ({ blockIndex, type, mimeType, data });

const makeStore = (
  repository: Parameters<typeof materializeMcpResultArtifacts>[0]["store"]["repository"],
): { readonly root: string; readonly store: McpResultArtifactStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moss-mcp-artifacts-"));
  return { root, store: { attachmentsDir: root, repository } };
};

const makeFileRuntime = (root: string) => {
  const persistence = makeSqlitePersistenceLive(path.join(root, "state.sqlite"));
  const repository = makeManagedAttachmentRepositoryLive().pipe(Layer.provideMerge(persistence));
  return ManagedRuntime.make(
    Layer.mergeAll(persistence, repository).pipe(Layer.provideMerge(NodeServices.layer)),
  );
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

layer("MCP result artifacts", (it) => {
  it.effect(
    "exposes bounded provider-runtime ownership and materializes every allowlisted signature",
    () =>
      Effect.gen(function* () {
        yield* resetSchema;
        const repository = yield* ManagedAttachmentRepository;
        const { root, store } = makeStore(repository);
        try {
          assert.deepStrictEqual(attachmentPrincipalForProviderRuntime(), {
            ownerKind: "provider-runtime",
            ownerId: "codex",
          });
          assert.deepStrictEqual(CODEX_PROVIDER_RUNTIME_ATTACHMENT_PRINCIPAL, {
            ownerKind: "provider-runtime",
            ownerId: "codex",
          });
          const mimeTypes = [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "audio/mpeg",
            "audio/wav",
            "audio/ogg",
            "audio/webm",
            "audio/mp4",
          ] as const;
          const results: McpResultArtifact[] = [];
          for (const [index, mime] of mimeTypes.entries()) {
            const [result] = yield* materializeMcpResultArtifacts({
              threadId: "thread-artifacts",
              callId: `native-call-full-id-${index}`,
              candidates: [candidate(0, mime.startsWith("image/") ? "image" : "audio", mime)],
              store,
              now: "2026-08-29T10:00:00.000Z",
            });
            if (!result) throw new Error(`Missing result for block ${index}`);
            results.push(result);
          }
          assert.strictEqual(results.length, mimeTypes.length);
          for (const [index, result] of results.entries()) {
            if (!result || result.state !== "available") {
              throw new Error(JSON.stringify({ index, result }));
            }
            const bytes = bytesForMime(mimeTypes[index]!);
            assert.strictEqual(result.mimeType, mimeTypes[index]);
            assert.strictEqual(result.sizeBytes, bytes.byteLength);
            assert.strictEqual(result.sha256, sha256(bytes));
            assert.match(result.name, /^mcp-block-0\./);
            const row = yield* repository.findClaimedById({ attachmentId: result.attachmentId });
            assert.strictEqual(Option.getOrNull(row)?.state, "claimed");
            const file = fs.readFileSync(path.join(root, Option.getOrNull(row)!.relativePath));
            const fileStat = fs.lstatSync(path.join(root, Option.getOrNull(row)!.relativePath));
            assert.isTrue(fileStat.isFile());
            assert.isFalse(fileStat.isSymbolicLink());
            if (process.platform !== "win32") assert.strictEqual(fileStat.mode & 0o777, 0o600);
            assert.deepStrictEqual(Uint8Array.from(file), bytes);
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "rejects strict decoder and MIME policy violations without reserving or leaking source data",
    () =>
      Effect.gen(function* () {
        yield* resetSchema;
        const repository = yield* ManagedAttachmentRepository;
        const { root, store } = makeStore(repository);
        const secret = "U0VDUkVUX1NJTkdMRVRPTg==";
        try {
          const candidates: McpResultArtifactCandidate[] = [
            candidate(0, "image", "image/png", "not-base64"),
            candidate(1, "image", "image/png", "YWJj\n"),
            candidate(2, "image", "image/png", "YQ==="),
            candidate(3, "image", "image/png", ""),
            candidate(4, "image", "image/png", "YR=="),
            candidate(5, "image", "image/jpeg", encoded("image/png")),
            candidate(6, "image", "image/svg+xml", encoded("image/png")),
            candidate(7, "image", "application/octet-stream", secret),
            { blockIndex: 8, type: "blob", mimeType: "application/octet-stream", data: secret },
          ];
          const results = yield* materializeMcpResultArtifacts({
            threadId: "thread-policy",
            callId: "call-policy",
            candidates,
            store,
            now: "2026-08-29T10:01:00.000Z",
          });
          assert.deepStrictEqual(
            results.map((result) => result.state === "deferred" && result.reason),
            [
              "invalid-base64",
              "invalid-base64",
              "invalid-base64",
              "empty-binary",
              "invalid-base64",
              "mime-signature-mismatch",
              "unsupported-mime",
              "unsupported-mime",
              "unsupported-mime",
            ],
          );
          const serialized = JSON.stringify(results);
          assert.isFalse(serialized.includes(secret));
          assert.isFalse(serialized.includes("data:"));
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM managed_attachment_blobs
          `;
          assert.strictEqual(rows[0]?.count, 0);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "preflights block, aggregate and count limits before decoding and keeps valid blocks independent",
    () =>
      Effect.gen(function* () {
        yield* resetSchema;
        const repository = yield* ManagedAttachmentRepository;
        const { root, store } = makeStore(repository);
        try {
          const mp3 = encoded("audio/mpeg");
          const results = yield* materializeMcpResultArtifacts({
            threadId: "thread-limits",
            callId: "call-limits",
            candidates: [
              candidate(0, "audio", "audio/mpeg", mp3),
              candidate(1, "audio", "audio/mpeg", mp3),
              candidate(2, "audio", "audio/mpeg", mp3),
            ],
            store,
            now: "2026-08-29T10:02:00.000Z",
            limits: { maxBlockBytes: 4, maxAggregateBytes: 7, maxBlocks: 2 },
          });
          assert.deepStrictEqual(
            results.map((result) => (result.state === "deferred" ? result.reason : result.state)),
            ["available", "aggregate-size-limit", "aggregate-size-limit"],
          );

          yield* resetSchema;
          const blockLimited = yield* materializeMcpResultArtifacts({
            threadId: "thread-block-limit",
            callId: "call-block-limit",
            candidates: [candidate(0, "audio", "audio/mpeg", mp3)],
            store,
            now: "2026-08-29T10:03:00.000Z",
            limits: { maxBlockBytes: 2 },
          });
          assert.strictEqual(blockLimited[0]?.state, "deferred");
          assert.strictEqual(
            blockLimited[0]?.state === "deferred" && blockLimited[0].reason,
            "block-size-limit",
          );

          yield* resetSchema;
          const countLimited = yield* materializeMcpResultArtifacts({
            threadId: "thread-count-limit",
            callId: "call-count-limit",
            candidates: [
              candidate(0, "audio", "audio/mpeg", mp3),
              candidate(1, "audio", "audio/mpeg", mp3),
            ],
            store,
            now: "2026-08-29T10:04:00.000Z",
            limits: { maxBlocks: 1 },
          });
          assert.strictEqual(countLimited[1]?.state, "deferred");
          assert.strictEqual(
            countLimited[1]?.state === "deferred" && countLimited[1].reason,
            "block-count-limit",
          );
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

  it.effect("rejects oversized encoded payloads before allocating decoded bytes", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const { root, store } = makeStore(repository);
      try {
        const oversizedBytes = Uint8Array.from([...Buffer.from("ID3"), ...new Uint8Array(1024)]);
        const oversized = Buffer.from(oversizedBytes).toString("base64");
        const results = yield* materializeMcpResultArtifacts({
          threadId: "thread-encoded-preflight",
          callId: "call-encoded-preflight",
          candidates: [candidate(0, "audio", "audio/mpeg", oversized)],
          store,
          now: "2026-08-29T10:04:30.000Z",
          limits: { maxBlockBytes: 16, maxAggregateBytes: 16 },
        });
        assert.deepStrictEqual(results[0], {
          blockIndex: 0,
          mediaKind: "audio",
          state: "deferred",
          reason: "block-size-limit",
          mimeType: "audio/mpeg",
        });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM managed_attachment_blobs
        `;
        assert.strictEqual(rows[0]?.count, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("replays the exact MCP block without reserving a second object", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const { root, store } = makeStore(repository);
      try {
        const input = {
          threadId: "thread-replay",
          callId: "call-replay-full",
          candidates: [candidate(0, "image", "image/png")],
          store,
          now: "2026-08-29T10:05:00.000Z",
        } as const;
        const first = yield* materializeMcpResultArtifacts(input);
        const second = yield* materializeMcpResultArtifacts(input);
        assert.strictEqual(first[0]?.state, "available");
        assert.strictEqual(second[0]?.state, "available");
        if (first[0]?.state !== "available" || second[0]?.state !== "available") return;
        assert.strictEqual(second[0].attachmentId, first[0].attachmentId);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly state: string; readonly count: number }>`
            SELECT state, COUNT(*) AS count
            FROM managed_attachment_blobs
            GROUP BY state
            ORDER BY state
          `;
        assert.deepStrictEqual(rows, [{ state: "claimed", count: 1 }]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("fails closed when a claimed local artifact is missing", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const { root, store } = makeStore(repository);
      try {
        const input = {
          threadId: "thread-missing-artifact",
          callId: "call-missing-artifact",
          candidates: [candidate(0, "audio", "audio/mpeg")],
          store,
          now: "2026-08-29T10:05:30.000Z",
        } as const;
        const first = yield* materializeMcpResultArtifacts(input);
        if (first[0]?.state !== "available") throw new Error("fixture did not materialize");
        const row = Option.getOrNull(
          yield* repository.findClaimedById({ attachmentId: first[0].attachmentId }),
        );
        if (!row) throw new Error("claimed row is missing");
        fs.unlinkSync(path.join(root, row.relativePath));
        const replay = yield* materializeMcpResultArtifacts(input);
        assert.deepStrictEqual(replay[0], {
          blockIndex: 0,
          mediaKind: "audio",
          state: "deferred",
          reason: "artifact-unavailable",
          mimeType: "audio/mpeg",
        });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM managed_attachment_blobs
        `;
        assert.strictEqual(rows[0]?.count, 1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("continues after quota, reserve and claim failures with bounded deferred results", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const { root, store } = makeStore(repository);
      const valid = candidate(0, "image", "image/png");
      try {
        const quotaRepository = {
          ...repository,
          reserve: () => Effect.succeed({ status: "quota-exceeded" as const }),
        };
        const quotaResult = yield* materializeMcpResultArtifacts({
          threadId: "thread-failure-quota",
          callId: "call-failure-quota",
          candidates: [valid],
          store: { ...store, repository: quotaRepository },
          now: "2026-08-29T10:06:00.000Z",
        });
        assert.strictEqual(quotaResult[0]?.state, "deferred");
        assert.strictEqual(
          quotaResult[0]?.state === "deferred" && quotaResult[0].reason,
          "quota-exceeded",
        );

        yield* resetSchema;
        const reserveRepository = {
          ...repository,
          reserve: () =>
            Effect.fail(new PersistenceSqlError({ operation: "test", detail: "reserve failure" })),
        };
        const reserveResult = yield* materializeMcpResultArtifacts({
          threadId: "thread-failure-reserve",
          callId: "call-failure-reserve",
          candidates: [valid],
          store: { ...store, repository: reserveRepository },
          now: "2026-08-29T10:07:00.000Z",
        });
        assert.strictEqual(reserveResult[0]?.state, "deferred");
        assert.strictEqual(
          reserveResult[0]?.state === "deferred" && reserveResult[0].reason,
          "storage-failed",
        );

        yield* resetSchema;
        const claimRepository = {
          ...repository,
          claimOrReuseMcpBlock: () =>
            Effect.succeed({ status: "rejected" as const, reason: "already-claimed" as const }),
        };
        const claimResult = yield* materializeMcpResultArtifacts({
          threadId: "thread-failure-claim",
          callId: "call-failure-claim",
          candidates: [valid],
          store: { ...store, repository: claimRepository },
          now: "2026-08-29T10:08:00.000Z",
        });
        assert.strictEqual(claimResult[0]?.state, "deferred");
        assert.strictEqual(
          claimResult[0]?.state === "deferred" && claimResult[0].reason,
          "claim-rejected",
        );
        const sql = yield* SqlClient.SqlClient;
        const rejectedRows = yield* sql<{ readonly state: string }>`
            SELECT state
            FROM managed_attachment_blobs
            WHERE owner_thread_id = 'thread-failure-claim'
          `;
        assert.deepStrictEqual(rejectedRows, [{ state: "deleting" }]);
        const rejectedJobs = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM managed_attachment_cleanup_jobs
            WHERE attachment_id IN (
              SELECT attachment_id
              FROM managed_attachment_blobs
              WHERE owner_thread_id = 'thread-failure-claim'
            )
          `;
        assert.strictEqual(rejectedJobs[0]?.count, 1);

        yield* resetSchema;
        const writeBlocker = path.join(root, "not-a-directory");
        fs.writeFileSync(writeBlocker, "blocker");
        const writeResult = yield* materializeMcpResultArtifacts({
          threadId: "thread-failure-write",
          callId: "call-failure-write",
          candidates: [valid],
          store: { ...store, attachmentsDir: writeBlocker },
          now: "2026-08-29T10:08:30.000Z",
        });
        assert.strictEqual(writeResult[0]?.state, "deferred");
        assert.strictEqual(
          writeResult[0]?.state === "deferred" && writeResult[0].reason,
          "storage-failed",
        );
        const writeRows = yield* sql<{ readonly state: string }>`
            SELECT state
            FROM managed_attachment_blobs
            WHERE owner_thread_id = 'thread-failure-write'
          `;
        assert.deepStrictEqual(writeRows, [{ state: "deleting" }]);
        fs.unlinkSync(writeBlocker);

        yield* resetSchema;
        const finalizeRepository = {
          ...repository,
          finalizeStaged: () => Effect.succeed({ status: "not-uploading" as const }),
        };
        const finalizeResult = yield* materializeMcpResultArtifacts({
          threadId: "thread-failure-finalize",
          callId: "call-failure-finalize",
          candidates: [valid],
          store: { ...store, repository: finalizeRepository },
          now: "2026-08-29T10:09:00.000Z",
        });
        assert.strictEqual(finalizeResult[0]?.state, "deferred");
        assert.strictEqual(
          finalizeResult[0]?.state === "deferred" && finalizeResult[0].reason,
          "storage-failed",
        );
        const finalizeRows = yield* sql<{ readonly state: string }>`
            SELECT state
            FROM managed_attachment_blobs
            WHERE owner_thread_id = 'thread-failure-finalize'
          `;
        assert.deepStrictEqual(finalizeRows, [{ state: "deleting" }]);

        const serialized = JSON.stringify(claimResult);
        assert.isFalse(serialized.includes(valid.data));
        assert.isFalse(serialized.includes("data:"));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("fails closed for invalid references and preserves valid blocks in a mixed call", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const { root, store } = makeStore(repository);
      try {
        const results = yield* materializeMcpResultArtifacts({
          threadId: "",
          callId: "call-mixed",
          candidates: [candidate(0, "image", "image/png"), candidate(1, "audio", "audio/mpeg")],
          store,
          now: "2026-08-29T10:09:00.000Z",
        });
        assert.deepStrictEqual(
          results.map((result) => result.state === "deferred" && result.reason),
          ["invalid-reference", "invalid-reference"],
        );

        const mixed = yield* materializeMcpResultArtifacts({
          threadId: "thread-mixed",
          callId: "call-mixed",
          candidates: [
            candidate(0, "image", "image/png"),
            candidate(1, "image", "image/png", "bad"),
            candidate(2, "audio", "audio/mpeg"),
          ],
          store,
          now: "2026-08-29T10:10:00.000Z",
        });
        assert.deepStrictEqual(
          mixed.map((result) => result.state),
          ["available", "deferred", "available"],
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rehydrates the same claimed artifact after SQLite and filesystem teardown", () =>
    Effect.gen(function* () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "moss-mcp-artifacts-restart-"));
      const attachmentsDir = path.join(root, "attachments");
      const firstRuntime = makeFileRuntime(root);
      try {
        const firstRepository = yield* Effect.promise(() =>
          firstRuntime.runPromise(Effect.service(ManagedAttachmentRepository)),
        );
        const first = yield* Effect.promise(() =>
          firstRuntime.runPromise(
            materializeMcpResultArtifacts({
              threadId: "thread-restart",
              callId: "call-restart",
              candidates: [candidate(0, "image", "image/png")],
              store: { attachmentsDir, repository: firstRepository },
              now: "2026-08-29T10:11:00.000Z",
            }),
          ),
        );
        assert.strictEqual(first[0]?.state, "available");
        if (first[0]?.state !== "available") return;
        const originalId = first[0].attachmentId;
        const originalBytes = bytesForMime("image/png");
        yield* Effect.promise(() => firstRuntime.dispose());

        const recoveredRuntime = makeFileRuntime(root);
        try {
          const recoveredRepository = yield* Effect.promise(() =>
            recoveredRuntime.runPromise(Effect.service(ManagedAttachmentRepository)),
          );
          const replay = yield* Effect.promise(() =>
            recoveredRuntime.runPromise(
              materializeMcpResultArtifacts({
                threadId: "thread-restart",
                callId: "call-restart",
                candidates: [candidate(0, "image", "image/png")],
                store: { attachmentsDir, repository: recoveredRepository },
                now: "2026-08-29T10:12:00.000Z",
              }),
            ),
          );
          assert.strictEqual(replay[0]?.state, "available");
          if (replay[0]?.state !== "available") return;
          assert.strictEqual(replay[0].attachmentId, originalId);
          assert.strictEqual(replay[0].sizeBytes, originalBytes.byteLength);
          assert.strictEqual(replay[0].sha256, sha256(originalBytes));
          const row = Option.getOrNull(
            yield* Effect.promise(() =>
              recoveredRuntime.runPromise(
                recoveredRepository.findClaimedById({ attachmentId: originalId }),
              ),
            ),
          );
          assert.isNotNull(row);
          assert.deepStrictEqual(
            Uint8Array.from(fs.readFileSync(path.join(attachmentsDir, row!.relativePath))),
            originalBytes,
          );
          const sql = yield* Effect.promise(() =>
            recoveredRuntime.runPromise(Effect.service(SqlClient.SqlClient)),
          );
          const durableRows = yield* Effect.promise(() =>
            recoveredRuntime.runPromise(sql<{ readonly payload: string }>`
              SELECT original_name || ':' || mime_type || ':' || size_bytes || ':' || sha256 AS payload
              FROM managed_attachment_blobs
              WHERE attachment_id = ${originalId}
            `),
          );
          assert.isFalse(JSON.stringify(durableRows).includes(encoded("image/png")));

          const marked = yield* Effect.promise(() =>
            recoveredRuntime.runPromise(
              sql.withTransaction(
                recoveredRepository.markCleanupByThread({
                  ownerThreadId: "thread-restart",
                  reason: "thread-removed",
                  requestedAt: "2026-08-29T10:13:00.000Z",
                }),
              ),
            ),
          );
          assert.deepStrictEqual(marked, [originalId]);
          const unavailable = yield* Effect.promise(() =>
            recoveredRuntime.runPromise(
              recoveredRepository.findClaimedMcpBlock({
                ownerThreadId: "thread-restart",
                ownerKind: "provider-runtime",
                ownerId: "codex",
                callId: "call-restart",
                blockIndex: 0,
              }),
            ),
          );
          assert.isTrue(Option.isNone(unavailable));
        } finally {
          yield* Effect.promise(() => recoveredRuntime.dispose());
        }
      } finally {
        if (firstRuntime) {
          yield* Effect.promise(() => firstRuntime.dispose()).pipe(Effect.ignore);
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps production limits explicit and returns only bounded metadata", () =>
    Effect.sync(() => {
      assert.strictEqual(MCP_RESULT_ARTIFACT_LIMITS.maxBlockBytes, 10 * 1024 * 1024);
      assert.strictEqual(MCP_RESULT_ARTIFACT_LIMITS.maxAggregateBytes, 20 * 1024 * 1024);
      assert.strictEqual(MCP_RESULT_ARTIFACT_LIMITS.maxBlocks, 4);
    }),
  );
});
