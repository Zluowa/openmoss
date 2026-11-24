import { describe, expect, it } from "vitest";

import {
  deriveToolFailureSummary,
  deriveWorkLogToolDetails,
  parseWorkLogMcpToolResult,
  patchFromFileChangeActivities,
  pathInside,
  splitToolDiffByFile,
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

describe("patchFromFileChangeActivities (WALK-6 H-6)", () => {
  // The walk's apply_patch record (WALK-7 state DB): started and completed, absolute Windows path.
  const record = (id: string, status: string) => ({
    id,
    turnId: "turn-1",
    payload: {
      itemType: "file_change",
      status,
      data: {
        item: {
          type: "fileChange",
          id: "call_6",
          changes: [
            {
              path: String.raw`D:\walk\profile\code\index.js`,
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1,3 @@\n export const add = (a, b) => a + b;\n+export const sub = (a, b) => a - b;\n+export const mul = (a, b) => a * b;\n",
            },
          ],
        },
      },
    },
  });

  it("builds one patch per change item, named inside the project folder", () => {
    const patch = patchFromFileChangeActivities(
      [record("a1", "inProgress"), record("a2", "completed")],
      "turn-1",
      "d:/walk/profile/code",
    );
    expect(patch).toBe(
      "diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1,3 @@\n export const add = (a, b) => a + b;\n+export const sub = (a, b) => a - b;\n+export const mul = (a, b) => a * b;\n",
    );
  });

  it("keeps other turns and other activities out", () => {
    expect(patchFromFileChangeActivities([record("a1", "completed")], "turn-2")).toBeUndefined();
    expect(
      patchFromFileChangeActivities(
        [
          {
            id: "x",
            turnId: "turn-1",
            payload: { itemType: "command_execution", data: { diff: "x" } },
          },
        ],
        null,
      ),
    ).toBeUndefined();
  });
});

describe("splitToolDiffByFile (walk N11-3)", () => {
  it("keeps each file's path and its hunks' lines, without the diff's own header lines", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "--- a removed line that starts with dashes",
      "+++ an added line that starts with pluses",
      "@@ -9 +9 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "diff --git a/b.md b/b.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    expect(splitToolDiffByFile(diff)).toEqual([
      {
        path: "src/a.ts",
        hunks: [
          [
            " keep",
            "--- a removed line that starts with dashes",
            "+++ an added line that starts with pluses",
          ],
          ["-old", "+new"],
        ],
      },
      { path: "b.md", hunks: [["+hello"]] },
    ]);
  });

  it("shows bare hunk lines as they are", () => {
    expect(splitToolDiffByFile("@@ -1 +1 @@\n-const a = 1;\n+const a = 2;")).toEqual([
      { path: null, hunks: [["-const a = 1;", "+const a = 2;"]] },
    ]);
  });

  // #967 review: Codex deletes one file and changes another in the same edit (absolute paths).
  const codexRoot = String.raw`D:\walk\profile\code`;
  const deleteThenUpdate = {
    itemType: "file_change",
    status: "completed",
    data: {
      item: {
        type: "fileChange",
        id: "call_7",
        changes: [
          { path: String.raw`${codexRoot}\gone.txt`, kind: { type: "delete" }, diff: "a\nb\nc\n" },
          {
            path: String.raw`${codexRoot}\index.js`,
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1,3 @@\n export const add = 1;\n+export const sub = 2;\n+export const mul = 3;\n",
          },
        ],
      },
    },
  };

  it("names each file of a Codex edit that deletes one file and changes another", () => {
    const details = deriveWorkLogToolDetails({
      label: "File change",
      itemType: "file_change",
      payload: deleteThenUpdate,
    });
    const files = splitToolDiffByFile(details?.diff ?? "");
    expect(
      files.map((file) => ({
        path: file.path && pathInside(file.path, codexRoot),
        hunks: file.hunks,
      })),
    ).toEqual([
      { path: "gone.txt", hunks: [["-a", "-b", "-c"]] },
      {
        path: "index.js",
        hunks: [[" export const add = 1;", "+export const sub = 2;", "+export const mul = 3;"]],
      },
    ]);
    const shownLines = files.flatMap((file) => file.hunks.flat());
    expect(shownLines.filter((line) => /^(?:diff --git |--- |\+\+\+ |@@ )/u.test(line))).toEqual(
      [],
    );
  });

  it("writes a Codex delete as its old lines removed, named inside the project folder", () => {
    const patch = patchFromFileChangeActivities(
      [{ id: "a1", turnId: "turn-1", payload: deleteThenUpdate }],
      "turn-1",
      codexRoot,
    );
    expect(patch).toBe(
      [
        "diff --git a/gone.txt b/gone.txt",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-a",
        "-b",
        "-c",
        "diff --git a/index.js b/index.js",
        "--- a/index.js",
        "+++ b/index.js",
        "@@ -1 +1,3 @@",
        " export const add = 1;",
        "+export const sub = 2;",
        "+export const mul = 3;",
        "",
      ].join("\n"),
    );
  });

  it("starts the next file at its diff --git line even when a hunk's counts run past it", () => {
    const diff = [
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -0,0 +1,5 @@",
      "-a",
      "diff --git a/index.js b/index.js",
      "--- a/index.js",
      "+++ b/index.js",
      "@@ -1 +1,2 @@",
      " keep",
      "+added",
    ].join("\n");
    expect(splitToolDiffByFile(diff)).toEqual([
      { path: "gone.txt", hunks: [["-a"]] },
      { path: "index.js", hunks: [[" keep", "+added"]] },
    ]);
  });
});
