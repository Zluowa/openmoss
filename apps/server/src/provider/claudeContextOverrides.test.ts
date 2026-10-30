import { describe, expect, it } from "vitest";
import {
  getModelCapabilities,
  normalizeClaudeModelOptions,
  resolveApiModelId,
} from "@synara/shared/model";
import {
  resolveSelectedClaudeAutoCompactWindow,
  resolveClaudeApiModelIdContextWindowMaxTokens,
} from "./claudeTokenUsage";

describe("Claude explicit compact overrides", () => {
  it.each(["claude-opus-4-6", "claude-sonnet-4-6", "claude-fable-5-1", "claude-sonnet-5"])(
    "preserves both explicit budgets on %s and can return to auto",
    (model) => {
      for (const [value, tokens] of [
        ["200k", 200_000],
        ["1m", 1_000_000],
      ] as const) {
        const options = normalizeClaudeModelOptions(model, { autoCompactWindow: value });
        expect(options?.autoCompactWindow).toBe(value);
        expect(resolveSelectedClaudeAutoCompactWindow(model, options?.autoCompactWindow)).toBe(
          tokens,
        );
      }
      expect(normalizeClaudeModelOptions(model, { autoCompactWindow: "auto" })).toBeUndefined();
      expect(resolveSelectedClaudeAutoCompactWindow(model, undefined)).toBeUndefined();
      expect(getModelCapabilities("claudeAgent", model).contextWindowTokens).toBe(1_000_000);
    },
  );
  it.each(["claude-opus-4-6", "claude-sonnet-4-6"])(
    "preserves the %s model id when a 1M auto-compact budget is requested",
    (model) => {
      const apiId = resolveApiModelId({
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model,
        options: { autoCompactWindow: "1m" },
      });
      expect(apiId).toBe(model);
      expect(resolveClaudeApiModelIdContextWindowMaxTokens(apiId)).toBe(200_000);
    },
  );
});
