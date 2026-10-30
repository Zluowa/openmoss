import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { mossLoopStatusExitCode, parseJsonLines, summarizeMossLoop } from "./moss-loop-status.ts";

describe("moss-loop-status", () => {
  it("keeps the reusable library free of CLI entrypoint side effects", () => {
    const librarySource = readFileSync(
      new URL("./lib/moss-loop-status.ts", import.meta.url),
      "utf8",
    );
    const cliSource = readFileSync(new URL("./moss-loop-status.ts", import.meta.url), "utf8");

    expect(librarySource).not.toContain("process.argv");
    expect(librarySource).not.toContain("pathToFileURL");
    expect(cliSource).toContain("import.meta.url === pathToFileURL(process.argv[1]).href");
    expect(cliSource).toContain("main().catch");
  });

  it("reconstructs status from events, tasks, and role files", () => {
    const status = summarizeMossLoop({
      mission: "# Moss Shell Mission\n\nBuild the control plane.",
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Architect",
          title: "Define contracts",
          evidence: ["packages/contracts/src/moss.ts"],
        },
        {
          taskId: "moss-task-2",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Run tests",
          evidence: [],
        },
      ],
      roleFiles: ["architect.md", "qa-gatekeeper.md"],
    });

    expect(status.missionTitle).toBe("Moss Shell Mission");
    expect(status.currentGoal).toBe("Build a Codex-like shell");
    expect(status.branch).toBe("moss/control-plane-v1");
    expect(status.roles).toEqual(["architect", "qa-gatekeeper"]);
    expect(status.taskCounts).toEqual({ active: 1, done: 1 });
    expect(status.releaseGate).toMatchObject({
      status: "fail",
      activeTaskIds: ["moss-task-1"],
      issueCount: 1,
    });
    expect(status.completedTasksMissingEvidence).toHaveLength(1);
    expect(status.ledgerIssues).toEqual([
      {
        code: "completed-task-missing-evidence",
        id: "moss-task-2",
        message: "Completed task moss-task-2 has no evidence.",
      },
    ]);
    expect(mossLoopStatusExitCode(status)).toBe(1);
  });

  it("sanitizes the legacy product name in current developer-facing status", () => {
    const legacyName = ["Syn", "ara"].join("");
    const status = summarizeMossLoop({
      mission: `# ${legacyName} Shell Mission\n`,
      events: [
        {
          eventId: "moss-event-legacy-brand",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: { goal: `Build the shell on ${legacyName}` },
        },
      ],
      tasks: [],
      roleFiles: [],
    });

    expect(status.missionTitle).toBe("Moss Shell Mission");
    expect(status.currentGoal).toBe("Build the shell on Moss");
  });

  it("fails the release gate for duplicate task and event ids", () => {
    const status = summarizeMossLoop({
      mission: "# Moss Shell Mission\n",
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
        {
          eventId: "moss-event-1",
          type: "moss.task.started",
          createdAt: "2026-07-01T00:01:00.000Z",
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Run tests",
          evidence: ["bun test"],
        },
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Reviewer",
          title: "Review tests",
          evidence: [],
        },
      ],
      roleFiles: [],
    });

    expect(status.duplicateEventIds).toEqual(["moss-event-1"]);
    expect(status.duplicateTaskIds).toEqual(["moss-task-1"]);
    expect(status.releaseGate.status).toBe("fail");
    expect(status.releaseGate.checks).toEqual([
      {
        id: "completed-task-evidence",
        issueCount: 0,
        status: "pass",
        summary: "Every completed task has at least one evidence reference.",
      },
      {
        id: "unique-task-ids",
        issueCount: 1,
        status: "fail",
        summary: "One or more task ids are duplicated.",
      },
      {
        id: "unique-event-ids",
        issueCount: 1,
        status: "fail",
        summary: "One or more event ids are duplicated.",
      },
    ]);
    expect(status.ledgerIssues).toEqual([
      {
        code: "duplicate-task-id",
        count: 2,
        id: "moss-task-1",
        message: "Task id moss-task-1 appears 2 times.",
      },
      {
        code: "duplicate-event-id",
        count: 2,
        id: "moss-event-1",
        message: "Event id moss-event-1 appears 2 times.",
      },
    ]);
    expect(mossLoopStatusExitCode(status)).toBe(1);
  });

  it("reports line numbers for invalid jsonl", () => {
    expect(() => parseJsonLines('{"ok":true}\nnot-json', ".moss/ledger/events.jsonl")).toThrow(
      ".moss/ledger/events.jsonl:2",
    );
  });
});
