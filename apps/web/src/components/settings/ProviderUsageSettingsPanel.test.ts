import type {
  ProviderKind,
  ProviderUsageStatus,
  ServerProviderStatus,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveCodexUsageProviderInstanceId,
  resolveMossUsageState,
  shouldShowProviderUsageSnapshot,
} from "./ProviderUsageSettingsPanel";

function snapshot(
  provider: ProviderKind,
  status: ProviderUsageStatus,
): ServerProviderUsageSnapshot {
  return {
    provider,
    status,
    updatedAt: "2026-07-13T09:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
  };
}

function providerStatus(
  provider: ProviderKind,
  authStatus: ServerProviderStatus["authStatus"],
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: authStatus === "authenticated" ? "ready" : "error",
    available: authStatus === "authenticated",
    authStatus,
    checkedAt: "2026-07-13T09:00:00.000Z",
  };
}

describe("ProviderUsageSettingsPanel presentation", () => {
  it("reads a signed-in personal Codex account instead of the managed chat default", () => {
    expect(
      resolveCodexUsageProviderInstanceId({
        defaultProviderInstanceId: "codex_moss",
        providerStatuses: [
          {
            ...providerStatus("codex", "unknown"),
            instanceId: "codex_moss",
            displayName: "Moss",
          },
          providerStatus("codex", "authenticated"),
        ],
      }),
    ).toBe("codex");
  });

  it("preserves an authenticated personal Codex account selected by the user", () => {
    expect(
      resolveCodexUsageProviderInstanceId({
        defaultProviderInstanceId: "codex_work",
        providerStatuses: [
          {
            ...providerStatus("codex", "authenticated"),
            instanceId: "codex_work",
          },
          providerStatus("codex", "authenticated"),
        ],
      }),
    ).toBe("codex_work");
  });

  it("hides providers that explicitly report no signed-in usage account", () => {
    expect(
      shouldShowProviderUsageSnapshot(snapshot("gemini", "needs-auth"), [
        providerStatus("gemini", "unauthenticated"),
      ]),
    ).toBe(false);
    expect(
      shouldShowProviderUsageSnapshot(snapshot("cursor", "unsupported"), [
        providerStatus("cursor", "unknown"),
      ]),
    ).toBe(false);
  });

  it("shows real usage and keeps errors visible only for authenticated accounts", () => {
    expect(shouldShowProviderUsageSnapshot(snapshot("cursor", "ok"), [])).toBe(true);
    expect(
      shouldShowProviderUsageSnapshot(snapshot("codex", "error"), [
        providerStatus("codex", "unknown"),
      ]),
    ).toBe(false);
    expect(
      shouldShowProviderUsageSnapshot(snapshot("codex", "error"), [
        providerStatus("codex", "authenticated"),
      ]),
    ).toBe(true);
    expect(
      shouldShowProviderUsageSnapshot(snapshot("codex", "error"), [
        {
          ...providerStatus("codex", "authenticated"),
          instanceId: "codex_moss",
          displayName: "Moss",
        },
      ]),
    ).toBe(false);
  });

  it("reports Moss readiness without inventing quota values", () => {
    expect(
      resolveMossUsageState({
        accountState: { configured: true, authenticated: true, modelGatewayConfigured: true },
        phoneState: undefined,
        pending: false,
        failed: false,
      }),
    ).toBe("ready");
    expect(
      resolveMossUsageState({
        accountState: { configured: true, authenticated: true, modelGatewayConfigured: false },
        phoneState: undefined,
        pending: false,
        failed: false,
      }),
    ).toBe("unavailable");
    expect(
      resolveMossUsageState({
        accountState: { configured: true, authenticated: false, modelGatewayConfigured: true },
        phoneState: undefined,
        pending: false,
        failed: false,
      }),
    ).toBe("signed-out");
    expect(
      resolveMossUsageState({
        accountState: undefined,
        phoneState: undefined,
        pending: true,
        failed: false,
      }),
    ).toBe("checking");
    expect(
      resolveMossUsageState({
        accountState: { configured: true, authenticated: false, modelGatewayConfigured: true },
        phoneState: { configured: true, authenticated: true },
        pending: false,
        failed: false,
      }),
    ).toBe("ready");
    expect(
      resolveMossUsageState({
        accountState: { configured: true, authenticated: false, modelGatewayConfigured: false },
        phoneState: { configured: true, authenticated: true },
        pending: false,
        failed: false,
      }),
    ).toBe("ready");
    expect(
      resolveMossUsageState({
        accountState: { configured: false, authenticated: false, modelGatewayConfigured: false },
        phoneState: { configured: false, authenticated: true },
        pending: false,
        failed: false,
      }),
    ).toBe("unavailable");
    expect(
      resolveMossUsageState({
        accountState: { configured: false, authenticated: false, modelGatewayConfigured: false },
        phoneState: undefined,
        pending: true,
        failed: false,
      }),
    ).toBe("checking");
    expect(
      resolveMossUsageState({
        accountState: { configured: true, authenticated: false, modelGatewayConfigured: false },
        phoneState: { configured: true, authenticated: false },
        pending: true,
        failed: false,
      }),
    ).toBe("checking");
  });
});
