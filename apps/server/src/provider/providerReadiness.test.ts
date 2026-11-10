import type { ServerProviderStatus } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { deriveProviderReadiness, PROVIDER_NOT_INSTALLED_READINESS } from "./providerReadiness.ts";

const status = (overrides: Partial<ServerProviderStatus>): ServerProviderStatus =>
  ({
    provider: "codex",
    instanceId: "codex",
    driver: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-11-04T00:00:00.000Z",
    ...overrides,
  }) as ServerProviderStatus;

describe("deriveProviderReadiness", () => {
  it("is ready when the binary runs and the sign-in works or is not needed", () => {
    expect(deriveProviderReadiness(status({}))).toEqual({ state: "ready" });
    expect(deriveProviderReadiness(status({ status: "warning", authStatus: "unknown" }))).toEqual({
      state: "ready",
    });
  });

  it("asks a local agent to sign in, and Moss's own provider to sign in to Moss", () => {
    const signedOut = status({ status: "error", authStatus: "unauthenticated" });
    expect(deriveProviderReadiness(signedOut)).toEqual({
      state: "needsLogin",
      reason: "agent-sign-in",
    });
    expect(deriveProviderReadiness({ ...signedOut, instanceId: "codex_moss" as never })).toEqual({
      state: "needsLogin",
      reason: "moss-sign-in",
    });
    // Signing out of Moss turns its provider off.
    expect(
      deriveProviderReadiness(
        status({ instanceId: "claude_moss" as never, driver: "claudeAgent", enabled: false }),
      ),
    ).toEqual({ state: "needsLogin", reason: "moss-sign-in" });
  });

  it.each([
    { platform: "win32", action: { install: "oneClick" } },
    {
      platform: "darwin",
      action: {
        install: "externalPage",
        installUrl: "https://docs.cursor.com/en/cli/installation",
      },
    },
    {
      platform: "linux",
      action: {
        install: "externalPage",
        installUrl: "https://docs.cursor.com/en/cli/installation",
      },
    },
  ])(
    "offers the supported install action for a missing Cursor CLI on $platform",
    ({ platform, action }) => {
      const missing = status({
        provider: "cursor",
        driver: "cursor",
        instanceId: "cursor" as never,
        status: "error",
        available: false,
        authStatus: "unknown",
        readiness: PROVIDER_NOT_INSTALLED_READINESS,
        message: "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH.",
      });
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      const architectureDescriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
      try {
        Object.defineProperty(process, "platform", { value: platform });
        Object.defineProperty(process, "arch", { value: "x64" });
        expect(deriveProviderReadiness(missing)).toEqual({ state: "notInstalled", ...action });
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        Object.defineProperty(process, "arch", architectureDescriptor);
      }
    },
  );

  it("never carries a stale derived state from a cached status", () => {
    expect(
      deriveProviderReadiness(
        status({ status: "error", available: false, readiness: { state: "ready" } }),
      ),
    ).toMatchObject({ state: "error" });
  });

  it("names the error with a code, never the raw message", () => {
    const broken = (message: string, overrides: Partial<ServerProviderStatus> = {}) =>
      deriveProviderReadiness(
        status({ status: "error", available: false, authStatus: "unknown", message, ...overrides }),
      );
    expect(broken("Codex CLI is installed but failed to run. C:\\x\\codex.exe crashed")).toEqual({
      state: "error",
      reason: "failed-to-run",
    });
    expect(
      broken(
        "Bundled Codex runtime for win32/x64 is unavailable. Reinstall Moss with a supported artifact.",
      ),
    ).toEqual({ state: "error", reason: "moss-runtime-damaged" });
    expect(
      broken("Kimi Code needs Git Bash on Windows, and Moss could not find it.", {
        driver: "kimi",
        provider: "kimi",
      }),
    ).toEqual({ state: "error", reason: "needs-git-bash" });
    expect(broken("anything", { instanceId: "codex_moss" as never })).toEqual({
      state: "error",
      reason: "moss-unavailable",
    });
    // After Moss updates Claude, both the person's own Claude and Moss's Claude wait for a
    // restart; the Moss row must say that, not "Moss is temporarily unavailable".
    const restart =
      "Failed to execute Claude Agent CLI health check: The Claude program changed. Restart Moss to apply it; accounts and history are preserved..";
    for (const instanceId of ["claudeAgent", "claude_moss"]) {
      expect(
        broken(restart, {
          driver: "claudeAgent",
          provider: "claudeAgent",
          instanceId: instanceId as never,
        }),
      ).toEqual({ state: "error", reason: "restart-required" });
    }
  });

  it("says checking before the first probe", () => {
    expect(
      deriveProviderReadiness(
        status({
          status: "warning",
          available: false,
          authStatus: "unknown",
          message: "Provider instance has not been checked yet.",
        }),
      ),
    ).toEqual({ state: "checking" });
  });
});
