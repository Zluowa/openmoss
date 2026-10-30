import { describe, expect, it } from "vitest";

import { ThreadId } from "@synara/contracts";

import {
  MOSS_CONFIG_PROJECTED_EVENT_TYPE,
  buildMossConfigProjectedLogPayload,
  makeMossConfigProjectedEventId,
} from "./mossConfigProjectedEvent.ts";

const fingerprint = `sha256:${"a".repeat(64)}`;

describe("mossConfigProjectedEvent", () => {
  it("derives a deterministic, EventId-safe event id from planId + fingerprint", () => {
    const first = makeMossConfigProjectedEventId({
      planId: "moss-launch-thread-1-1751673600000",
      projectionFingerprint: fingerprint,
    });
    const second = makeMossConfigProjectedEventId({
      planId: "moss-launch-thread-1-1751673600000",
      projectionFingerprint: fingerprint,
    });
    expect(first).toBe(second);
    // No characters outside the EventId charset (the `sha256:` colon is
    // sanitized to a dash).
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("shapes the log payload with correlationId = planId and the per-engine roll-up", () => {
    const payload = buildMossConfigProjectedLogPayload({
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-sy3"),
      planId: "moss-launch-thread-sy3-1751673600000",
      projectionFingerprint: fingerprint,
      resumed: false,
      engines: [
        {
          engineId: "codex",
          projectionStatus: "ready",
          created: 2,
          updated: 0,
          skipped: 0,
          conflict: 0,
          unsupported: 0,
          total: 2,
          failed: false,
        },
      ],
      warnings: [],
    });

    expect(payload.type).toBe(MOSS_CONFIG_PROJECTED_EVENT_TYPE);
    expect(payload.type).toBe("moss.config.projected");
    expect(payload.provider).toBe("codex");
    expect(payload.threadId).toBe("thread-sy3");
    expect(payload.correlationId).toBe("moss-launch-thread-sy3-1751673600000");
    expect(payload.projectionFingerprint).toBe(fingerprint);
    expect(payload.resumed).toBe(false);
    expect(payload.degraded).toBe(false);
    expect(payload.engines[0]?.engineId).toBe("codex");
    expect(payload.engines[0]?.created).toBe(2);
    expect(payload.eventId).toBe(
      makeMossConfigProjectedEventId({
        planId: "moss-launch-thread-sy3-1751673600000",
        projectionFingerprint: fingerprint,
      }),
    );
  });

  it("marks the payload degraded when the refresh failed", () => {
    const payload = buildMossConfigProjectedLogPayload({
      provider: "claudeAgent",
      threadId: ThreadId.makeUnsafe("thread-degraded"),
      planId: "moss-launch-thread-degraded-1",
      projectionFingerprint: fingerprint,
      resumed: true,
      engines: [],
      degraded: true,
      warnings: ["moss.config.projected_failed: degraded"],
    });

    expect(payload.degraded).toBe(true);
    expect(payload.resumed).toBe(true);
    expect(payload.warnings).toContain("moss.config.projected_failed: degraded");
  });
});
