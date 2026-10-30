import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../workLog";
import {
  isReasoningPresentationActive,
  isReasoningPresentationEntry,
  reasoningEntryContent,
  resolveReasoningBody,
  stripActiveReasoningHeading,
  stripSettledReasoningHeading,
} from "./reasoningPresentation";

function entry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "reasoning-1",
    createdAt: "2026-08-28T00:00:00.000Z",
    label: "Reasoning trace",
    tone: "tool",
    ...overrides,
  };
}

describe("reasoning heading presentation", () => {
  it.each([
    ["**Plan the change**\\n\\nInspect the adapter", "Inspect the adapter"],
    ["  **Plan the change**\\nbody", "body"],
    ["plain reasoning text", "plain reasoning text"],
    ["**unfinished heading", ""],
    ["**\\nnot a heading", ""],
  ])("matches active Codex heading handling for %j", (input, expected) => {
    expect(stripActiveReasoningHeading(input.replaceAll("\\n", "\n"))).toBe(expected);
  });

  it.each([
    ["**Plan the change**\\n\\nInspect the adapter", "Inspect the adapter"],
    ["# Plan the change\\n\\nInspect the adapter", "Inspect the adapter"],
    ["### Plan the change\\nInspect the adapter", "Inspect the adapter"],
    ["__Plan the change__\\nInspect the adapter", "Inspect the adapter"],
    ["**unfinished heading", "**unfinished heading"],
    ["<!-- comment -->\\n**Plan**\\nbody", "<!-- comment -->\\n**Plan**\\nbody"],
    ["```regex\\n**not a heading**\\n```", "```regex\\n**not a heading**\\n```"],
    ["# [a-z]+\\nbody", "# [a-z]+\\nbody"],
  ])("matches settled safe heading stripping for %j", (input, expected) => {
    expect(stripSettledReasoningHeading(input.replaceAll("\\n", "\n"))).toBe(
      expected.replaceAll("\\n", "\n"),
    );
  });

  it("removes one heading only and preserves later markdown", () => {
    expect(stripSettledReasoningHeading("**first**\n\n**second**\nbody")).toBe("**second**\nbody");
  });
});

describe("reasoning entry lifecycle", () => {
  it("recognizes canonical and legacy reasoning labels only", () => {
    expect(isReasoningPresentationEntry(entry())).toBe(true);
    expect(isReasoningPresentationEntry(entry({ label: "Reasoning effort" }))).toBe(false);
    expect(isReasoningPresentationEntry(entry({ label: "Reasoning trace" }))).toBe(true);
  });

  it("uses only provider body candidates", () => {
    expect(reasoningEntryContent(entry({ detail: "  detail  ", preview: "preview" }))).toBe(
      "detail",
    );
    expect(reasoningEntryContent(entry({ detail: "", preview: " preview " }))).toBe("preview");
    expect(reasoningEntryContent(entry())).toBe("");
  });

  it("treats in-progress live activity as active and terminal activity as settled", () => {
    expect(
      isReasoningPresentationActive(
        entry({ liveActivity: { state: "thinking", label: "Thinking", lastActivityAt: "now" } }),
      ),
    ).toBe(true);
    expect(
      isReasoningPresentationActive(
        entry({ liveActivity: { state: "completed", label: "Thought", lastActivityAt: "now" } }),
      ),
    ).toBe(false);
    expect(isReasoningPresentationActive(entry({ label: "Ran command" }))).toBe(false);
  });

  it("selects active versus settled body rules", () => {
    const content = "**Heading**\n\nBody";
    expect(resolveReasoningBody(content, "active")).toBe("Body");
    expect(resolveReasoningBody(content, "settled")).toBe("Body");
  });
});
