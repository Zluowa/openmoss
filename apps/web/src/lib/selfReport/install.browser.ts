// FILE: install.browser.ts
// Purpose: The self-report tools as an outside agent reaches them: `window.mossSelfReport.call`
//          and WebMCP; console errors since the last call; screenshots at several sizes, each of
//          the element as it is laid out at that size, and the window given back afterwards.

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consoleReport, installConsoleCapture, type ConsoleCaptureTarget } from "./consoleCapture";
import { callSelfReportTool, installMossSelfReport, SELF_REPORT_TOOLS } from "./install";
import { takeScreenshots, type SelfReportCaptureBridge } from "./screenshot";

let uninstall: (() => void) | null = null;

beforeEach(async () => {
  await page.viewport(1000, 700);
  document.body.style.margin = "0";
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = "";
  delete (document as Document & { modelContext?: unknown }).modelContext;
});

describe("installMossSelfReport", () => {
  it("offers the four tools on the window, and to WebMCP as read-only tools", async () => {
    const registered: Array<Record<string, unknown>> = [];
    (document as Document & { modelContext?: unknown }).modelContext = {
      registerTool: (tool: Record<string, unknown>) => registered.push(tool),
    };
    uninstall = installMossSelfReport();
    expect(window.mossSelfReport?.tools.map((tool) => tool.name)).toEqual([
      "screen_report",
      "layout_report",
      "screenshot",
      "console_report",
    ]);
    expect(registered.map((tool) => tool.name)).toEqual(SELF_REPORT_TOOLS.map((tool) => tool.name));
    for (const tool of registered) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    }
    document.body.innerHTML = `<p>Hello from Moss</p>`;
    const viaWindow = (await window.mossSelfReport!.call("screen_report", {})) as { text: string };
    expect(viaWindow.text).toBe("Hello from Moss");
    const execute = registered[0]!.execute as (input: unknown) => Promise<{ text: string }>;
    expect((await execute({})).text).toBe("Hello from Moss");
    expect(await window.mossSelfReport!.call("no_such_tool", {})).toMatchObject({
      error: "Unknown self-report tool no_such_tool.",
    });
    expect(window.mossSelfReport!.version).toBe(1);
  });

  it("echoes the run id, and says how long it took and at what window size", async () => {
    uninstall = installMossSelfReport();
    document.body.innerHTML = `<p>Sized</p>`;
    for (const name of ["screen_report", "layout_report", "console_report"]) {
      const answer = (await window.mossSelfReport!.call(name, { runId: "tour-7" })) as {
        runId: string;
        ms: number;
        window: { width: number; height: number; dpr: number };
      };
      expect(answer.runId, name).toBe("tour-7");
      expect(answer.ms, name).toBeGreaterThanOrEqual(0);
      expect(answer.window, name).toEqual({
        width: 1000,
        height: 700,
        dpr: window.devicePixelRatio,
      });
    }
    const withoutRun = (await window.mossSelfReport!.call("console_report")) as object;
    expect(withoutRun).not.toHaveProperty("runId");
  });

  it("reports console errors and warnings since the last call", async () => {
    uninstall = installMossSelfReport();
    consoleReport();
    console.error("Composer failed", new Error("socket closed"));
    console.warn("slow frame");
    const first = (await window.mossSelfReport!.call("console_report")) as {
      entries: Array<{ level: string; text: string }>;
    };
    expect(first.entries.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: "error", text: "Composer failed Error: socket closed" },
      { level: "warn", text: "slow frame" },
    ]);
    const second = (await window.mossSelfReport!.call("console_report")) as { entries: [] };
    expect(second.entries).toEqual([]);
  });
});

describe("callSelfReportTool in the desktop app", () => {
  it("adds the desktop window's measured position to every answer", async () => {
    const answer = (await callSelfReportTool(
      "console_report",
      {},
      {
        resize: async () => undefined,
        capture: async () => ({ path: "", width: 0, height: 0 }),
        restore: async () => undefined,
        placement: async () => ({ left: -3221, top: 40, offscreen: true }),
      },
    )) as { window: Record<string, unknown> };
    expect(answer.window).toEqual({
      width: 1000,
      height: 700,
      dpr: window.devicePixelRatio,
      left: -3221,
      top: 40,
      offscreen: true,
    });
  });
});

describe("installConsoleCapture", () => {
  it("records uncaught errors and unhandled rejections with where they came from", () => {
    // Its own event target: the test page's window reports uncaught errors to the runner.
    const target = Object.assign(new EventTarget(), {
      console: { error: vi.fn(), warn: vi.fn() },
    }) as unknown as ConsoleCaptureTarget & EventTarget;
    const stop = installConsoleCapture(target);
    consoleReport();
    target.dispatchEvent(
      new ErrorEvent("error", {
        message: "boom",
        error: new TypeError("x is undefined"),
        filename: "moss://app/assets/index.js",
        lineno: 3,
        colno: 9,
      }),
    );
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("fetch failed");
    target.dispatchEvent(rejection);
    expect(
      consoleReport().entries.map(({ level, text, source }) => ({ level, text, source })),
    ).toEqual([
      {
        level: "error",
        text: "TypeError: x is undefined",
        source: "moss://app/assets/index.js:3:9",
      },
      { level: "error", text: "Unhandled rejection: Error: fetch failed", source: undefined },
    ]);
    stop();
  });

  it("keeps the console working and counts what did not fit", () => {
    const error = vi.fn();
    const target = Object.assign(new EventTarget(), {
      console: { error, warn: vi.fn() },
    }) as unknown as ConsoleCaptureTarget & EventTarget;
    const stop = installConsoleCapture(target);
    consoleReport();
    for (let i = 0; i < 310; i += 1) target.console.error(`error ${i}`);
    expect(error).toHaveBeenCalledTimes(310);
    const report = consoleReport();
    expect(report.entries).toHaveLength(300);
    expect(report.dropped).toBe(10);
    stop();
  });
});

describe("takeScreenshots", () => {
  function fakeBridge() {
    const captures: Array<{ rect?: unknown; name: string; viewport: number[] }> = [];
    const calls: string[] = [];
    const bridge: SelfReportCaptureBridge = {
      resize: async ({ width, height }) => {
        calls.push(`resize ${width}x${height}`);
        await page.viewport(width, height);
      },
      capture: async ({ rect, name }) => {
        calls.push(`capture ${name}`);
        captures.push({ rect, name, viewport: [window.innerWidth, window.innerHeight] });
        return {
          path: `C:/shots/${name}.png`,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      },
      restore: async () => {
        calls.push("restore");
        await page.viewport(1000, 700);
      },
    };
    return { bridge, captures, calls };
  }

  it("captures one element as it is laid out at each size, then gives the window back", async () => {
    document.body.innerHTML = `<div id="panel" style="position:absolute;left:10px;top:20px;width:50%;height:100px"></div>`;
    const { bridge, captures, calls } = fakeBridge();
    const result = await takeScreenshots(bridge, {
      selector: "#panel",
      sizes: [
        { width: 1101, height: 782 },
        { width: 600, height: 500 },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.files.map((file) => file.viewport)).toEqual([
      { width: 1101, height: 782 },
      { width: 600, height: 500 },
    ]);
    // Half the window wide at each size: measured after the layout, not before.
    expect(captures.map((capture) => capture.rect)).toEqual([
      { x: 10, y: 20, width: 550.5, height: 100 },
      { x: 10, y: 20, width: 300, height: 100 },
    ]);
    expect(calls).toEqual([
      "resize 1101x782",
      "capture element-1101x782",
      "resize 600x500",
      "capture element-600x500",
      "restore",
    ]);
    expect(window.innerWidth).toBe(1000);
  });

  it("corrects a window that lands a few pixels off the asked size", async () => {
    // Seen off-screen on Windows: every new size came out 15x8 too large.
    const { bridge, calls } = fakeBridge();
    const oversized: SelfReportCaptureBridge = {
      ...bridge,
      resize: async ({ width, height }) => {
        calls.push(`resize ${width}x${height}`);
        await page.viewport(width + 15, height + 8);
      },
    };
    const result = await takeScreenshots(oversized, { sizes: [{ width: 1375, height: 886 }] });
    expect(result.error).toBeUndefined();
    expect(result.files.map((file) => file.viewport)).toEqual([{ width: 1375, height: 886 }]);
    expect(calls).toEqual([
      "resize 1375x886",
      "resize 1360x878",
      "capture window-1375x886",
      "restore",
    ]);
  });

  it("gives the window back when a capture fails, and says why", async () => {
    const { bridge, calls } = fakeBridge();
    const result = await takeScreenshots(bridge, { selector: "#missing", sizes: "standard" });
    expect(result.error).toBe("No element matches #missing.");
    expect(calls).toEqual(["resize 1101x782", "restore"]);
  });

  it("needs the desktop app, and sane sizes", async () => {
    expect(await takeScreenshots(undefined, {})).toEqual({
      files: [],
      error: "Screenshots need the Moss desktop app.",
    });
    const { bridge } = fakeBridge();
    expect((await takeScreenshots(bridge, { sizes: [{ width: 10, height: 10 }] })).error).toMatch(
      /between 200/,
    );
  });
});
