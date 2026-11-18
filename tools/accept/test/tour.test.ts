import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { refuseMirror, SMOKE_TOUR } from "../lib/codeUpdate.ts";
import { runTour, type Actor, type ToolCaller } from "../lib/run.ts";
import { parseTour, TourError, verdict } from "../lib/tour.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accept-"));
  dirs.push(d);
  return d;
}

const report = (extra: Record<string, unknown> = {}) => ({
  do: "report",
  label: "home",
  tools: ["screen_report", "layout_report", "screenshot", "console_report"],
  ...extra,
});

describe("parseTour", () => {
  it("accepts the tours shipped with the kit", () => {
    const toursDir = path.join(import.meta.dirname, "..", "tours");
    const files = fs.readdirSync(toursDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(
        () => parseTour(JSON.parse(fs.readFileSync(path.join(toursDir, f), "utf8"))),
        f,
      ).not.toThrow();
    }
  });

  it("refuses tours that prove nothing or name unknown things", () => {
    expect(() => parseTour({ name: "t", steps: [{ do: "wait", ms: 1 }] })).toThrow(
      /at least one report/,
    );
    expect(() => parseTour({ name: "t", steps: [report({ tools: ["read_tokens"] })] })).toThrow(
      TourError,
    );
    expect(() => parseTour({ name: "t", steps: [{ do: "teleport" }, report()] })).toThrow(
      /unknown step/,
    );
    expect(() => parseTour({ name: "t", steps: [report(), report()] })).toThrow(/used twice/);
    expect(() =>
      parseTour({ name: "t", steps: [report({ sizes: [{ width: 50, height: 50 }] })] }),
    ).toThrow(/between 200x200/);
  });
});

describe("verdict", () => {
  const tour = parseTour({ name: "t", steps: [report()] });
  const good = {
    screen_report: { text: "Moss" },
    layout_report: { findings: [] },
    screenshot: { files: [{ path: "a.png" }] },
    console_report: { entries: [{ level: "warn", text: "slow" }] },
  };

  it("passes clean answers; warnings never fail", () => {
    expect(verdict(tour, [{ label: "home", answers: good, allowLayoutFindings: 0 }], [])).toEqual({
      pass: true,
      problems: [],
    });
  });

  it("fails on layout findings beyond the allowance, console errors, tool errors and missing screenshots", () => {
    const bad = {
      layout_report: { findings: [{ kind: "overflow", selector: "[data-slot=composer]" }] },
      screenshot: { files: [], error: "capture failed" },
      console_report: { entries: [{ level: "error", text: "TypeError: x is undefined" }] },
    };
    const { pass, problems } = verdict(
      tour,
      [{ label: "home", answers: bad, allowLayoutFindings: 0 }],
      [],
    );
    expect(pass).toBe(false);
    expect(problems.map((p) => p.kind).toSorted()).toEqual([
      "console",
      "layout",
      "screenshot",
      "tool-error",
    ]);
    expect(problems.find((p) => p.kind === "layout")?.detail).toMatch(
      /overflow \[data-slot=composer\]/,
    );
    expect(
      verdict(
        tour,
        [{ label: "home", answers: { layout_report: bad.layout_report }, allowLayoutFindings: 1 }],
        [],
      ).pass,
    ).toBe(true);
  });
});

describe("runTour", () => {
  it("acts, calls each tool with the run id and its own folder, and writes every answer", async () => {
    const out = tempDir();
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const call: ToolCaller = async (name, input) => {
      calls.push({ name, input });
      if (name === "screenshot")
        return { files: [{ path: path.join(String(input.dir), "a.png") }] };
      if (name === "layout_report") return { findings: [] };
      if (name === "console_report") return { entries: [] };
      return { text: "ok" };
    };
    const acted: string[] = [];
    const actor: Actor = {
      click: async (s) => void acted.push(`click ${s}`),
      press: async (k) => void acted.push(`press ${k}`),
      type: async (s, t) => void acted.push(`type ${s} ${t}`),
      waitFor: async (s) => void acted.push(`waitFor ${s}`),
    };
    const tour = parseTour({
      name: "t",
      steps: [
        { do: "waitFor", selector: "#root" },
        { do: "press", key: "Escape" },
        report({ sizes: "standard" }),
      ],
    });
    const result = await runTour(tour, { call, actor, outDir: out, runId: "r1" });
    expect(result.pass).toBe(true);
    expect(acted).toEqual(["waitFor #root", "press Escape"]);
    expect(calls.map((c) => c.name)).toEqual([
      "screen_report",
      "layout_report",
      "screenshot",
      "console_report",
    ]);
    expect(calls.every((c) => c.input.runId === "r1")).toBe(true);
    const shot = calls.find((c) => c.name === "screenshot")!.input;
    expect(shot.sizes).toBe("standard");
    expect(String(shot.dir)).toBe(path.join(out, "03-home"));
    expect(fs.existsSync(path.join(out, "03-home", "layout_report.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8")).pass).toBe(true);
  });

  it("stops at a failed step and fails the tour, naming the step", async () => {
    const out = tempDir();
    const actor: Actor = {
      click: async () => {
        throw new Error("locator did not match");
      },
      press: async () => {},
      type: async () => {},
      waitFor: async () => {},
    };
    const call: ToolCaller = async () => ({ findings: [], files: [{}], entries: [] });
    const tour = parseTour({ name: "t", steps: [{ do: "click", selector: "#missing" }, report()] });
    const result = await runTour(tour, { call, actor, outDir: out, runId: "r2" });
    expect(result.pass).toBe(false);
    expect(result.problems).toEqual([
      { step: "step 1 (click)", kind: "step-failed", detail: "locator did not match" },
    ]);
    expect(result.reports).toEqual([]);
  });

  it("turns a tool that throws or times out into a tool error, not a crash", async () => {
    const out = tempDir();
    const call: ToolCaller = async (name) => {
      if (name === "layout_report") throw new Error("layout_report took longer than 15000 ms");
      return { files: [{}], entries: [] };
    };
    const actor: Actor = {
      click: async () => {},
      press: async () => {},
      type: async () => {},
      waitFor: async () => {},
    };
    const tour = parseTour({
      name: "t",
      steps: [report({ tools: ["layout_report", "screenshot"] })],
    });
    const result = await runTour(tour, { call, actor, outDir: out, runId: "r3" });
    expect(result.pass).toBe(false);
    expect(result.problems[0]).toMatchObject({
      kind: "tool-error",
      detail: expect.stringMatching(/took longer/),
    });
  });
});

describe("code-update pipeline", () => {
  it("refuses a checkout of the public mirror and keeps the private source", () => {
    expect(refuseMirror("https://github.com/Zluowa/openmoss.git")).toMatch(/public mirror/);
    expect(refuseMirror("https://github.com/example/private-source.git")).toBeUndefined();
  });

  it("smokes the home screen with every tool and no tolerance", () => {
    const report = SMOKE_TOUR.steps.find((s) => s.do === "report");
    expect(report).toMatchObject({
      tools: ["console_report", "screen_report", "layout_report", "screenshot"],
    });
    expect(SMOKE_TOUR.allowConsoleErrors ?? 0).toBe(0);
    expect(report && "allowLayoutFindings" in report ? report.allowLayoutFindings : 0).toBe(0);
  });
});

describe("layout_report in motion", () => {
  it("asks once more when the screen was still moving, and judges the second answer", async () => {
    const out = tempDir();
    let layoutCalls = 0;
    const call: ToolCaller = async (name) => {
      if (name !== "layout_report") return {};
      layoutCalls += 1;
      return layoutCalls === 1 ? { findings: [], inMotion: 2 } : { findings: [], inMotion: 0 };
    };
    const actor: Actor = {
      click: async () => {},
      press: async () => {},
      type: async () => {},
      waitFor: async () => {},
    };
    const tour = parseTour({ name: "t", steps: [report({ tools: ["layout_report"] })] });
    const result = await runTour(tour, { call, actor, outDir: out, runId: "r4" });
    expect(layoutCalls).toBe(2);
    expect(result.pass).toBe(true);
  });
});

describe("window placement reported by Moss (#704)", () => {
  it("fails a report step whose answer says the window is on a display; older answers pass", () => {
    const tour = parseTour({ name: "t", steps: [report()] });
    const on = {
      screen_report: {
        text: "x",
        window: { width: 1101, height: 782, offscreen: false, left: 0, top: 0 },
      },
    };
    const off = {
      screen_report: {
        text: "x",
        window: { width: 1101, height: 782, offscreen: true, left: -5000, top: 80 },
      },
    };
    const old = { screen_report: { text: "x", window: { width: 1101, height: 782 } } };
    expect(
      verdict(tour, [{ label: "home", answers: on, allowLayoutFindings: 0 }], []).problems,
    ).toEqual([expect.objectContaining({ kind: "on-screen" })]);
    expect(verdict(tour, [{ label: "home", answers: off, allowLayoutFindings: 0 }], []).pass).toBe(
      true,
    );
    expect(verdict(tour, [{ label: "home", answers: old, allowLayoutFindings: 0 }], []).pass).toBe(
      true,
    );
  });
});
