import { ThreadId } from "@synara/contracts";
import { MOSS_SESSION_START_EVENT, type MossHookRunSummary } from "@synara/shared/mossHooks";
import { describe, expect, it } from "vitest";

import {
  buildMossSessionStartHookOptions,
  toMossSessionStartHookLogPayload,
} from "./mossSessionStartHooks";

const threadId = ThreadId.makeUnsafe("thread-hooks-1");

describe("buildMossSessionStartHookOptions", () => {
  it("always fires the canonical MossSessionStart event with matching projectPath/cwd", () => {
    const options = buildMossSessionStartHookOptions({
      provider: "codex",
      threadId,
      runtimeMode: "full-access",
      resumed: false,
      cwd: "/tmp/project",
      launchPlanHash: "sha256:abc",
    });

    expect(options.event).toBe(MOSS_SESSION_START_EVENT);
    expect(options.event).toBe("MossSessionStart");
    expect(options.provider).toBe("codex");
    // Hooks must see the same `.moss` tree the launch-plan compiler read.
    expect(options.projectPath).toBe("/tmp/project");
    expect(options.cwd).toBe("/tmp/project");
  });

  it("falls back to process.cwd() exactly like the launch-plan compiler", () => {
    const options = buildMossSessionStartHookOptions({
      provider: "claudeAgent",
      threadId,
      runtimeMode: "approval-required",
      resumed: false,
      cwd: "  ",
    });

    expect(options.projectPath).toBe(process.cwd());
    expect(options.cwd).toBe(process.cwd());
  });

  it("carries only identifiers/hashes in the payload and marks resumed sessions", () => {
    const options = buildMossSessionStartHookOptions({
      provider: "claudeAgent",
      threadId,
      runtimeMode: "approval-required",
      resumed: true,
      cwd: "/tmp/project",
      launchPlanHash: "sha256:planhash",
    });

    expect(options.payload).toEqual({
      threadId: "thread-hooks-1",
      provider: "claudeAgent",
      runtimeMode: "approval-required",
      resumed: true,
      mossLaunchPlanHash: "sha256:planhash",
    });
  });

  it("drops the optional launch plan hash instead of null-padding it", () => {
    const options = buildMossSessionStartHookOptions({
      provider: "grok",
      threadId,
      runtimeMode: "full-access",
      resumed: false,
      cwd: "/tmp/project",
    });

    expect(options.payload).toBeDefined();
    expect("mossLaunchPlanHash" in (options.payload ?? {})).toBe(false);
  });
});

describe("toMossSessionStartHookLogPayload", () => {
  it("keeps counts, payloadHash, and redacted per-result output for the log", () => {
    const summary: MossHookRunSummary = {
      status: "passed",
      event: MOSS_SESSION_START_EVENT,
      provider: "codex",
      projectPath: "/tmp/project",
      matchedCount: 2,
      executedCount: 1,
      skippedCount: 1,
      failedCount: 0,
      timedOutCount: 0,
      payloadHash: "a".repeat(64),
      warnings: ["warned"],
      results: [
        {
          resourceId: "moss:hook:session-start",
          name: "session-start",
          event: MOSS_SESSION_START_EVENT,
          status: "passed",
          command: 'echo "moss:session-start sk-REDACTED"',
          commandHash: "b".repeat(64),
          exitCode: 0,
          elapsedMs: 12,
          stdout: "moss:session-start codex",
          stderr: "",
          timedOut: false,
        },
        {
          resourceId: "moss:hook:unreviewed",
          name: "unreviewed",
          event: MOSS_SESSION_START_EVENT,
          status: "skipped",
          elapsedMs: 0,
          error: "Hook is not trusted.",
        },
      ],
    };

    const payload = toMossSessionStartHookLogPayload(summary);

    expect(payload).toMatchObject({
      event: "MossSessionStart",
      provider: "codex",
      status: "passed",
      executedCount: 1,
      payloadHash: "a".repeat(64),
      warnings: ["warned"],
    });
    expect(payload.results[0]).toEqual({
      resourceId: "moss:hook:session-start",
      name: "session-start",
      status: "passed",
      commandHash: "b".repeat(64),
      exitCode: 0,
      elapsedMs: 12,
      stdout: "moss:session-start codex",
      timedOut: false,
    });
    expect(payload.results[1]).toEqual({
      resourceId: "moss:hook:unreviewed",
      name: "unreviewed",
      status: "skipped",
      elapsedMs: 0,
      error: "Hook is not trusted.",
    });
    // The raw (even redacted) command text stays out of the log payload.
    expect(JSON.stringify(payload)).not.toContain("echo ");
  });
});
