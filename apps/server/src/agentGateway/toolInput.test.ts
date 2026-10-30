import { describe, expect, it } from "vitest";
import { RETIRED_PROVIDER_KINDS, SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";
import {
  MODEL_SELECTION_INPUT_SCHEMA,
  PROVIDER_KINDS,
  parseProviderKind,
  readModelSelectionArg,
} from "./toolInput.ts";

describe("readModelSelectionArg", () => {
  it("advertises and accepts every supported adapter from the canonical registry", () => {
    expect(PROVIDER_KINDS).toEqual(SUPPORTED_PROVIDER_KINDS);
    expect(MODEL_SELECTION_INPUT_SCHEMA.properties.provider.enum).toEqual([
      ...SUPPORTED_PROVIDER_KINDS,
    ]);
    for (const provider of SUPPORTED_PROVIDER_KINDS)
      expect(parseProviderKind(provider)).toBe(provider);
    for (const provider of ["gemini", "hermes"] as const) {
      expect(
        readModelSelectionArg({ target: { provider, model: "fixture-model" } }, "target")?.provider,
      ).toBe(provider);
    }
  });

  it("rejects retired or unknown new-work targets instead of silently substituting a driver", () => {
    for (const provider of [...RETIRED_PROVIDER_KINDS, "unknown-acp"]) {
      expect(() => parseProviderKind(provider)).toThrow("Unknown provider");
      expect(() =>
        readModelSelectionArg({ target: { provider, model: "fixture-model" } }, "target"),
      ).toThrow("Unknown provider");
    }
  });
  it("decodes the advertised instance target with canonical option selections", () => {
    expect(
      readModelSelectionArg(
        {
          target: {
            instanceId: "claude_work",
            model: "claude-sonnet-5",
            options: { effort: "high" },
          },
        },
        "target",
      ),
    ).toEqual({
      provider: "claudeAgent",
      instanceId: "claude_work",
      model: "claude-sonnet-5",
      options: { effort: "high" },
    });
  });

  it("normalizes legacy provider and option records at the wire boundary", () => {
    expect(
      readModelSelectionArg(
        { target: { provider: "codex", model: "gpt-5.5", options: { reasoningEffort: "high" } } },
        "target",
      ),
    ).toEqual({
      provider: "codex",
      instanceId: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "high" },
    });
  });

  it("rejects a target that is not a model-selection record", () => {
    expect(() => readModelSelectionArg({ target: "gpt-5.5" }, "target")).toThrow(
      'Argument "target" must be an object.',
    );
  });
});
