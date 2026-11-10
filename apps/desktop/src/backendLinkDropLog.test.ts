import { describe, expect, it } from "vitest";

import { BackendLinkDropLog } from "./backendLinkDropLog";

function setup() {
  const lines: string[] = [];
  let now = 1_000;
  const log = new BackendLinkDropLog(
    (line) => lines.push(line),
    () => now,
  );
  return {
    lines,
    log,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("BackendLinkDropLog", () => {
  it("writes one line with reason and duration when the link recovers", () => {
    const { lines, log, advance } = setup();
    log.receive({ phase: "down", reason: "socket-closed" });
    advance(3_210);
    log.receive({ phase: "up" });
    expect(lines).toEqual([
      "backend link drop reason=socket-closed backend=running durationMs=3210 outcome=recovered",
    ]);
  });

  it.each([
    ["before the socket notices", 40, 0],
    ["after the socket notices", 0, 40],
  ])("names the backend exit that lands %s", (_name, beforeDown, afterDown) => {
    const { lines, log, advance } = setup();
    if (beforeDown > 0) {
      log.recordBackendExit("code=1 signal=null");
      advance(beforeDown);
    }
    log.receive({ phase: "down", reason: "socket-closed" });
    if (afterDown > 0) {
      advance(afterDown);
      log.recordBackendExit("code=1 signal=null");
    }
    advance(2_000);
    log.receive({ phase: "up" });
    expect(lines[0]).toContain("backend=exited(code=1 signal=null)");
  });

  it("does not blame an old backend exit for a later drop", () => {
    const { lines, log, advance } = setup();
    log.recordBackendExit("code=1 signal=null");
    advance(60_000);
    log.receive({ phase: "down", reason: "silence-timeout" });
    advance(100);
    log.receive({ phase: "up" });
    expect(lines[0]).toContain("reason=silence-timeout backend=running");
  });

  it("counts a flapping reconnect as one drop and keeps the first reason", () => {
    const { lines, log, advance } = setup();
    log.receive({ phase: "down", reason: "stream-ended" });
    advance(500);
    log.receive({ phase: "down", reason: "socket-closed" });
    advance(500);
    log.receive({ phase: "up" });
    log.receive({ phase: "up" });
    expect(lines).toEqual([
      "backend link drop reason=stream-ended backend=running durationMs=1000 outcome=recovered",
    ]);
  });

  it("still records a drop that never recovers before quit", () => {
    const { lines, log, advance } = setup();
    log.receive({ phase: "down", reason: "socket-closed" });
    advance(70_000);
    log.finish("app-quit");
    log.finish("app-quit");
    expect(lines).toEqual([
      "backend link drop reason=socket-closed backend=running durationMs=70000 outcome=app-quit",
    ]);
  });

  it("writes nothing when the link was never down", () => {
    const { lines, log } = setup();
    log.receive({ phase: "up" });
    log.finish("app-quit");
    expect(lines).toEqual([]);
  });

  it.each([
    [null],
    ["down"],
    [{ phase: "down" }],
    [{ phase: "down", reason: "token=secret\nforged line" }],
    [{ phase: "sideways" }],
  ])("ignores a malformed report: %j", (input) => {
    const { lines, log } = setup();
    log.receive(input);
    log.receive({ phase: "up" });
    expect(lines).toEqual([]);
  });
});
