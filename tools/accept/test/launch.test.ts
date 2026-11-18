import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acceptanceEnvironment, APP_ARGS } from "../lib/launch.ts";
import { runTour, type Actor, type ToolCaller } from "../lib/run.ts";
import { parseTour } from "../lib/tour.ts";
import { startWindowMover, windowsOf } from "../lib/window.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accept-launch-"));
  dirs.push(d);
  return d;
}

describe("isolation", () => {
  it("turns off everything that writes outside the run and keeps every folder inside it", () => {
    const root = path.join(tempDir(), "profile");
    const env = acceptanceEnvironment(root, {
      PATH: process.env.PATH,
      MOSS_REMOTE_DEBUGGING_PORT: "9222",
    });
    expect(env).toMatchObject({
      MOSS_SELF_REPORT: "1",
      MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: "1",
      MOSS_DISABLE_SHORTCUT_ICON_SYNC: "1",
      MOSS_DISABLE_PROVIDER_UPDATES: "1",
      MOSS_SELF_REPORT_WINDOW: "offscreen",
      MOSS_DISABLE_AUTO_UPDATE: "1",
      NO_PROXY: "*",
    });
    expect(env.MOSS_REMOTE_DEBUGGING_PORT).toBeUndefined();
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "MOSS_HOME",
      "CODEX_HOME",
      "CODEX_SQLITE_HOME",
      "CLAUDE_CONFIG_DIR",
      "MOSS_DESKTOP_USER_DATA_DIR",
      "TEMP",
      "TMP",
    ]) {
      expect(path.resolve(String(env[key])).startsWith(path.resolve(root)), key).toBe(true);
    }
  });

  it("opens the debugging port on loopback only and keeps painting off-screen", () => {
    expect(APP_ARGS(41234)).toEqual(
      expect.arrayContaining([
        "--remote-debugging-port=41234",
        "--remote-debugging-address=127.0.0.1",
        "--disable-features=CalculateNativeWinOcclusion",
      ]),
    );
  });
});

describe("the screen guard", () => {
  const actor: Actor = {
    click: async () => {},
    press: async () => {},
    type: async () => {},
    waitFor: async () => {},
  };
  const call: ToolCaller = async () => ({ files: [{}], findings: [], entries: [] });

  it("stops the tour before its first step when a window is on the screen", async () => {
    const tour = parseTour({
      name: "t",
      steps: [
        { do: "click", selector: "#x" },
        { do: "report", label: "a", tools: ["layout_report"] },
      ],
    });
    let clicked = false;
    const result = await runTour(tour, {
      call,
      actor: { ...actor, click: async () => void (clicked = true) },
      outDir: tempDir(),
      runId: "g1",
      guard: () => {
        throw new Error("a Moss window was on the screen before the first step");
      },
    });
    expect(clicked).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.problems[0]).toMatchObject({ step: "start", kind: "step-failed" });
  });

  it("checks before and after every screenshot", async () => {
    const seen: string[] = [];
    const tour = parseTour({
      name: "t",
      steps: [{ do: "report", label: "home", tools: ["layout_report", "screenshot"] }],
    });
    const result = await runTour(tour, {
      call,
      actor,
      outDir: tempDir(),
      runId: "g2",
      guard: (when) => void seen.push(when),
    });
    expect(result.pass).toBe(true);
    expect(seen).toEqual([
      "before the first step",
      'before the screenshot at "home"',
      'after the screenshot at "home"',
    ]);
  });
});

describe.runIf(process.platform === "win32")("Win32 window scripts", () => {
  it("compile and answer for a process without windows", async () => {
    expect(windowsOf(process.pid)).toEqual([]);
    const mover = await startWindowMover(tempDir(), () => {});
    mover.stop();
  }, 60_000);
});
