// FILE: backendStartupGiveUpWiring.test.ts
// Purpose: Guards how main reports a backend that cannot start: the reason reaches the
//          desktop log, and the window is told before any native dialog is considered.
// Layer: Desktop backend supervision test

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function functionBody(name: string): string {
  const start = mainSource.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = mainSource.indexOf("\nfunction ", start + 1);
  const nextAsync = mainSource.indexOf("\nasync function ", start + 1);
  const end = Math.min(...[next, nextAsync].filter((index) => index > start));
  return mainSource.slice(start, end);
}

describe("backend give-up wiring in desktop main", () => {
  it("writes the backend's last error line to the desktop log on every unexpected exit and on give-up", () => {
    expect(mainSource).toContain(
      '`backend exited unexpectedly ${reason} lastError=${backendExitLogDetail(lastBackendFailureDetail) || "none"}`',
    );
    expect(functionBody("scheduleBackendRestart")).toContain(
      'lastError=${backendExitLogDetail(lastBackendFailureDetail ?? "") || "none"}',
    );
  });

  it("publishes the failure to the window first and keeps the native dialog as the fallback", () => {
    const body = functionBody("presentBackendStartupGiveUp");
    const publish = body.indexOf("setBackendStartupFailure({");
    const windowCheck = body.indexOf("if (hasBackendStartupFailureRenderer()) return;");
    const nativeDialog = body.indexOf("dialog.showMessageBox(");
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(windowCheck).toBeGreaterThan(publish);
    expect(nativeDialog).toBeGreaterThan(windowCheck);
  });

  it("clears the failure whenever a deliberate start begins", () => {
    expect(functionBody("startBackend")).toMatch(
      /if \(trigger === "lifecycle"\) \{\s+backendSupervision\.reset\(\);\s+setBackendStartupFailure\(null\);/u,
    );
  });
});
