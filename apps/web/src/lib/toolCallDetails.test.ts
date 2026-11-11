import { describe, expect, it } from "vitest";

import {
  deriveToolFailureSummary,
  deriveWorkLogToolDetails,
  parseWorkLogMcpToolResult,
} from "./toolCallDetails";

describe("deriveToolFailureSummary", () => {
  it("reads Claude's leading exit code and skips it for the excerpt", () => {
    expect(
      deriveToolFailureSummary({
        kind: "command",
        title: "Command run",
        output: {
          output:
            "Exit code 2\nugrep: warning: missing.txt: No such file or directory\n1:def add(a, b):",
        },
      }),
    ).toEqual({
      exitCode: 2,
      excerpt: "ugrep: warning: missing.txt: No such file or directory",
    });
  });

  it("prefers a structured exit code and stderr", () => {
    expect(
      deriveToolFailureSummary({
        kind: "command",
        title: "Command run",
        output: { stdout: "partial", stderr: "\nzsh: command not found: rg\n", exitCode: 127 },
      }),
    ).toEqual({ exitCode: 127, excerpt: "zsh: command not found: rg" });
  });

  it("reports nothing when the call carried no output", () => {
    expect(deriveToolFailureSummary(undefined)).toEqual({ exitCode: null, excerpt: null });
  });
});

describe("tool output exit-code suffixes", () => {
  it("preserves a large whitespace run inside raw output", () => {
    const stdout = `start${" ".repeat(23_980)}end`;
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output).toEqual({ stdout });
  });

  it.each([
    ["  output\n", "  output\n", undefined],
    ["  output\n <exited with exit code 2>\n", "  output", 2],
    ["\toutput\r\n<EXITED WITH EXIT CODE 000>\t", "\toutput", 0],
    ["<exited with exit code 1>", undefined, 1],
    ["<exited with exit code -1>", "<exited with exit code -1>", undefined],
    ["<exited with exit code 1> later", "<exited with exit code 1> later", undefined],
    ["<exited with exit code 1>\n<exited with exit code 2>", "<exited with exit code 1>", 2],
    ["\n\t", undefined, undefined],
  ])("preserves raw stdout and parses only the final suffix: %j", (stdout, output, exitCode) => {
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      detail: stdout,
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output?.stdout).toBe(output);
    expect(details?.output?.exitCode).toBe(exitCode);
  });
});

describe("parseWorkLogMcpToolResult widget binding", () => {
  const projection = (app: Record<string, unknown>) => ({
    data: {
      kind: "codex.mcp_tool_call",
      version: 1,
      callId: "call-1",
      server: "codex_apps",
      tool: "open_issue",
      status: "completed",
      arguments: {},
      result: { content: [] },
      truncation: { truncated: false, deferredBinary: false },
      app,
    },
  });

  it("fills a pre-binding Codex descriptor from the projection", () => {
    const parsed = parseWorkLogMcpToolResult(
      "tool.completed",
      projection({
        resourceUri: "ui://linear/issue",
        source: "appContext",
        connectorId: "linear",
        appName: "Linear",
      }),
      "mcp_tool_call",
    );
    expect(parsed?.app).toEqual({
      resourceUri: "ui://linear/issue",
      source: "appContext",
      connectorId: "linear",
      appName: "Linear",
      server: "codex_apps",
      serverKey: "codex_apps/linear",
      serverLabel: "Linear",
      toolName: "open_issue",
      isFirstParty: false,
      visibility: [],
    });
  });

  it("keeps the server's binding fields", () => {
    const binding = {
      resourceUri: "ui://fixture/widget.html",
      source: "toolDefinition",
      server: "fixture_connector",
      serverKey: "conn-1",
      serverLabel: "Fixture",
      toolName: "fixture_show_widget",
      toolTitle: "Fixture widget",
      connectorId: "conn-1",
      connectorUrl: "https://fixture.example/mcp",
      isFirstParty: false,
      visibility: ["model", "app"],
    };
    expect(
      parseWorkLogMcpToolResult("tool.completed", projection(binding), "mcp_tool_call")?.app,
    ).toEqual(binding);
  });
});
