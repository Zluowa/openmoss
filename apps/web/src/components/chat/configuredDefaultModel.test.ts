import type { ProviderInstanceId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { deriveEffectiveComposerModelState } from "../../composerDraftModels";
import { buildModelSelection } from "../../providerModelOptions";
import { resolveDefaultRowModel } from "./ComposerModelPicker.logic";

const PI = "pi" as ProviderInstanceId;
const piModels = [
  { slug: "fakeprov/fake-model-a", name: "fake-model-a" },
  { slug: "fakeprov/fake-model-b", name: "fake-model-b" },
  { slug: "fakeprov/fake-model-c", name: "fake-model-c" },
];

function piState(draftModel?: string) {
  return deriveEffectiveComposerModelState({
    draft: draftModel
      ? {
          activeProvider: PI,
          modelSelectionByProvider: {
            [PI]: buildModelSelection("pi", draftModel, null, { instanceId: PI }),
          },
        }
      : null,
    selectedProvider: "pi",
    selectedProviderInstanceId: PI,
    threadModelSelection: null,
    projectModelSelection: null,
    discoveredDefaultModelSelection: buildModelSelection("pi", "fakeprov/fake-model-b", null, {
      instanceId: PI,
    }),
    customModelsByProvider: {},
    availableModelOptionsByProvider: { pi: piModels },
  });
}

describe("the account's own configured default model", () => {
  it("starts an untouched composer on it", () => {
    expect(piState().selectedModel).toBe("fakeprov/fake-model-b");
  });

  it("never overrides a model picked in Moss", () => {
    expect(piState("fakeprov/fake-model-c").selectedModel).toBe("fakeprov/fake-model-c");
  });

  it("is what Codex's Default row means", () => {
    const options = [
      { slug: "gpt-5.5", name: "GPT-5.5" },
      { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ];
    expect(
      resolveDefaultRowModel({ provider: "codex", options, configuredDefault: "gpt-5.6-sol" }),
    ).toBe("gpt-5.6-sol");
    // A configured model the list does not offer falls back to the built-in default.
    expect(
      resolveDefaultRowModel({ provider: "codex", options, configuredDefault: "gone-model" }),
    ).not.toBe("gone-model");
  });
});
