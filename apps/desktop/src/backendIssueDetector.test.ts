import { describe, expect, it, vi } from "vitest";
import { DESKTOP_DIAGNOSTIC_ISSUE_PREFIX } from "@synara/contracts";
import { BackendIssueDetector } from "./backendIssueDetector";

describe("desktop diagnostic issue framing", () => {
  it("emits the current brand and reads current and historical backend reports", () => {
    expect(DESKTOP_DIAGNOSTIC_ISSUE_PREFIX).toBe("MOSS_DIAGNOSTIC_ISSUE ");
    const report = vi.fn();
    const detector = new BackendIssueDetector(report);
    detector.push(
      Buffer.from(`${DESKTOP_DIAGNOSTIC_ISSUE_PREFIX}{"code":"current"}\nSYNARA_DIAGNOSTIC_`),
      "stdout",
    );
    detector.push(Buffer.from('ISSUE {"code":"legacy"}\n'), "stdout");
    expect(report.mock.calls).toEqual([[{ code: "current" }], [{ code: "legacy" }]]);
  });

  it("keeps malformed, oversized and ordinary lines outside diagnostic reporting", () => {
    const report = vi.fn();
    const detector = new BackendIssueDetector(report);
    detector.push(
      Buffer.from(
        `SYNARA_DIAGNOSTIC_ISSUE invalid\n${DESKTOP_DIAGNOSTIC_ISSUE_PREFIX}${"x".repeat(2100)}\nordinary log\n`,
      ),
      "stdout",
    );
    expect(report).not.toHaveBeenCalled();
    detector.push(Buffer.from(`${DESKTOP_DIAGNOSTIC_ISSUE_PREFIX}{"code":"after"}\n`), "stdout");
    expect(report).toHaveBeenCalledExactlyOnceWith({ code: "after" });
  });
});
