// FILE: providerOrdering.test.ts
// Purpose: Keeps provider ordering normalization covered for every exposed provider.
// Layer: Web settings tests
// Depends on: provider display metadata from contracts and providerOrdering helpers.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_ORDER,
  isProviderKind,
  isLocalProviderInstalled,
  prioritizeInstalledProviders,
  normalizeHiddenProviders,
  normalizeProviderOrder,
} from "./providerOrdering";
import { MOSS_ACTIVE_PROVIDER_KINDS } from "./providerProductCatalog";

describe("providerOrdering", () => {
  it("ignores fourteen unprobed disabled statuses and managed instances while prioritizing an installed Pi", () => {
    const statuses = MOSS_ACTIVE_PROVIDER_KINDS.map((provider) => ({
      provider,
      driver: provider,
      instanceId: provider,
      available: false,
      enabled: false,
      status: "warning" as const,
      authStatus: "unknown" as const,
      readiness: { state: "error" as const, reason: "disabled" },
      checkedAt: "2026-11-06T10:00:00Z",
    }));
    expect(statuses).toHaveLength(14);
    expect(statuses.filter(isLocalProviderInstalled)).toEqual([]);
    const installedPi = {
      ...statuses.find((status) => status.provider === "pi")!,
      available: true,
      enabled: true,
      readiness: { state: "ready" as const },
      version: "1.5.0",
    };
    const local = statuses.map((status) => (status.provider === "pi" ? installedPi : status));
    const installed = new Set(
      local.filter(isLocalProviderInstalled).map((status) => status.provider),
    );
    expect([...installed]).toEqual(["pi"]);
    expect(prioritizeInstalledProviders(MOSS_ACTIVE_PROVIDER_KINDS, installed).slice(0, 3)).toEqual(
      ["codex", "claudeAgent", "pi"],
    );
    expect(
      statuses
        .map((status) => ({
          ...status,
          instanceId: `${status.provider}_moss`,
          available: true,
          version: "1.0.0",
          readiness: { state: "ready" as const },
        }))
        .filter(isLocalProviderInstalled),
    ).toEqual([]);
    expect(
      isLocalProviderInstalled({
        ...installedPi,
        enabled: false,
        available: false,
        readiness: { state: "error", reason: "disabled" },
      }),
    ).toBe(true);
  });
  it("puts Codex and Claude first, then installed agents, then remaining stable choices", () => {
    expect(
      prioritizeInstalledProviders(
        ["grok", "pi", "claudeAgent", "cursor", "codex", "opencode"],
        new Set(["pi", "opencode"]),
      ),
    ).toEqual(["codex", "claudeAgent", "pi", "opencode", "grok", "cursor"]);
  });

  it("does not mistake a desktop-only installation for an agent CLI", () => {
    const missing = {
      provider: "cursor" as const,
      driver: "cursor" as const,
      instanceId: "cursor",
      status: "error" as const,
      authStatus: "unknown" as const,
      available: false,
      readiness: { state: "notInstalled" as const },
      checkedAt: "2026-11-06T10:00:00Z",
    };
    expect(isLocalProviderInstalled(missing)).toBe(false);
    expect(isLocalProviderInstalled({ ...missing, readiness: { state: "needsLogin" } })).toBe(true);
  });
  it("includes only active product providers in the default order", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual(MOSS_ACTIVE_PROVIDER_KINDS);
    expect(DEFAULT_PROVIDER_ORDER).toContain("antigravity");
    expect(DEFAULT_PROVIDER_ORDER).toContain("omp");
    expect(DEFAULT_PROVIDER_ORDER).not.toContain("droid");
    expect(DEFAULT_PROVIDER_ORDER).not.toContain("kilo");
  });

  it("keeps Pi as a valid provider for persisted order and visibility settings", () => {
    expect(isProviderKind("pi")).toBe(true);
    expect(normalizeProviderOrder(["pi", "codex"])[0]).toBe("pi");
    expect(normalizeHiddenProviders(["bogus", "pi", "pi"])).toEqual(["pi"]);
  });
});
