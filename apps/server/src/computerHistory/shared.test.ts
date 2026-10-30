import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearProcessComputerHistoryServices,
  getProcessComputerHistoryService,
  resolveProcessComputerHistoryKeychainNamespace,
  resolveProcessComputerHistoryRoot,
} from "./shared.ts";
import { createTestHistoryKey } from "./store.ts";

describe("process Computer History service", () => {
  it("shares lifecycle and store ownership for one runtime state directory", async () => {
    clearProcessComputerHistoryServices();
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-shared-"));
    const key = createTestHistoryKey();
    const options = {
      rootDir,
      supported: true,
      permissions: {
        inputMonitoring: "granted" as const,
        accessibility: "granted" as const,
        screenRecording: "granted" as const,
      },
      keyProvider: { getOrCreateKey: async () => key },
    };
    const wsService = getProcessComputerHistoryService(options);
    const gatewayService = getProcessComputerHistoryService({
      ...options,
      helperPath: "/unused-in-test",
    });
    expect(gatewayService).toBe(wsService);
    await wsService.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    expect((await gatewayService.getState()).enabled).toBe(true);
    await gatewayService.pause();
    expect((await wsService.getState()).recorderState).toBe("paused");
    clearProcessComputerHistoryServices();
  });

  it("isolates distinct runtime base directories while sharing one resolved state root", async () => {
    clearProcessComputerHistoryServices();
    const firstBaseDir = await mkdtemp(join(tmpdir(), "moss-history-base-a-"));
    const secondBaseDir = await mkdtemp(join(tmpdir(), "moss-history-base-b-"));
    const firstRoot = resolveProcessComputerHistoryRoot(join(firstBaseDir, "userdata"));
    const secondRoot = resolveProcessComputerHistoryRoot(join(secondBaseDir, "userdata"));
    expect(firstRoot).not.toBe(secondRoot);
    expect(resolveProcessComputerHistoryKeychainNamespace(join(firstBaseDir, "userdata"))).toBe(
      resolveProcessComputerHistoryKeychainNamespace(join(firstBaseDir, "userdata")),
    );
    expect(resolveProcessComputerHistoryKeychainNamespace(join(firstBaseDir, "userdata"))).not.toBe(
      resolveProcessComputerHistoryKeychainNamespace(join(secondBaseDir, "userdata")),
    );
    expect(resolveProcessComputerHistoryKeychainNamespace(join(firstBaseDir, "userdata"))).toMatch(
      /^moss-history-[a-f0-9]{32}$/,
    );
    const firstKey = createTestHistoryKey();
    const secondKey = createTestHistoryKey();
    const first = getProcessComputerHistoryService({
      rootDir: firstRoot,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => firstKey },
    });
    const second = getProcessComputerHistoryService({
      rootDir: secondRoot,
      supported: true,
      permissions: {
        inputMonitoring: "granted",
        accessibility: "granted",
        screenRecording: "granted",
      },
      keyProvider: { getOrCreateKey: async () => secondKey },
    });
    expect(first).not.toBe(second);
    await first.setEnabled({ enabled: true, consentAt: "2026-08-19T00:00:00.000Z" });
    await first.recordObservation({
      capturedAtMs: 1,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
      privateBrowsing: false,
    });
    expect((await second.listHistory()).entries).toHaveLength(0);
    expect(
      getProcessComputerHistoryService({
        rootDir: firstRoot,
        supported: true,
        keyProvider: { getOrCreateKey: async () => firstKey },
      }),
    ).toBe(first);
    clearProcessComputerHistoryServices();
  });
});
