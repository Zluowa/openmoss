import { describe, expect, it } from "vitest";

import { thinkingStatusKey, workingStatusKey } from "./workingStatus";

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
