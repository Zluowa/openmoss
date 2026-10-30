import { describe, expect, it } from "vitest";

import {
  appendComputerHistorySelectionContext,
  COMPUTER_HISTORY_SELECTION_CONTEXT,
  projectComputerHistoryMention,
} from "./computerHistoryMentionProjection.ts";
import {
  COMPUTER_HISTORY_MENTION_REFERENCE,
  COMPUTER_HISTORY_MENTION_TOKEN,
} from "@synara/shared/computerHistoryMention";

describe("Computer History mention projection", () => {
  it("removes only the exact token and keeps unrelated references for native dispatch", () => {
    const file = { name: "README.md", path: "/workspace/README.md" };
    const plugin = { name: "linear", path: "plugin://linear" };
    const result = projectComputerHistoryMention({
      text: `Review ${COMPUTER_HISTORY_MENTION_TOKEN} and ${COMPUTER_HISTORY_MENTION_TOKEN}-suffix`,
      mentions: [COMPUTER_HISTORY_MENTION_REFERENCE, file, plugin],
    });

    expect(result.selected).toBe(true);
    expect(result.text).toBe(`Review  and ${COMPUTER_HISTORY_MENTION_TOKEN}-suffix`);
    expect(result.mentions).toEqual([file, plugin]);
  });

  it("leaves input byte-identical when Computer History was not selected", () => {
    const input = {
      text: "Review @README.md",
      mentions: [{ name: "README.md", path: "/workspace/README.md" }],
    };
    expect(projectComputerHistoryMention(input)).toEqual({
      ...input,
      selected: false,
    });
  });

  it("adds private tool consultation guidance once without raw entries", () => {
    const first = appendComputerHistorySelectionContext({
      text: "Review this",
      selected: true,
    });
    const second = appendComputerHistorySelectionContext({
      text: first,
      selected: true,
    });

    expect(first).toContain(COMPUTER_HISTORY_SELECTION_CONTEXT);
    expect(first).toContain("history_status");
    expect(first).toContain("history_query");
    expect(first).not.toContain("events.jsonl");
    expect(second).toBe(first);
  });
});
