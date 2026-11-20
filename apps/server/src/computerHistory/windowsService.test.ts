// FILE: windowsService.test.ts
// Purpose: The Windows helper drives the shared Computer History service: consent, exclusions,
//          rules, OCR summaries, pause/resume, clear, app catalog and helper failure.
// Layer: Computer History service tests (fake helper, run on every platform)

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeComputerHistoryService } from "./service.ts";
import { createTestHistoryKey } from "./store.ts";
import type { WindowsHistoryHelper, WindowsHistoryHelperOptions } from "./windows.ts";
import type { WindowsHistoryProbe, WindowsHistoryTarget } from "./windowsActivity.ts";

const PNG = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64")}`;

function target(overrides: Partial<WindowsHistoryTarget> = {}): WindowsHistoryTarget {
  return {
    hwnd: 77,
    processName: "WINWORD.EXE",
    displayName: "Microsoft Word",
    windowClass: "OpusApp",
    title: "Falcon memo.docx - Word",
    cloaked: false,
    minimized: false,
    displayAffinity: 0,
    passwordFocused: false,
    focusedControl: "ControlType.Document",
    ...overrides,
  };
}

interface FakeHelperState {
  probe: WindowsHistoryProbe | null;
  ocr: { readonly ocr: boolean } | null;
  text: string | null;
  readonly calls: { probe: number; capture: number; ocr: number; drop: number; stop: number };
  readonly helpers: Array<{ readonly options: WindowsHistoryHelperOptions }>;
}

function fakeAdapter(initial: Partial<FakeHelperState> = {}) {
  const key = createTestHistoryKey();
  const state: FakeHelperState = {
    probe: { capturedAtMs: Date.now(), idleSeconds: 2, target: target(), others: [] },
    ocr: { ocr: true },
    text: "Falcon acquisition memo — confidential numbers for Q3",
    calls: { probe: 0, capture: 0, ocr: 0, drop: 0, stop: 0 },
    helpers: [],
    ...initial,
  };
  const start = vi.fn((options: WindowsHistoryHelperOptions): WindowsHistoryHelper => {
    state.helpers.push({ options });
    return {
      ready: Promise.resolve(state.ocr),
      probe: async () => {
        state.calls.probe += 1;
        return state.probe;
      },
      capture: async () => {
        state.calls.capture += 1;
        return { fingerprint: new Uint8Array(256).fill(state.calls.capture * 20), durationMs: 40 };
      },
      ocr: async () => {
        state.calls.ocr += 1;
        return state.text;
      },
      drop: () => {
        state.calls.drop += 1;
      },
      applications: async () => [
        { processName: "WINWORD.EXE", name: "Word", iconDataURL: PNG },
        { processName: "sublime_text.exe", name: "Sublime Text" },
      ],
      stop: async () => {
        state.calls.stop += 1;
      },
    };
  });
  return {
    state,
    start,
    windowsAdapter: { start, keyProvider: { getOrCreateKey: async () => key } },
  };
}

const services: Array<ReturnType<typeof makeComputerHistoryService>> = [];
async function makeWindowsService(adapter: ReturnType<typeof fakeAdapter>) {
  const rootDir = await mkdtemp(join(tmpdir(), "moss-history-windows-"));
  const service = makeComputerHistoryService({
    rootDir,
    platform: "win32",
    windowsAdapter: adapter.windowsAdapter,
  });
  services.push(service);
  return { service, rootDir };
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
});

const consentAt = "2026-11-21T00:00:00.000Z";

describe("Windows Computer History", () => {
  it("is off until consent, then records an on-device activity summary but never the screen text", async () => {
    const adapter = fakeAdapter();
    const { service, rootDir } = await makeWindowsService(adapter);
    const off = await service.getState();
    expect(off).toMatchObject({ supported: true, enabled: false, recorderState: "stopped" });
    expect(off.captureCapability.detail).toMatch(/^Windows samples/u);
    expect(adapter.start).not.toHaveBeenCalled();
    await expect(service.setEnabled({ enabled: true })).rejects.toThrow(/consent/iu);

    expect((await service.setEnabled({ enabled: true, consentAt })).recorderState).toBe("running");
    await vi.waitFor(async () => expect((await service.listHistory()).entries).toHaveLength(1));
    const [entry] = (await service.listHistory()).entries;
    expect(entry?.title).toBe("Writing a document");
    expect(entry?.description).toContain("Microsoft Word");
    expect(entry?.applications[0]).toMatchObject({
      bundleIdentifier: "winword.exe",
      displayName: "Microsoft Word",
    });
    const state = await service.getState();
    expect(state.captureCapability).toMatchObject({
      mode: "interaction_activity",
      activitySummaries: true,
    });
    expect(state.privateBrowsingExcluded).toBe(true);

    // Neither the OCR text, the window title nor the app name is readable on disk.
    const ciphertext = await readFile(join(rootDir, "events.moss-history"), "utf8");
    expect(ciphertext).not.toMatch(/falcon|confidential|memo|word/iu);
    const timeline = JSON.stringify(await service.listHistory());
    expect(timeline).not.toMatch(/falcon|confidential|memo\.docx/iu);
    expect(adapter.state.calls).toMatchObject({ probe: 1, capture: 1, ocr: 1 });
  });

  it.each([
    ["a browser", target({ processName: "chrome.exe", windowClass: "Chrome_WidgetWin_1" })],
    ["a focused password field", target({ passwordFocused: true })],
    ["a window that asked not to be captured", target({ displayAffinity: 0x11 })],
    ["a meeting", target({ processName: "Zoom.exe" })],
    ["the lock screen", target({ processName: "LockApp.exe" })],
  ])("never takes a frame of %s", async (_label, excluded) => {
    const adapter = fakeAdapter({
      probe: { capturedAtMs: Date.now(), idleSeconds: 1, target: excluded, others: [] },
    });
    const { service } = await makeWindowsService(adapter);
    await service.setEnabled({ enabled: true, consentAt });
    await vi.waitFor(() => expect(adapter.state.calls.probe).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.state.calls.capture).toBe(0);
    expect((await service.listHistory()).entries).toEqual([]);
  });

  it("takes no frame while the person has been idle for five minutes", async () => {
    const adapter = fakeAdapter({
      probe: { capturedAtMs: Date.now(), idleSeconds: 301, target: target(), others: [] },
    });
    const { service } = await makeWindowsService(adapter);
    await service.setEnabled({ enabled: true, consentAt });
    await vi.waitFor(() => expect(adapter.state.calls.probe).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.state.calls.capture).toBe(0);
  });

  it("honours excluded apps, pause, resume and clear", async () => {
    const adapter = fakeAdapter();
    const { service } = await makeWindowsService(adapter);
    const current = await service.getSettings();
    await service.updateSettings({
      settings: { ...current, observation: { ...current.observation, blocklist: ["winword.exe"] } },
    });
    await service.setEnabled({ enabled: true, consentAt });
    await vi.waitFor(() => expect(adapter.state.calls.probe).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.state.calls.capture).toBe(0);

    await service.pause();
    expect((await service.getState()).recorderState).toBe("paused");
    expect(adapter.state.calls.stop).toBe(1);
    await service.updateSettings({
      settings: { ...current, observation: { ...current.observation, blocklist: [] } },
    });
    expect(adapter.start).toHaveBeenCalledTimes(1);
    await service.resume();
    expect(adapter.start).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await service.listHistory()).entries).toHaveLength(1));
    await service.clearHistory({ scope: "all" });
    expect((await service.listHistory()).entries).toEqual([]);
  });

  it("keeps sampling after a settings change, every second while the person is typing", async () => {
    const adapter = fakeAdapter({
      probe: { capturedAtMs: Date.now(), idleSeconds: 0.2, target: target(), others: [] },
    });
    const { service } = await makeWindowsService(adapter);
    await service.setEnabled({ enabled: true, consentAt });
    await vi.waitFor(() => expect(adapter.state.calls.capture).toBeGreaterThan(0));
    await service.updateSettings({ settings: await service.getSettings() });
    const before = adapter.state.calls.capture;
    await vi.waitFor(() => expect(adapter.state.calls.capture).toBeGreaterThan(before + 1), {
      timeout: 5_000,
    });
    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  it("records the app alone when Windows OCR is not installed", async () => {
    const adapter = fakeAdapter({ ocr: { ocr: false } });
    const { service } = await makeWindowsService(adapter);
    await service.setEnabled({ enabled: true, consentAt });
    await vi.waitFor(async () => expect((await service.listHistory()).entries).toHaveLength(1));
    expect(adapter.state.calls.ocr).toBe(0);
    expect(adapter.state.calls.drop).toBe(1);
    const state = await service.getState();
    expect(state.captureCapability.detail).toMatch(/^Windows records application names only/u);
    expect(state.captureCapability.activitySummaries).toBe(false);
  });

  it("lists Start menu apps with icons under the ids it records", async () => {
    const adapter = fakeAdapter();
    const { service } = await makeWindowsService(adapter);
    const { applications } = await service.listApplications();
    expect(applications).toEqual([
      expect.objectContaining({ bundleIdentifier: "winword.exe", name: "Word", iconDataURL: PNG }),
      expect.objectContaining({ bundleIdentifier: "sublime-text.exe", name: "Sublime Text" }),
    ]);
    // History is off, so the catalog helper was short-lived.
    expect(adapter.state.calls.stop).toBe(1);
  });

  it("replaces a helper that dies, and reports a failure when it keeps dying", async () => {
    const adapter = fakeAdapter({ probe: null });
    const { service } = await makeWindowsService(adapter);
    await service.setEnabled({ enabled: true, consentAt });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.waitFor(() => expect(adapter.state.helpers.length).toBe(attempt + 1));
      adapter.state.helpers[attempt]!.options.onExit();
    }
    const state = await service.getState();
    expect(state).toMatchObject({ recorderState: "stopped", activationState: "failed" });
    expect(state.message).toMatch(/stopped unexpectedly/u);
  });
});
