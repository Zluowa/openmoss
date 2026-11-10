import { describe, expect, it } from "vitest";

import { matchClaudeConfiguredModel } from "./claudeConfiguredModel.ts";
import {
  readCodexConfiguredModel,
  readCodexListedDefaultModel,
  withCodexDefaultModel,
} from "./codexDiscoveryCatalog.ts";
import { acpAgentModelListResult, readAcpAgentCurrentModel } from "./acp/AcpAgentSupport.ts";
import { ZCODE_ACP_AGENT_SPEC } from "./acp/AcpAgentSpec.ts";
import { readAcpCurrentModel } from "./acp/AcpConfigOptions.ts";
import { readCursorAcpDefaultModel } from "./acp/CursorAcpSupport.ts";
import { parseGrokCliModelList } from "./Layers/GrokAdapter.ts";

describe("each agent's own default model", () => {
  it("Gemini and Hermes: reads the native current model without guessing from catalog order", () => {
    expect(readAcpCurrentModel({ models: { currentModelId: " custom/router " } })).toBe(
      "custom/router",
    );
    expect(
      readAcpCurrentModel({ models: { availableModels: [{ modelId: "first" }] } }),
    ).toBeUndefined();
    expect(
      readAcpCurrentModel({
        configOptions: [{ id: "model", type: "select", currentValue: "preferred" }],
        models: { currentModelId: "legacy" },
      }),
    ).toBe("preferred");
    expect(readAcpCurrentModel(null)).toBeUndefined();
    expect(readAcpCurrentModel({ models: { currentModelId: 1 } })).toBeUndefined();
  });

  it("Cursor: maps native parameterized selections to the advertised model", () => {
    const models = [
      { slug: "preferred", name: "Preferred" },
      { slug: "other", name: "Other" },
    ];
    const setup = {
      configOptions: [{ id: "model", type: "select", currentValue: "preferred[reasoning=high]" }],
    };
    expect(readCursorAcpDefaultModel(setup, models)).toBe("preferred");
    expect(readCursorAcpDefaultModel(setup, [{ slug: "other", name: "Other" }])).toBeUndefined();
    expect(readCursorAcpDefaultModel({}, models)).toBeUndefined();
  });

  it("Grok: retains an explicit default even when it is not the first catalog model", () => {
    const result = parseGrokCliModelList(
      "Available models:\n  grok-4.3\n  grok-4.6\n\nDefault model: grok-4.6\n",
    );
    expect(result.defaultModel).toBe("grok-4.6");
    expect(
      parseGrokCliModelList("Available models:\n  grok-4.3\n  grok-4.6 (default)\n").defaultModel,
    ).toBe("grok-4.6");
    expect(parseGrokCliModelList("Available models:\n  grok-4.3\n").defaultModel).toBeUndefined();
    expect(parseGrokCliModelList("Default model: custom/model\n").defaultModel).toBe(
      "custom/model",
    );
  });

  it("Codex: config.toml (profile applied) wins over the catalog's default", () => {
    const listed = { data: [{ id: "gpt-5.5", isDefault: true }, { id: "gpt-5.6-sol" }] };
    expect(readCodexListedDefaultModel(listed)).toBe("gpt-5.5");
    expect(readCodexConfiguredModel({ config: { model: "gpt-5.6-sol" } })).toBe("gpt-5.6-sol");
    const models = [
      { slug: "gpt-5.5", name: "GPT-5.5" },
      { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ];
    expect(
      withCodexDefaultModel(models, { configuredModel: "gpt-5.6-sol", listedDefault: "gpt-5.5" }),
    ).toEqual({ models, defaultModel: "gpt-5.6-sol" });
    expect(withCodexDefaultModel(models, { listedDefault: "gpt-5.5" }).defaultModel).toBe(
      "gpt-5.5",
    );
    // A configured model the catalog hides still shows, first.
    const custom = withCodexDefaultModel(models, { configuredModel: "my-router/model" });
    expect(custom.defaultModel).toBe("my-router/model");
    expect(custom.models[0]).toEqual({ slug: "my-router/model", name: "my-router/model" });
  });

  it("Claude: settings.json `model` by alias or full id", () => {
    const models = [
      { slug: "default", name: "Default" },
      { slug: "opus", name: "Opus", resolvedModel: "claude-opus-4-8" },
    ];
    expect(matchClaudeConfiguredModel(models, "Opus")).toBe("opus");
    expect(matchClaudeConfiguredModel(models, "claude-opus-4-8")).toBe("opus");
    expect(matchClaudeConfiguredModel(models, "haiku")).toBeUndefined();
  });

  it("ACP agents: the model a fresh session starts on", () => {
    const setup = {
      sessionId: "s",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "glm-5.2",
          options: [
            { value: "glm-5.2", name: "GLM-5.2" },
            { value: "glm-5.2-air", name: "GLM-5.2 Air" },
          ],
        },
      ],
    } as unknown as Parameters<typeof readAcpAgentCurrentModel>[1];
    const current = readAcpAgentCurrentModel(ZCODE_ACP_AGENT_SPEC, setup);
    expect(current).toBe("glm-5.2");
    expect(
      acpAgentModelListResult(ZCODE_ACP_AGENT_SPEC, [{ slug: "glm-5.2", name: "GLM-5.2" }], current)
        .defaultModel,
    ).toBe("glm-5.2");
  });
});
