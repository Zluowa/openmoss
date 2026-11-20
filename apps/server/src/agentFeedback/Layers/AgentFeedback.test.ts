import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_FEEDBACK_MAX_THREADS, ThreadId } from "@moss/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentFeedbackReportInput } from "../Services/AgentFeedback.ts";
import { agentFeedbackFingerprint, makeAgentFeedback } from "./AgentFeedback.ts";

let directory: string;
let filePath: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-agent-feedback-"));
  filePath = path.join(directory, "agent-feedback.json");
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const report = (overrides: Partial<AgentFeedbackReportInput> = {}): AgentFeedbackReportInput => ({
  severity: "friction",
  summary: "The error did not say which field was wrong",
  details: null,
  tool: "moss_create_task",
  proposedFix: null,
  provider: "codex",
  threadId: ThreadId.makeUnsafe("thread-1"),
  ...overrides,
});

let clock = 0;
const open = () =>
  Effect.runPromise(
    makeAgentFeedback({ filePath, now: () => new Date(Date.UTC(2026, 10, 18, 0, 0, clock++)) }),
  );
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("agent feedback store", () => {
  it("counts the same tool and summary as one entry, newest thread first", async () => {
    const store = await open();
    await run(store.record(report()));
    const second = await run(
      store.record(
        report({
          summary: "the error did NOT say which field was wrong!",
          severity: "blocker",
          threadId: ThreadId.makeUnsafe("thread-2"),
          provider: "claudeAgent",
          proposedFix: "Name the field.",
        }),
      ),
    );
    expect(second.occurrences).toBe(2);
    const entries = await run(store.list);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      occurrences: 2,
      severity: "blocker",
      proposedFix: "Name the field.",
      threadIds: ["thread-2", "thread-1"],
      providers: ["claudeAgent", "codex"],
    });
    const [entry] = entries;
    expect(entry && entry.lastReportedAt > entry.firstReportedAt).toBe(true);
  });

  it("keeps a lower severity from lowering an entry", async () => {
    const store = await open();
    await run(store.record(report({ severity: "blocker" })));
    await run(store.record(report({ severity: "idea" })));
    expect((await run(store.list))[0]?.severity).toBe("blocker");
  });

  it("keeps different tools apart and lists the latest report first", async () => {
    const store = await open();
    await run(store.record(report({ tool: "moss_create_task" })));
    await run(store.record(report({ tool: "moss_update_todo" })));
    const entries = await run(store.list);
    expect(entries.map((entry) => entry.tool)).toEqual(["moss_update_todo", "moss_create_task"]);
  });

  it("remembers at most a few chats per entry", async () => {
    const store = await open();
    for (let index = 0; index < AGENT_FEEDBACK_MAX_THREADS + 2; index++)
      await run(store.record(report({ threadId: ThreadId.makeUnsafe(`thread-${index}`) })));
    expect((await run(store.list))[0]?.threadIds).toHaveLength(AGENT_FEEDBACK_MAX_THREADS);
  });

  it("survives a restart and forgets a dismissed entry", async () => {
    const first = await open();
    const { id } = await run(first.record(report()));
    const reopened = await open();
    expect((await run(reopened.list)).map((entry) => entry.id)).toEqual([id]);
    await run(reopened.dismiss(id));
    expect(await run((await open()).list)).toEqual([]);
  });

  it("redacts secrets and paths before anything is kept", async () => {
    const store = await open();
    const syntheticKey = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    await run(
      store.record(
        report({
          details: `Called with token ${syntheticKey} in /Users/alex/work/app`,
        }),
      ),
    );
    const saved = await fs.readFile(filePath, "utf8");
    expect(saved).not.toContain(syntheticKey);
    expect(saved).not.toContain("/Users/alex");
  });

  it("trims whitespace around summary so reload decoding never fails", async () => {
    const first = await open();
    await run(first.record(report({ summary: "  leading and trailing whitespace  " })));
    const reopened = await open();
    const entries = await run(reopened.list);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toBe("leading and trailing whitespace");
  });

  it("keeps valid entries when one stored entry has an unknown schema version", async () => {
    const first = await open();
    const { id } = await run(first.record(report({ summary: "Valid note kept across upgrade" })));
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown[];
    raw.push({ id: "agent-feedback:ffffffffffffffffffffffffffffffff", severity: "future-kind" });
    await fs.writeFile(filePath, JSON.stringify(raw));
    const reopened = await open();
    expect((await run(reopened.list)).map((entry) => entry.id)).toEqual([id]);
  });

  it("starts empty from an unreadable file instead of failing", async () => {
    await fs.writeFile(filePath, "{not json");
    const store = await open();
    expect(await run(store.list)).toEqual([]);
    await run(store.record(report()));
    expect(await run(store.list)).toHaveLength(1);
  });

  it("matches summaries that differ only in case, spacing and punctuation", () => {
    expect(agentFeedbackFingerprint("Tool", "A  b, c.")).toBe(
      agentFeedbackFingerprint("tool", "a b c"),
    );
    expect(agentFeedbackFingerprint("tool", "a b c")).not.toBe(
      agentFeedbackFingerprint(null, "a b c"),
    );
  });
});
