import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "~/workLog";

import {
  SLOW_PROVIDER_START_NOTICE_MS,
  startingProviderName,
  thinkingStatusKey,
  workingMarkSignal,
  workingStatusKey,
} from "./workingStatus";

describe("thinkingStatusKey", () => {
  it("steps the words up at 15, 30, 45 and 60 seconds", () => {
    expect(thinkingStatusKey(0)).toBe("transcript.working.thinking");
    expect(thinkingStatusKey(14.9)).toBe("transcript.working.thinking");
    expect(thinkingStatusKey(15)).toBe("transcript.working.stillThinking");
    expect(thinkingStatusKey(30)).toBe("transcript.working.thinkingMore");
    expect(thinkingStatusKey(45)).toBe("transcript.working.thinkingSomeMore");
    expect(thinkingStatusKey(60)).toBe("transcript.working.almostDone");
    expect(thinkingStatusKey(600)).toBe("transcript.working.almostDone");
  });
});

describe("workingStatusKey", () => {
  it("rewords thinking and sending, and leaves provider lines alone", () => {
    expect(workingStatusKey("Thinking", 20)).toBe("transcript.working.stillThinking");
    expect(workingStatusKey("Loading", 0)).toBe("transcript.working.sending");
    expect(workingStatusKey("Starting Codex…", 0)).toBeNull();
    expect(workingStatusKey("Retrying: connection lost (1/5)", 0)).toBeNull();
  });
});

describe("workingMarkSignal", () => {
  const message = (role: "user" | "assistant", text: string, streaming = false) =>
    ({
      id: `${role}-${text}`,
      kind: "message",
      createdAt: "2026-11-12T00:00:00.000Z",
      message: { id: text, role, text, streaming },
    }) as unknown as TimelineEntry;
  const tool = (toolStatus: "running" | "completed") =>
    ({
      id: `tool-${toolStatus}`,
      kind: "work",
      createdAt: "2026-11-12T00:00:00.000Z",
      entry: { toolStatus },
    }) as unknown as TimelineEntry;
  const signal = (
    label: string,
    entries: TimelineEntry[] = [],
    flags: { awaitingUser?: boolean; finished?: boolean } = {},
  ) =>
    workingMarkSignal({
      label,
      entries,
      awaitingUser: flags.awaitingUser === true,
      finished: flags.finished === true,
    });

  it("reads the label when the turn has not reached the agent", () => {
    expect(signal("Loading").activity).toBe("sending");
    expect(signal("Starting Codex…").activity).toBe("sending");
    expect(signal("Checking message delivery…").activity).toBe("sending");
    expect(signal("Retrying: connection lost (1/5)").activity).toBe("stalled");
  });

  it("reads the newest entry of a live turn", () => {
    const ask = message("user", "hi");
    expect(signal("Thinking", [ask]).activity).toBe("thinking");
    expect(signal("Thinking", [ask, message("assistant", "Hel", true)]).activity).toBe("replying");
    expect(signal("Thinking", [ask, message("assistant", "Hello")]).activity).toBe("thinking");
    expect(signal("Thinking", [ask, tool("running")]).activity).toBe("working");
    expect(signal("Thinking", [ask, tool("completed")]).activity).toBe("thinking");
  });

  it("lets a finished turn and a pending question override everything else", () => {
    const live = [message("user", "hi"), message("assistant", "Hel", true)];
    expect(signal("Thinking", live, { awaitingUser: true }).activity).toBe("waiting");
    expect(signal("Thinking", live, { awaitingUser: true, finished: true }).activity).toBe("done");
  });

  it("counts streamed characters and new entries of the live turn only", () => {
    const earlier = [message("user", "old"), message("assistant", "a long settled answer")];
    const ask = message("user", "hi");
    const start = signal("Thinking", [...earlier, ask]).progress;
    const typed = signal("Thinking", [...earlier, ask, message("assistant", "Hel", true)]).progress;
    const more = signal("Thinking", [
      ...earlier,
      ask,
      message("assistant", "Hello", true),
    ]).progress;
    expect(start).toBe(0);
    expect(typed).toBe(4);
    expect(more - typed).toBe(2);
  });
});

describe("startingProviderName", () => {
  it("reads the provider from a start line and nothing else", () => {
    expect(startingProviderName("Starting Codex…")).toBe("Codex");
    expect(startingProviderName("Starting Claude Code…")).toBe("Claude Code");
    expect(startingProviderName("Thinking")).toBeNull();
    expect(startingProviderName("Retrying: connection lost (1/5)")).toBeNull();
    expect(workingStatusKey("Starting Codex…", 30)).toBeNull();
  });

  it("calls a start slow within seconds, well before the start deadline", () => {
    expect(SLOW_PROVIDER_START_NOTICE_MS).toBeLessThanOrEqual(10_000);
  });
});
