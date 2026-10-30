import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { deriveEffectiveComposerModelState } from "../../composerDraftModels";
import { buildModelSelection } from "../../providerModelOptions";
import { discoveredCodexDefault } from "./discoveredCodexDefault";
import { getComposerProviderState } from "./composerProviderRegistry";

const astra = (efforts = ["medium", "high", "xhigh", "ultra"]): ProviderModelDescriptor => ({
  slug: "gpt-6-astra",
  name: "GPT-6 Astra",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: efforts.map((value) => ({ value })),
});
const sol = { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
const models = [sol, astra()];
const preferred = buildModelSelection("codex", "gpt-6-astra", { reasoningEffort: "xhigh" });

function state(
  input: {
    draft?: ModelSelection;
    thread?: ModelSelection;
    project?: ModelSelection;
    discoveredDefault?: ModelSelection | null;
    availableModels?: ProviderModelDescriptor[];
  } = {},
) {
  return deriveEffectiveComposerModelState({
    draft: input.draft
      ? { activeProvider: "codex", modelSelectionByProvider: { codex: input.draft } }
      : null,
    selectedProvider: "codex",
    selectedProviderInstanceId: "codex",
    threadModelSelection: input.thread,
    projectModelSelection: input.project,
    discoveredDefaultModelSelection:
      input.discoveredDefault === undefined ? preferred : input.discoveredDefault,
    customModelsByProvider: {},
    availableModelOptionsByProvider: { codex: input.availableModels ?? models },
  });
}

describe("discovered personal Codex default", () => {
  it.each([
    { efforts: ["medium", "high", "xhigh", "ultra"], expected: "xhigh" },
    { efforts: ["medium", "high"], expected: "high" },
    { efforts: ["medium"], expected: undefined },
    { efforts: [], expected: undefined },
  ])("chooses Astra with advertised effort $expected", ({ efforts, expected }) => {
    expect(
      discoveredCodexDefault({
        instanceId: "codex",
        models: [sol, astra(efforts)],
        availableModels: models,
      }),
    ).toEqual(
      buildModelSelection(
        "codex",
        "gpt-6-astra",
        expected ? { reasoningEffort: expected } : undefined,
        { instanceId: "codex" },
      ),
    );
  });

  it("never infers availability from static options or another account", () => {
    for (const discovered of [undefined, [], [sol]]) {
      expect(
        discoveredCodexDefault({
          instanceId: "codex",
          models: discovered,
          availableModels: models,
        }),
      ).toBeNull();
    }
    expect(
      discoveredCodexDefault({ instanceId: "codex", models, availableModels: [sol] }),
    ).toBeNull();
    for (const instanceId of ["codex_moss", "codex_byok"] as ProviderInstanceId[]) {
      expect(discoveredCodexDefault({ instanceId, models, availableModels: models })).toBeNull();
    }
    expect(
      discoveredCodexDefault({
        instanceId: "codex",
        accountId: "moss",
        models,
        availableModels: models,
      }),
    ).toBeNull();
  });

  it("keeps the discovered instance identity for an additional personal account", () => {
    expect(
      discoveredCodexDefault({
        instanceId: "codex_personal_work",
        models,
        availableModels: models,
      }),
    ).toMatchObject({
      ...preferred,
      instanceId: "codex_personal_work",
    });
    expect(
      state({ discoveredDefault: { ...preferred, instanceId: "codex_personal_work" } })
        .selectedModel,
    ).toBe(sol.slug);
  });

  it("uses discovery after cold start, persists the actual model and effort, and restores them", () => {
    expect(state({ discoveredDefault: null }).selectedModel).toBe(sol.slug);
    const selected = state();
    expect(selected).toEqual({
      selectedModel: "gpt-6-astra",
      modelOptions: { codex: { reasoningEffort: "xhigh" } },
    });
    const dispatch = getComposerProviderState({
      provider: "codex",
      model: selected.selectedModel,
      modelOptions: selected.modelOptions,
      runtimeModel: astra(),
      prompt: "",
    });
    expect(dispatch.promptEffort).toBe("xhigh");
    const persisted = buildModelSelection(
      "codex",
      selected.selectedModel,
      dispatch.modelOptionsForDispatch,
    );
    expect(persisted).toEqual(preferred);
    expect(state({ thread: persisted, discoveredDefault: null })).toEqual(selected);
    expect(state({ draft: persisted, discoveredDefault: null })).toEqual(selected);
  });

  it.each(["draft", "thread", "project"] as const)(
    "preserves an explicit %s model and effort",
    (source) => {
      const explicit = buildModelSelection("codex", sol.slug, { reasoningEffort: "medium" });
      expect(state({ [source]: explicit })).toEqual({
        selectedModel: sol.slug,
        modelOptions: { codex: { reasoningEffort: "medium" } },
      });
    },
  );

  it("does not apply a discovered default that was filtered out", () => {
    expect(state({ availableModels: [sol] })).toEqual({
      selectedModel: sol.slug,
      modelOptions: null,
    });
  });

  it("keeps personal default effort when the draft also remembers a managed account", () => {
    expect(
      deriveEffectiveComposerModelState({
        draft: {
          activeProvider: "codex",
          modelSelectionByProvider: {
            codex_moss: buildModelSelection(
              "codex",
              sol.slug,
              { reasoningEffort: "medium" },
              { instanceId: "codex_moss" },
            ),
          },
        },
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex",
        threadModelSelection: null,
        projectModelSelection: null,
        discoveredDefaultModelSelection: preferred,
        customModelsByProvider: {},
        availableModelOptionsByProvider: { codex: models },
      }),
    ).toEqual({
      selectedModel: "gpt-6-astra",
      modelOptions: { codex: { reasoningEffort: "xhigh" } },
    });
  });
});
