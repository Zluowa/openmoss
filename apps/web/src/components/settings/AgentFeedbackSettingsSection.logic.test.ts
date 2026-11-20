import type { AgentFeedbackEntry } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { formatMossTranslation, translateMoss } from "~/localization";

import {
  agentFeedbackDraft,
  agentFeedbackReportId,
  sortAgentFeedback,
} from "./AgentFeedbackSettingsSection.logic";

const entry = (overrides: Partial<AgentFeedbackEntry> = {}): AgentFeedbackEntry =>
  ({
    id: "agent-feedback:00000000000000000000000000000000",
    severity: "friction",
    summary: "The error did not say which field was wrong",
    details: "Called moss_create_task without a title.",
    tool: "moss_create_task",
    proposedFix: "Name the missing field.",
    providers: ["codex"],
    occurrences: 3,
    firstReportedAt: "2026-11-18T00:00:00.000Z",
    lastReportedAt: "2026-11-18T01:00:00.000Z",
    threadIds: [],
    ...overrides,
  }) as AgentFeedbackEntry;

const draft = (value: AgentFeedbackEntry, locale: "en" | "zh-CN" = "en") =>
  agentFeedbackDraft(
    value,
    (key) => translateMoss(locale, key),
    (key, values) => formatMossTranslation(locale, key, values),
    locale,
  );

describe("agentFeedbackDraft", () => {
  it("fills the dialog with everything the agent reported", () => {
    const result = draft(entry());
    expect(result.category).toBe("bug");
    expect(result.details).toBe(
      [
        "The error did not say which field was wrong",
        "Called moss_create_task without a title.\nSuggestion: Name the missing field.",
        "From Codex · Slowed down · 3 times · moss_create_task",
      ].join("\n\n"),
    );
  });

  it("files an idea as an idea and leaves out what the agent did not give", () => {
    const result = draft(
      entry({ severity: "idea", tool: null, details: null, proposedFix: null, occurrences: 1 }),
    );
    expect(result.category).toBe("idea");
    expect(result.details).toBe("The error did not say which field was wrong\n\nFrom Codex · Idea");
  });

  it("lists the agents the way the person's language does", () => {
    const both = entry({ providers: ["codex", "claudeAgent"] });
    expect(draft(both).details).toContain("From Codex and Claude");
    expect(draft(both, "zh-CN").details).toContain("来自 Codex和Claude");
  });

  it("writes its own labels in the person's language", () => {
    const result = draft(entry(), "zh-CN");
    expect(result.details).toContain("来自 Codex · 不顺 · 3 次 · moss_create_task");
    expect(result.details).toContain("建议：Name the missing field.");
  });
});

describe("sortAgentFeedback", () => {
  it("puts blockers first, then the most reported, then the newest", () => {
    const sorted = sortAgentFeedback([
      entry({ id: "agent-feedback:1" as never, severity: "idea", occurrences: 9 }),
      entry({ id: "agent-feedback:2" as never, severity: "friction", occurrences: 1 }),
      entry({ id: "agent-feedback:3" as never, severity: "friction", occurrences: 4 }),
      entry({
        id: "agent-feedback:4" as never,
        severity: "friction",
        occurrences: 4,
        lastReportedAt: "2026-11-19T00:00:00.000Z",
      }),
      entry({ id: "agent-feedback:5" as never, severity: "blocker", occurrences: 1 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual([
      "agent-feedback:5",
      "agent-feedback:4",
      "agent-feedback:3",
      "agent-feedback:2",
      "agent-feedback:1",
    ]);
  });
});

describe("agentFeedbackReportId", () => {
  it("gives one note one report ID in the outbox's form", () => {
    const id = agentFeedbackReportId(
      entry({ id: "agent-feedback:0123456789abcdef0123456789abcdef" as never }),
    );
    expect(id).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
