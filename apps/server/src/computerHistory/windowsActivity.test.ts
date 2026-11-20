// FILE: windowsActivity.test.ts
// Purpose: Windows Computer History rules: probe parsing, exclusions, cadence, local summaries.
// Layer: Computer History Windows adapter tests (pure, run on every platform)

import { describe, expect, it } from "vitest";

import {
  assessWindowsHistoryProbe,
  parseWindowsHistoryFingerprint,
  parseWindowsHistoryProbe,
  summarizeWindowsActivity,
  WINDOWS_HISTORY_CADENCE,
  WindowsHistoryCadence,
  windowsHistoryAppId,
  type WindowsHistoryProbe,
  type WindowsHistoryTarget,
} from "./windowsActivity.ts";

function target(overrides: Partial<WindowsHistoryTarget> = {}): WindowsHistoryTarget {
  return {
    hwnd: 4242,
    processName: "Notepad.exe",
    displayName: "Notepad",
    windowClass: "Notepad",
    title: "draft.txt - Notepad",
    cloaked: false,
    minimized: false,
    displayAffinity: 0,
    passwordFocused: false,
    focusedControl: "ControlType.Document",
    ...overrides,
  };
}

function probe(overrides: Partial<WindowsHistoryProbe> = {}): WindowsHistoryProbe {
  return { capturedAtMs: 1_000, idleSeconds: 3, target: target(), others: [], ...overrides };
}

const grid = (value: number) => new Uint8Array(256).fill(value);

describe("parseWindowsHistoryProbe", () => {
  it("accepts the helper's shape and drops unknown fields", () => {
    const parsed = parseWindowsHistoryProbe({
      id: 3,
      type: "probe",
      capturedAtMs: 1_700_000_000_000,
      idleSeconds: 0.5,
      target: { ...target(), path: "C:/private/file.txt" },
      others: [{ processName: "Zoom.exe", title: "Zoom Meeting" }, { bogus: true }],
    });
    expect(parsed?.target).toEqual(target());
    expect(parsed?.others).toEqual([{ processName: "Zoom.exe", title: "Zoom Meeting" }]);
    expect(parseWindowsHistoryProbe({ capturedAtMs: 5, idleSeconds: null, target: null })).toEqual({
      capturedAtMs: 5,
      idleSeconds: null,
      target: null,
      others: [],
    });
  });

  it("fails closed on malformed replies", () => {
    expect(parseWindowsHistoryProbe(null)).toBeNull();
    expect(parseWindowsHistoryProbe({ capturedAtMs: 0, idleSeconds: 1, target: null })).toBeNull();
    expect(
      parseWindowsHistoryProbe({ capturedAtMs: 5, idleSeconds: 1, target: { hwnd: 1 } }),
    ).toBeNull();
    expect(
      parseWindowsHistoryProbe({
        capturedAtMs: 5,
        idleSeconds: 1,
        target: { ...target(), processName: "C:\\Windows\\notepad.exe" },
      }),
    ).toBeNull();
    expect(
      parseWindowsHistoryProbe({ capturedAtMs: 5, idleSeconds: -1, target: target() }),
    ).toBeNull();
  });
});

describe("windowsHistoryAppId", () => {
  it("is the lower-case executable name the encrypted store accepts", () => {
    expect(windowsHistoryAppId("Notepad.exe")).toBe("notepad.exe");
    expect(windowsHistoryAppId("Code")).toBe("code.exe");
    expect(windowsHistoryAppId("sublime_text.exe")).toBe("sublime-text.exe");
    expect(windowsHistoryAppId("Code - Insiders.exe")).toBe("code-insiders.exe");
    expect(windowsHistoryAppId("微信.exe")).toBe("u-e5beaee4bfa1.exe");
    expect(windowsHistoryAppId("--.exe")).toBeNull();
    expect(windowsHistoryAppId("")).toBeNull();
  });
});

describe("assessWindowsHistoryProbe", () => {
  it("allows an ordinary app window", () => {
    expect(assessWindowsHistoryProbe(probe())).toEqual({ allowed: true });
  });

  it.each([
    ["no foreground window", probe({ target: null }), "no_foreground"],
    [
      "the lock screen",
      probe({ target: target({ processName: "LockApp.exe" }) }),
      "secure_surface",
    ],
    ["a UAC prompt", probe({ target: target({ processName: "consent.exe" }) }), "secure_surface"],
    [
      "a password manager",
      probe({ target: target({ processName: "KeePassXC.exe" }) }),
      "secure_surface",
    ],
    [
      "the computer-use driver",
      probe({ target: target({ processName: "cua-driver.exe" }) }),
      "moss_helper",
    ],
    ["a minimized window", probe({ target: target({ minimized: true }) }), "hidden"],
    ["a cloaked window", probe({ target: target({ cloaked: true }) }), "hidden"],
    [
      "a window excluded from capture",
      probe({ target: target({ displayAffinity: 0x11 }) }),
      "excluded_from_capture",
    ],
    [
      "a focused password field",
      probe({ target: target({ passwordFocused: true }) }),
      "password_field",
    ],
    ["Chrome", probe({ target: target({ processName: "chrome.exe" }) }), "browser"],
    ["Edge", probe({ target: target({ processName: "msedge.exe" }) }), "browser"],
    [
      "an unknown Chromium window",
      probe({ target: target({ processName: "unknown.exe", windowClass: "Chrome_WidgetWin_1" }) }),
      "browser",
    ],
    ["Zoom", probe({ target: target({ processName: "Zoom.exe" }) }), "video_conference"],
    [
      "a Tencent Meeting window elsewhere on screen",
      probe({ others: [{ processName: "wemeetapp.exe", title: "腾讯会议" }] }),
      "video_conference",
    ],
    [
      "a meeting title in any app",
      probe({ target: target({ title: "Weekly sync | Microsoft Teams" }) }),
      "video_conference",
    ],
  ])("excludes %s", (_label, value, reason) => {
    expect(assessWindowsHistoryProbe(value)).toEqual({ allowed: false, reason });
  });

  it("does not treat a focus state UI Automation could not read as a password field", () => {
    expect(assessWindowsHistoryProbe(probe({ target: target({ passwordFocused: null }) }))).toEqual(
      { allowed: true },
    );
  });

  it("allows desktop apps built on Chromium", () => {
    expect(
      assessWindowsHistoryProbe(
        probe({ target: target({ processName: "Code.exe", windowClass: "Chrome_WidgetWin_1" }) }),
      ),
    ).toEqual({ allowed: true });
  });
});

describe("WindowsHistoryCadence", () => {
  const capture = (
    cadence: WindowsHistoryCadence,
    fingerprint: Uint8Array,
    atMs: number,
    extra: Partial<{ durationMs: number; recentUserInput: boolean; targetKey: string }> = {},
  ) =>
    cadence.recordCapture({
      fingerprint,
      targetKey: extra.targetKey ?? "notepad.exe:1",
      monotonicMs: atMs,
      wallClockMs: atMs,
      durationMs: extra.durationMs ?? 50,
      recentUserInput: extra.recentUserInput ?? false,
    });

  it("follows the macOS sampling policy", () => {
    const cadence = new WindowsHistoryCadence();
    expect(capture(cadence, grid(10), 0)).toEqual({ evidence: "first_frame", nextDelayMs: 5_000 });
    expect(capture(cadence, grid(11), 5_000)).toEqual({ evidence: null, nextDelayMs: 15_000 });
    expect(capture(cadence, grid(10), 20_000)).toEqual({ evidence: null, nextDelayMs: 15_000 });
    expect(capture(cadence, grid(12), 35_000)).toEqual({ evidence: null, nextDelayMs: 30_000 });
    expect(capture(cadence, grid(40), 50_000)).toEqual({
      evidence: "visual_change",
      nextDelayMs: 5_000,
    });
    // Same minute, no change.
    expect(capture(cadence, grid(40), 55_000).evidence).toBeNull();
    // A new minute bucket is evidence even without visual change.
    expect(capture(cadence, grid(40), 61_000).evidence).toBe("minute_bucket");
    expect(capture(cadence, grid(40), 121_500).evidence).toBe("heartbeat");
  });

  it("samples faster after input, slower after a slow capture, and treats a window switch as change", () => {
    const cadence = new WindowsHistoryCadence();
    capture(cadence, grid(10), 0);
    expect(capture(cadence, grid(10), 1_000, { recentUserInput: true }).nextDelayMs).toBe(1_000);
    expect(capture(cadence, grid(10), 2_000, { durationMs: 2_000 }).nextDelayMs).toBe(30_000);
    expect(capture(cadence, grid(10), 3_000, { targetKey: "code.exe:9" }).evidence).toBe(
      "visual_change",
    );
    expect(cadence.recordFailure()).toBe(WINDOWS_HISTORY_CADENCE.failureDelayMs);
  });

  it("pauses after five idle minutes and fails open when idle time is unknown", () => {
    expect(WindowsHistoryCadence.idlePaused(299)).toBe(false);
    expect(WindowsHistoryCadence.idlePaused(300)).toBe(true);
    expect(WindowsHistoryCadence.idlePaused(null)).toBe(false);
  });

  it("reads only well-formed fingerprints", () => {
    expect(parseWindowsHistoryFingerprint("0a".repeat(256))?.[0]).toBe(10);
    expect(parseWindowsHistoryFingerprint("0a".repeat(255))).toBeNull();
    expect(parseWindowsHistoryFingerprint("zz".repeat(256))).toBeNull();
    expect(parseWindowsHistoryFingerprint(null)).toBeNull();
  });
});

describe("summarizeWindowsActivity", () => {
  it("names the activity and the app, never the words on screen", () => {
    const summary = summarizeWindowsActivity({
      processName: "WINWORD.EXE",
      displayName: "Microsoft Word",
      focusedControl: "ControlType.Document",
      ocrText: "Falcon acquisition memo — confidential numbers for Q3",
    });
    expect(summary).toEqual({
      title: "Writing a document",
      description: "Read or edited a document in Microsoft Word.",
      source: "windows_on_device",
    });
    expect(JSON.stringify(summary)).not.toMatch(/falcon|confidential|q3/iu);
  });

  it("recognises code on screen in an app it does not know", () => {
    expect(
      summarizeWindowsActivity({
        processName: "MossHistoryFixture.exe",
        displayName: "",
        focusedControl: null,
        ocrText:
          'import { render } from "./view"; const total = items.length; function draw(items) { return total; }',
      })?.title,
    ).toBe("Writing code");
  });

  it("produces no summary for a frame without readable text, like macOS", () => {
    expect(
      summarizeWindowsActivity({
        processName: "Code.exe",
        displayName: "Visual Studio Code",
        focusedControl: null,
        ocrText: "  \n ",
      }),
    ).toBeUndefined();
  });

  it("drops an app name that looks like a host or path", () => {
    const summary = summarizeWindowsActivity({
      processName: "tool.exe",
      displayName: "evil.example.com",
      focusedControl: null,
      ocrText: "Some text",
    });
    expect(summary?.title).toBe("Using tool");
    expect(JSON.stringify(summary)).not.toContain("example.com");
  });
});
