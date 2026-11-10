import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPiModel,
  getPiSupportedThinkingOptions,
  makePiStoragePaths,
  mapPiMessageHistory,
  normalizePiTokenUsage,
  piToolTitle,
  toPiProviderModelDescriptor,
} from "./piProtocolMapping.ts";

describe("makePiStoragePaths", () => {
  const base = {
    stateDir: path.resolve("/moss/state"),
    homeDir: path.resolve("/home/person"),
  };

  it("leaves Pi's own default folders alone without an account boundary", () => {
    expect(makePiStoragePaths(base)).toEqual({});
    expect(makePiStoragePaths({ ...base, instanceId: "pi" })).toEqual({});
  });

  it("uses a configured agent dir for the default instance", () => {
    const agentDir = path.resolve("/custom/pi-agent");
    expect(makePiStoragePaths({ ...base, agentDir })).toEqual({ agentDir });
  });

  it("uses selected Pi roots and never falls back to the global session directory", () => {
    const agentDir = path.resolve("/selected/agent");
    const sessionDir = path.resolve("/selected/sessions");
    expect(
      makePiStoragePaths({
        ...base,
        instanceId: "pi_work",
        environment: { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir },
      }),
    ).toEqual({ agentDir, sessionDir });
  });

  it("derives persistent synthetic roots for nondefault instances", () => {
    const paths = makePiStoragePaths({ ...base, instanceId: "pi_work" });
    expect(paths.agentDir?.startsWith(base.stateDir)).toBe(true);
    expect(paths.agentDir?.endsWith(path.join(".pi", "agent"))).toBe(true);
    expect(paths.sessionDir).toBe(path.join(paths.agentDir!, "sessions"));
  });

  it("falls back to synthetic storage for relative configured agent dirs", () => {
    const paths = makePiStoragePaths({ ...base, instanceId: "pi_work", agentDir: "relative" });
    expect(paths.agentDir?.startsWith(base.stateDir)).toBe(true);
  });
});

describe("getPiSupportedThinkingOptions", () => {
  const levels = (model: Parameters<typeof getPiSupportedThinkingOptions>[0]) =>
    getPiSupportedThinkingOptions(model).map((option) => option.value);

  it("hides thinking controls for non-reasoning models", () => {
    expect(levels({ reasoning: false })).toEqual([]);
  });

  it("advertises xhigh and max only when the concrete Pi model supports them", () => {
    expect(levels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(
      levels({ reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }),
    ).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("preserves ladders that expose only low, high and max", () => {
    expect(
      levels({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, medium: null, low: "low", max: "max" },
      }),
    ).toEqual(["low", "high", "max"]);
  });
});

describe("toPiProviderModelDescriptor", () => {
  it("normalizes extension models and drops ones whose identity would not resolve", () => {
    expect(
      toPiProviderModelDescriptor({ provider: "moss", id: "glm-5.3-flash", name: " GLM " }),
    ).toEqual({
      slug: "moss/glm-5.3-flash",
      name: "GLM",
      upstreamProviderId: "moss",
      upstreamProviderName: "Moss",
    });
    expect(toPiProviderModelDescriptor({ provider: " openai", id: "gpt" })).toBeNull();
    expect(toPiProviderModelDescriptor({ provider: "openai", id: "" })).toBeNull();
    expect(
      toPiProviderModelDescriptor({ provider: "google-vertex", id: "m", reasoning: true }),
    ).toMatchObject({ upstreamProviderName: "Google Vertex", defaultReasoningEffort: "medium" });
  });
});

describe("findPiModel", () => {
  const models = [
    { provider: "openai", id: "gpt-5.5" },
    { provider: "openrouter", id: "openai/gpt-5.5" },
  ];
  it("resolves provider-qualified and bare slugs", () => {
    expect(findPiModel(models, "openai/gpt-5.5")).toEqual(models[0]);
    expect(findPiModel(models, "openrouter/openai/gpt-5.5")).toEqual(models[1]);
    expect(findPiModel(models, "openai:gpt-5.5")).toEqual(models[0]);
    expect(findPiModel(models, "gpt-5.5")).toEqual(models[0]);
    expect(findPiModel(models, "missing/model")).toBeUndefined();
  });
});

describe("mapPiMessageHistory", () => {
  it("rebuilds user, assistant, reasoning and tool items and skips system messages", () => {
    const items = mapPiMessageHistory([
      { role: "system", content: "", sections: {} },
      { role: "user", content: [{ type: "text", text: "Read it" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Plan" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: "body", isError: false },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ]);
    expect(items.map((item) => (item as { type: string }).type)).toEqual([
      "user_message",
      "reasoning",
      "tool_call",
      "tool_call",
      "assistant_message",
    ]);
    expect(items[3]).toMatchObject({ status: "completed", title: "read a.txt", output: "body" });
  });
});

describe("normalizePiTokenUsage", () => {
  it("prefers Pi's context usage over cumulative totals", () => {
    expect(
      normalizePiTokenUsage({
        tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, total: 130 },
        contextUsage: { tokens: 60, contextWindow: 1000, percent: 6 },
      }),
    ).toMatchObject({ usedTokens: 60, maxTokens: 1000, usedPercent: 6, totalProcessedTokens: 130 });
    expect(
      normalizePiTokenUsage({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBeUndefined();
  });
});

describe("piToolTitle", () => {
  it("shows commands and paths without terminal control sequences", () => {
    expect(piToolTitle("bash", { command: "\u001b[31mls\u001b[0m -la" })).toBe("ls -la");
    expect(piToolTitle("powershell", { command: "Get-ChildItem" })).toBe("Get-ChildItem");
    expect(piToolTitle("grep", { pattern: "TODO" })).toBe("grep TODO");
    expect(piToolTitle("custom", {})).toBe("custom");
  });
});
