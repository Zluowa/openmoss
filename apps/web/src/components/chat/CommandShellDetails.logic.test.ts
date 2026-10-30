import { describe, expect, it } from "vitest";

import type { WorkLogLiveActivity } from "../../workLog";
import {
  formatShellCommandDisplay,
  formatCommandShellCopyPayload,
  normalizeShellCommand,
  resolveCommandShellCopyPayloads,
  normalizeTerminalOutputForRender,
  parseTerminalTextSegments,
  resolveCommandShellOutputText,
  resolveCommandShellStatus,
} from "./CommandShellDetails.logic";

function activity(state: WorkLogLiveActivity["state"]): WorkLogLiveActivity {
  return {
    state,
    label: state,
    lastActivityAt: "2026-03-17T19:12:29.000Z",
  };
}

describe("CommandShellDetails logic", () => {
  it("treats whitespace-only stdout as empty in both phases", () => {
    expect(
      resolveCommandShellOutputText({ stdout: "\n \n" }, activity("running_tool"), "No output"),
    ).toBe("");
    expect(
      resolveCommandShellOutputText({ stdout: "\n \n" }, activity("completed"), "No output"),
    ).toBe("No output");
  });
  it.each(["starting", "thinking", "running_tool", "waiting", "streaming"] as const)(
    "keeps %s empty output as a footer spacer",
    (state) => {
      expect(resolveCommandShellOutputText(undefined, activity(state), "No output")).toBe("");
      expect(resolveCommandShellStatus(activity(state), undefined)).toEqual({ kind: "running" });
    },
  );

  it("resolves success from exit code zero", () => {
    expect(resolveCommandShellStatus(activity("completed"), { exitCode: 0 })).toEqual({
      kind: "success",
    });
  });

  it("resolves nonzero and missing exit codes without inventing a value", () => {
    expect(resolveCommandShellStatus(activity("failed"), { exitCode: 2 })).toEqual({
      kind: "exit-code",
      exitCode: 2,
    });
    expect(resolveCommandShellStatus(activity("failed"), undefined)).toEqual({
      kind: "exit-code",
      exitCode: undefined,
    });
  });

  it("lets cancellation win over a zero exit code", () => {
    expect(resolveCommandShellStatus(activity("cancelled"), { exitCode: 0 })).toEqual({
      kind: "stopped",
    });
  });

  it("shows localized empty output only after a command settles", () => {
    expect(resolveCommandShellOutputText({}, activity("completed"), "No output")).toBe("No output");
    expect(resolveCommandShellOutputText({}, undefined, "No output")).toBe("No output");
  });

  it("normalizes only the transport shell and removes an existing prompt", () => {
    expect(normalizeShellCommand(`/bin/zsh -lc 'rg -n "toolDetails" apps/web/src'`)).toBe(
      `rg -n "toolDetails" apps/web/src`,
    );
    expect(normalizeShellCommand(`bash -lc ''`)).toBe("");
    expect(normalizeShellCommand(`zsh -lc ""`)).toBe("");
    expect(normalizeShellCommand(`bash -lc "echo \\"ready\\""`)).toBe(`echo "ready"`);
    expect(normalizeShellCommand("$ echo ready")).toBe("echo ready");
    expect(normalizeShellCommand(`printf '%s' "$HOME"`)).toBe(`printf '%s' "$HOME"`);
    expect(formatShellCommandDisplay("$ echo ready")).toBe("$ echo ready");
  });

  it("keeps command and output clipboard payloads exact and ordered", () => {
    expect(
      resolveCommandShellCopyPayloads(`/bin/bash -lc 'printf ready'`, {
        output: "first",
        stdout: "second\n",
        stderr: "third",
      }),
    ).toEqual({
      command: "printf ready",
      output: "first\n\nsecond\n\nthird",
    });
    expect(formatCommandShellCopyPayload("/bin/bash -lc 'printf ready'", "first\nsecond")).toBe(
      "$ /bin/bash -lc 'printf ready'\nfirst\nsecond",
    );
    expect(formatCommandShellCopyPayload("", "output only")).toBe("output only");
    expect(formatCommandShellCopyPayload("", "")).toBe("");
  });

  it("normalizes carriage-return progress output before rendering", () => {
    expect(normalizeTerminalOutputForRender("start\rdone\nkeep")).toBe("donet\nkeep");
    expect(normalizeTerminalOutputForRender("line\b\bX")).toBe("liX");
    expect(normalizeTerminalOutputForRender("\u001b[31mabc\rxy")).toBe("\u001b[31mxy\u001b[31mc");
    expect(normalizeTerminalOutputForRender("abc\r\u001b[32mxy")).toBe("\u001b[32mxy\u001b[0mc");
    expect(normalizeTerminalOutputForRender("abc\r\u001b[2Kdone")).toBe("\u001b[2Kdone");
  });

  it("parses ANSI text into styled segments", () => {
    expect(parseTerminalTextSegments("\u001b[31mred\u001b[0m plain")).toEqual([
      { text: "red", foreground: "ansi-red" },
      { text: " plain" },
    ]);
  });

  it("supports inverse, 256-color, and truecolor ANSI sequences like Codex", () => {
    expect(parseTerminalTextSegments("\u001b[7mrev\u001b[0m")).toEqual([
      {
        text: "rev",
        foreground: "ansi-black",
        background: "ansi-white",
      },
    ]);

    expect(parseTerminalTextSegments("\u001b[38;5;196midx\u001b[0m")).toEqual([
      { text: "idx", foreground: "ansi-palette-196" },
    ]);

    expect(parseTerminalTextSegments("\u001b[48;2;12;34;56mhi\u001b[0m")).toEqual([
      { text: "hi", background: "ansi-truecolor" },
    ]);

    expect(parseTerminalTextSegments("\u001b[1;4mboth\u001b[24m bold\u001b[22m plain")).toEqual([
      {
        text: "both",
        decoration: "underline",
        decorations: ["bold", "underline"],
      },
      { text: " bold", decoration: "bold", decorations: ["bold"] },
      { text: " plain" },
    ]);

    expect(parseTerminalTextSegments("\u001b[5mblink\u001b[25m plain")).toEqual([
      { text: "blink", decoration: "blink", decorations: ["blink"] },
      { text: " plain" },
    ]);
  });
});
