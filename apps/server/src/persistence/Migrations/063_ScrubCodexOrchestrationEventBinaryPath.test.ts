// FILE: 063_ScrubCodexOrchestrationEventBinaryPath.test.ts
// Purpose: Verifies stale Codex launch paths are removed from historical event JSON.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ScrubCodexOrchestrationEventBinaryPath from "./063_ScrubCodexOrchestrationEventBinaryPath.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("063_ScrubCodexOrchestrationEventBinaryPath", (it) => {
  it.effect(
    "scrubs every durable Codex path idempotently without changing replay-safe or other-provider fields",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-07-16T08:00:00.000Z";

        yield* runMigrations({ toMigrationInclusive: 62 });

        const remoteMainEntries = migrationEntries
          .filter(([id]) => id >= 63 && id <= 78)
          .map(([id, name]) => [id, name]);
        assert.deepStrictEqual(
          remoteMainEntries.map(([id]) => Number(id)),
          Array.from({ length: 16 }, (_, index) => index + 63),
        );
        const remoteMainExecuted = yield* runMigrations({
          toMigrationInclusive: 78,
        });
        assert.deepStrictEqual(
          remoteMainExecuted.map(([id, name]) => [id, name]),
          remoteMainEntries,
        );

        const rowsToInsert = [
          {
            eventId: "evt-codex-path-queued",
            eventType: "thread.turn-queued",
            payloadJson: JSON.stringify({
              threadId: "thread-codex-path-queued",
              messageId: "message-codex-path-queued",
              modelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5.4" },
              providerOptions: {
                codex: {
                  binaryPath: "/bundled/codex/queued",
                  homePath: "/tmp/codex-home-queued",
                },
                droid: { binaryPath: "/opt/bin/droid" },
              },
            }),
          },
          {
            eventId: "evt-codex-path-start",
            eventType: "thread.turn-start-requested",
            payloadJson: JSON.stringify({
              threadId: "thread-codex-path-start",
              messageId: "message-codex-path-start",
              providerOptions: {
                codex: {
                  binaryPath: "/bundled/codex/start",
                  homePath: "/tmp/codex-home-start",
                },
              },
            }),
          },
          {
            eventId: "evt-codex-path-edit",
            eventType: "thread.message-edit-resend-requested",
            payloadJson: JSON.stringify({
              threadId: "thread-codex-path-edit",
              messageId: "message-codex-path-edit",
              text: "retry",
              modelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5.4" },
              providerOptions: {
                codex: {
                  binaryPath: "/bundled/codex/edit",
                  homePath: "/tmp/codex-home-edit",
                  shadowHomePath: "/tmp/codex-shadow-edit",
                },
                claudeAgent: { binaryPath: "/opt/bin/claude" },
              },
            }),
          },
          {
            eventId: "evt-codex-path-malformed",
            eventType: "thread.turn-queued",
            payloadJson: "{not-valid-json",
          },
          {
            eventId: "evt-codex-path-no-options",
            eventType: "thread.turn-start-requested",
            payloadJson: JSON.stringify({
              threadId: "thread-codex-path-no-options",
              messageId: "message-codex-path-no-options",
            }),
          },
          {
            eventId: "evt-codex-path-unrelated",
            eventType: "thread.created",
            payloadJson: JSON.stringify({
              providerOptions: {
                codex: { binaryPath: "/unrelated/codex", homePath: "/tmp/unrelated-home" },
              },
            }),
          },
        ] as const;

        for (const [index, row] of rowsToInsert.entries()) {
          yield* sql`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            )
            VALUES (
              ${row.eventId},
              'thread',
              ${`stream-${index}`},
              0,
              ${row.eventType},
              ${now},
              ${`command-${index}`},
              NULL,
              ${`command-${index}`},
              'client',
              ${row.payloadJson},
              '{}'
            )
          `;
        }

        // Simulate a partially applied upgrade before the registered migration
        // executes. Running the update repeatedly must remain safe.
        yield* ScrubCodexOrchestrationEventBinaryPath;
        yield* ScrubCodexOrchestrationEventBinaryPath;

        const executed = yield* runMigrations({ toMigrationInclusive: 79 });
        assert.deepStrictEqual(
          executed.map(([id, name]) => [id, name]),
          [[79, "ScrubCodexOrchestrationEventBinaryPath"]],
        );
        assert.deepStrictEqual(migrationEntries.find(([id]) => id === 79)?.slice(0, 2), [
          79,
          "ScrubCodexOrchestrationEventBinaryPath",
        ]);

        const postScrubExecuted = yield* runMigrations();
        assert.deepStrictEqual(
          postScrubExecuted.map(([id, name]) => [id, name]),
          migrationEntries.filter(([id]) => id >= 80).map(([id, name]) => [id, name]),
        );
        // The registry's current tail is covered by Migrations.test.ts. This
        // migration must stay replay-safe as later migrations are appended.
        assert.deepStrictEqual(yield* runMigrations(), []);

        const storedRows = yield* sql<{
          readonly eventId: string;
          readonly eventType: string;
          readonly payloadJson: string;
        }>`
          SELECT
            event_id AS "eventId",
            event_type AS "eventType",
            payload_json AS "payloadJson"
          FROM orchestration_events
          ORDER BY event_id ASC
        `;
        const storedById = new Map(storedRows.map((row) => [row.eventId, row]));

        for (const eventId of [
          "evt-codex-path-queued",
          "evt-codex-path-start",
          "evt-codex-path-edit",
        ]) {
          const payloadJson = storedById.get(eventId)?.payloadJson ?? "";
          assert.notInclude(payloadJson, "/bundled/codex/");
          const payload = JSON.parse(payloadJson) as {
            readonly providerOptions: {
              readonly codex: Record<string, unknown>;
            };
          };
          assert.notProperty(payload.providerOptions.codex, "binaryPath");
        }

        const queued = JSON.parse(
          storedById.get("evt-codex-path-queued")?.payloadJson ?? "{}",
        ) as Record<string, unknown>;
        assert.deepStrictEqual(queued, {
          threadId: "thread-codex-path-queued",
          messageId: "message-codex-path-queued",
          modelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5.4" },
          providerOptions: {
            codex: { homePath: "/tmp/codex-home-queued" },
            droid: { binaryPath: "/opt/bin/droid" },
          },
        });

        const started = JSON.parse(
          storedById.get("evt-codex-path-start")?.payloadJson ?? "{}",
        ) as Record<string, unknown>;
        assert.notProperty(started, "modelSelection");
        assert.deepStrictEqual(started.providerOptions, {
          codex: { homePath: "/tmp/codex-home-start" },
        });

        const edited = JSON.parse(
          storedById.get("evt-codex-path-edit")?.payloadJson ?? "{}",
        ) as Record<string, unknown>;
        assert.deepStrictEqual(edited.providerOptions, {
          codex: {
            homePath: "/tmp/codex-home-edit",
            shadowHomePath: "/tmp/codex-shadow-edit",
          },
          claudeAgent: { binaryPath: "/opt/bin/claude" },
        });

        assert.strictEqual(
          storedById.get("evt-codex-path-malformed")?.payloadJson,
          "{not-valid-json",
        );
        assert.deepStrictEqual(
          JSON.parse(storedById.get("evt-codex-path-no-options")?.payloadJson ?? "{}"),
          {
            threadId: "thread-codex-path-no-options",
            messageId: "message-codex-path-no-options",
          },
        );
        assert.deepStrictEqual(
          JSON.parse(storedById.get("evt-codex-path-unrelated")?.payloadJson ?? "{}"),
          {
            providerOptions: {
              codex: {
                binaryPath: "/unrelated/codex",
                homePath: "/tmp/unrelated-home",
              },
            },
          },
        );

        const validTargetRowsWithCodexPath = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM orchestration_events
          WHERE event_type IN (
            'thread.turn-queued',
            'thread.turn-start-requested',
            'thread.message-edit-resend-requested'
          )
            AND json_valid(payload_json)
            AND json_extract(payload_json, '$.providerOptions.codex.binaryPath') IS NOT NULL
        `;
        assert.strictEqual(Number(validTargetRowsWithCodexPath[0]?.count ?? 0), 0);
      }),
  );
});
