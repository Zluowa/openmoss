// FILE: 063_ScrubCodexOrchestrationEventBinaryPath.ts
// Purpose: Remove stale Codex executable paths from historical orchestration events.
// Layer: SQLite data migration for the append-only event journal.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Codex binaryPath is resolved from the current trusted runtime or current
  // provider-instance settings at launch. The event journal is deliberately
  // not a second source of truth for either bundled or user-configured paths:
  // replay keeps modelSelection.instanceId and the reactor rehydrates that
  // instance's current options. A copied path from an older install must never
  // survive in durable provider options. json_remove is idempotent, while the
  // guards leave malformed legacy JSON and payloads without options intact.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      payload_json,
      '$.providerOptions.codex.binaryPath'
    )
    WHERE event_type IN (
      'thread.turn-queued',
      'thread.turn-start-requested',
      'thread.message-edit-resend-requested'
    )
      AND json_valid(payload_json)
      AND json_type(payload_json, '$.providerOptions') = 'object'
      AND json_type(payload_json, '$.providerOptions.codex') = 'object'
      AND json_type(payload_json, '$.providerOptions.codex.binaryPath') IS NOT NULL
  `;
});
