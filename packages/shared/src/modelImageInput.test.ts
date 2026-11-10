import { describe, expect, it } from "vitest";

import { modelImageInputSupport } from "./modelImageInput";

describe("modelImageInputSupport", () => {
  it("answers from the Moss catalog for Moss accounts, however the agent spells the model", () => {
    expect(modelImageInputSupport({ instanceId: "codex_moss", model: "glm-5.3-flash" })).toBe(
      "supported",
    );
    expect(modelImageInputSupport({ instanceId: "pi_moss", model: "moss/deepseek-v4-flash" })).toBe(
      "unsupported",
    );
    expect(modelImageInputSupport({ instanceId: "claude_moss", model: "deepseek-v4-pro" })).toBe(
      "unsupported",
    );
  });

  it("does not guess for the person's own accounts or unknown models", () => {
    expect(modelImageInputSupport({ instanceId: "pi", model: "deepseek/deepseek-flash" })).toBe(
      "unknown",
    );
    expect(modelImageInputSupport({ instanceId: "codex_moss", model: "not-a-moss-model" })).toBe(
      "unknown",
    );
    expect(modelImageInputSupport({ instanceId: undefined, model: "glm-5.3-flash" })).toBe(
      "unknown",
    );
  });
});
