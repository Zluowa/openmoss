// FILE: providerUsageSnapshot.test.ts
// Purpose: Locks down provider-usage snapshot normalization edge cases used by
// compact usage surfaces and Settings usage cards.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isProviderUsageSnapshotNonOk,
  mergeProviderUsageRefresh,
  providerUsageSnapshotInstanceId,
} from "./providerUsageSnapshot";

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

describe("providerUsageSnapshot", () => {
  it("uses the canonical account route, then its wire alias, then the default driver", () => {
    expect(providerUsageSnapshotInstanceId(snapshot())).toBe("claudeAgent");
    expect(providerUsageSnapshotInstanceId(snapshot({ instanceId: "claude_work" }))).toBe(
      "claude_work",
    );
    expect(
      providerUsageSnapshotInstanceId(
        snapshot({ providerInstanceId: "claude_work", instanceId: "claude_legacy" }),
      ),
    ).toBe("claude_work");
  });

  it("refreshes each account without dropping siblings or omitted providers", () => {
    const personal = snapshot({
      providerInstanceId: "claudeAgent",
      limits: [{ window: "Weekly", usedPercent: 20 }],
    });
    const work = snapshot({
      instanceId: "claude_work",
      limits: [{ window: "Weekly", usedPercent: 80 }],
    });
    const codex = snapshot({ provider: "codex", source: "preserve-codex" });
    const refreshedWork = snapshot({
      providerInstanceId: "claude_work",
      limits: [{ window: "Weekly", usedPercent: 85 }],
    });
    expect(mergeProviderUsageRefresh([personal, work, codex], [refreshedWork])).toEqual([
      codex,
      personal,
      refreshedWork,
    ]);
    expect(mergeProviderUsageRefresh(undefined, [personal, work])).toEqual([personal, work]);
  });

  it("only treats explicit non-ok live statuses as fallback blockers", () => {
    expect(isProviderUsageSnapshotNonOk(null)).toBe(false);
    expect(isProviderUsageSnapshotNonOk(undefined)).toBe(false);
    expect(isProviderUsageSnapshotNonOk(snapshot())).toBe(false);
    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "ok" }))).toBe(false);

    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "needs-auth" }))).toBe(true);
    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "unsupported" }))).toBe(true);
    expect(isProviderUsageSnapshotNonOk(snapshot({ status: "error" }))).toBe(true);
  });
});
