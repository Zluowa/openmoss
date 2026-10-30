// FILE: AcpSdk.ts
// Purpose: Single memoized loader for the Agent Client Protocol SDK runtime values.
// Layer: Provider ACP runtime helper
// Exports: AcpSdkModule, loadAcpSdk

import { JsonSchema, Schema, SchemaRepresentation } from "effect";

import { lazyModule } from "../../lazyModule.ts";

export type AcpSdkModule = typeof import("@agentclientprotocol/sdk");

/**
 * Loads `@agentclientprotocol/sdk` on first use. Every ACP-backed provider
 * (Cursor and Grok) only needs the SDK's runtime values once a session is
 * actually spawned, while an eager top-level import costs ~32ms on every server
 * boot. All other ACP modules consume the SDK purely as `import type`, which is
 * erased at compile time.
 */
export const loadAcpSdk: () => Promise<AcpSdkModule> = lazyModule(
  () => import("@agentclientprotocol/sdk"),
);

/** Validate before counting notifications: the SDK otherwise logs and skips bad
 * notifications, leaving a response drain waiting for an event it cannot see. */
export const loadAcpSessionNotificationValidator = lazyModule(async () => {
  const { default: schema } = await import("@agentclientprotocol/sdk/schema/schema.json", {
    with: { type: "json" },
  });
  const document = JsonSchema.fromSchemaDraft2020_12({
    $ref: "#/$defs/SessionNotification",
    $defs: schema.$defs,
  });
  return Schema.is(
    SchemaRepresentation.toSchema<Schema.Codec<unknown>>(
      SchemaRepresentation.fromJsonSchemaDocument(document),
    ),
  );
});
