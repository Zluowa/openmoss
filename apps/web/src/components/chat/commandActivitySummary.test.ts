import { describe, expect, it } from "vitest";
import { commandActivitySummary } from "./commandActivitySummary";
import type { WorkLogLiveActivity } from "../../workLog";

const activity = (state: WorkLogLiveActivity["state"]): WorkLogLiveActivity => ({
  state,
  label: state,
  lastActivityAt: "2026-09-05T12:00:00Z",
});

describe("CHIP Sx command summary precedence", () => {
  it("uses skill script copy in collapsed and background states while preserving expanded generic copy", () => {
    const cmd = "python3 /home/user/.codex/skills/pdf/scripts/render.py";
    expect(commandActivitySummary(cmd, activity("completed"), "2s", "en", false)).toBe(
      "Ran script render.py from PDF skill in 2s",
    );
    expect(commandActivitySummary(cmd, activity("completed"), "2s", "en", true)).toBe(
      "Ran command in 2s",
    );
    expect(
      commandActivitySummary(cmd, activity("running_tool"), "2s", "en", true, {
        isBackgroundTerminalRunning: true,
      }),
    ).toBe("Started background terminal running render.py from PDF skill");
    expect(
      commandActivitySummary(cmd, activity("completed"), "2s", "en", true, {
        isBackgroundTerminalFinished: true,
      }),
    ).toBe("Background terminal finished running render.py from PDF skill");
    expect(
      commandActivitySummary(cmd, activity("cancelled"), null, "en", true, {
        isBackgroundTerminalFinished: true,
      }),
    ).toBe("Background terminal stopped with script render.py from PDF skill");
    expect(
      commandActivitySummary("date -u", activity("completed"), null, "en", true, {
        isBackgroundTerminalFinished: true,
      }),
    ).toBe("Checked the current date and time");
  });
  it.each([false, true])("uses a generic running label (expanded=%s)", (expanded) => {
    expect(
      commandActivitySummary("python3 capture.py", activity("running_tool"), "18s", "en", expanded),
    ).toBe("Running command for 18s");
    expect(
      commandActivitySummary("python3 capture.py", activity("running_tool"), null, "en", expanded),
    ).toBe("Running command");
  });
  it.each([
    ["completed", false, "Ran printf ready in 2s"],
    ["completed", true, "Ran command in 2s"],
    ["cancelled", false, "Stopped printf ready after 2s"],
    ["cancelled", true, "Stopped command after 2s"],
    ["failed", true, "Ran command in 2s"],
  ] as const)("uses settlement and expansion: %s / %s", (state, expanded, expected) => {
    expect(commandActivitySummary("printf ready", activity(state), "2s", "en", expanded)).toBe(
      expected,
    );
  });
  it("classifies current date/time before generic commands without treating mutations as reads", () => {
    expect(
      commandActivitySummary(
        "/bin/bash -lc 'date -u \"+%Y %m\"'",
        activity("running_tool"),
        "1s",
        "en",
        true,
      ),
    ).toBe("Checking the current date and time for 1s");
    expect(commandActivitySummary("date -u", activity("cancelled"), null, "en", false)).toBe(
      "Stopped checking the current date and time",
    );
    for (const cmd of [
      "date --set tomorrow",
      "date && echo done",
      "date; echo done",
      "date '+unterminated",
    ]) {
      expect(commandActivitySummary(cmd, activity("running_tool"), null, "en", true)).toBe(
        "Running command",
      );
    }
  });
  it("uses the observed visualization classifier only for running/successful commands", () => {
    const command = "mkdir -p /tmp/visualizations";
    expect(commandActivitySummary(command, activity("running_tool"), "1s", "en", true)).toBe(
      "Creating visualization",
    );
    expect(commandActivitySummary(command, activity("completed"), "1s", "en", false)).toBe(
      "Created visualization",
    );
    expect(commandActivitySummary(command, activity("cancelled"), "1s", "en", true)).toBe(
      "Stopped command after 1s",
    );
    expect(commandActivitySummary(command, activity("failed"), "1s", "en", true)).toBe(
      "Ran command in 1s",
    );
  });

  it("emits CHIP auto-review-declined copy before generic settlement", () => {
    expect(
      commandActivitySummary("rm -rf /tmp/x", activity("cancelled"), null, "en", false, {
        wasDeclinedByAutoReview: true,
      }),
    ).toBe("Command declined by auto-review: rm -rf /tmp/x");
    expect(
      commandActivitySummary("rm -rf /tmp/x", activity("cancelled"), null, "en", true, {
        wasDeclinedByAutoReview: true,
      }),
    ).toBe("Command declined by auto-review");
    expect(
      commandActivitySummary("rm -rf /tmp/x", activity("cancelled"), null, "zh-CN", false, {
        wasDeclinedByAutoReview: true,
      }),
    ).toBe("命令已被自动审核拒绝：rm -rf /tmp/x");
  });

  it("emits background-terminal Sx only when flags are explicitly provided", () => {
    expect(
      commandActivitySummary("python3 scripts/run.py", activity("running_tool"), null, "en", true, {
        isBackgroundTerminalRunning: true,
      }),
    ).toBe("Started background terminal with python3 scripts/run.py");
    expect(
      commandActivitySummary("python3 scripts/run.py", activity("completed"), null, "en", false, {
        isBackgroundTerminalFinished: true,
      }),
    ).toBe("Ran python3 scripts/run.py");
    expect(
      commandActivitySummary("python3 scripts/run.py", activity("cancelled"), null, "en", false, {
        isBackgroundTerminalFinished: true,
      }),
    ).toBe("Background terminal stopped with python3 scripts/run.py");
  });
});
