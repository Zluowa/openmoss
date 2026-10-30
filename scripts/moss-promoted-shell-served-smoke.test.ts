import { describe, expect, it } from "vitest";

import {
  recordBrowserConsole,
  recordBrowserFailure,
  type BrowserDiagnostics,
} from "./moss-promoted-shell-served-smoke.ts";

describe("moss-promoted-shell-served-smoke browser diagnostics", () => {
  it("retains early browser failures after ordinary log-tail truncation", () => {
    const diagnostics: BrowserDiagnostics = { failureTail: [], logTail: [] };

    recordBrowserConsole(diagnostics, "error", "early console failure");
    recordBrowserFailure(diagnostics, "pageerror", "early page failure");
    recordBrowserFailure(
      diagnostics,
      "requestfailed",
      "early request failure https://example.invalid",
    );
    for (let index = 0; index < 100; index += 1) {
      recordBrowserConsole(diagnostics, "info", `ordinary message ${index}`);
    }

    expect(diagnostics.logTail).toHaveLength(80);
    expect(diagnostics.logTail).not.toContain("[error] early console failure");
    expect(diagnostics.logTail).not.toContain("[pageerror] early page failure");
    expect(diagnostics.logTail).not.toContain(
      "[requestfailed] early request failure https://example.invalid",
    );
    expect(diagnostics.failureTail).toEqual([
      "[error] early console failure",
      "[pageerror] early page failure",
      "[requestfailed] early request failure https://example.invalid",
    ]);
  });
});
