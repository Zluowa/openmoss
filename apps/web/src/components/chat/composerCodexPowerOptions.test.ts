import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveComposerCodexPowerOptions,
  resolveComposerPowerOptions,
  type ComposerCodexPowerEffort,
} from "./composerCodexPowerOptions";

function descriptor(
  slug: string,
  efforts: ReadonlyArray<string>,
  options: Partial<ProviderModelDescriptor> = {},
): ProviderModelDescriptor {
  return {
    slug,
    name: options.name ?? `GPT-${slug.replace(/^gpt-/iu, "")}`,
    supportedReasoningEfforts: efforts.map((value) => ({ value })),
    ...options,
  };
}

const TERRA_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const SOL_EFFORTS = ["low", "medium", "high", "xhigh", "ultra"] as const;

function fullCatalog(): ProviderModelDescriptor[] {
  return [
    descriptor("gpt-5.6-terra", TERRA_EFFORTS, {
      defaultReasoningEffort: "low",
      name: "GPT-5.6 Terra",
    }),
    descriptor("gpt-5.6-sol", SOL_EFFORTS, {
      defaultReasoningEffort: "medium",
      name: "GPT-5.6 Sol",
    }),
  ];
}

describe("resolveComposerCodexPowerOptions", () => {
  it("keeps canonical order and removes the GPT- prefix from labels", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: fullCatalog(),
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });

    expect(result.choices.map((choice) => choice.label)).toEqual([
      "5.6 Terra Light",
      "5.6 Sol Light",
      "5.6 Sol Standard",
      "5.6 Sol Extended",
      "5.6 Sol Extra High",
      "5.6 Sol Ultra",
    ]);
  });

  it("filters unsupported exact pairs while preserving canonical order", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", ["low"]),
        descriptor("gpt-5.6-sol", ["low", "high", "ultra"]),
      ],
    });

    expect(result.choices.map(({ model, reasoningEffort }) => [model, reasoningEffort])).toEqual([
      ["gpt-5.6-terra", "low"],
      ["gpt-5.6-sol", "low"],
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-sol", "ultra"],
    ]);
  });

  it("uses Terra effort order as a fallback when the primary ladder is short", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", TERRA_EFFORTS),
        descriptor("gpt-5.6-sol", ["low"]),
      ],
    });

    expect(result.choices.map((choice) => [choice.model, choice.reasoningEffort])).toEqual(
      TERRA_EFFORTS.map((effort) => ["gpt-5.6-terra", effort]),
    );
  });

  it("disables the compact surface when both ladders have fewer than three choices", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: [descriptor("gpt-5.6-sol", ["low", "high"])],
    });

    expect(result).toMatchObject({
      choices: [],
      selectedIndex: null,
      fallbackChoice: null,
      fallbackIndex: null,
    });
  });

  it("includes XHigh when the selected runtime descriptor advertises it", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", TERRA_EFFORTS),
        descriptor("gpt-5.6-sol", ["low", "medium", "high", "xhigh"]),
      ],
    });

    expect(result.choices.some((choice) => choice.reasoningEffort === "xhigh")).toBe(true);
  });

  it("includes Ultra only when the runtime catalog advertises it", () => {
    const withoutUltra = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", TERRA_EFFORTS),
        descriptor("gpt-5.6-sol", ["low", "medium", "high", "xhigh"]),
      ],
    });
    const withUltra = resolveComposerCodexPowerOptions({ runtimeModels: fullCatalog() });

    expect(withoutUltra.choices.some((choice) => choice.reasoningEffort === "ultra")).toBe(false);
    expect(withUltra.choices.some((choice) => choice.reasoningEffort === "ultra")).toBe(true);
  });

  it("never puts Max on the compact slider", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max"]),
        descriptor("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]),
      ],
    });

    expect(
      result.choices.every(
        (choice) => choice.reasoningEffort !== ("max" as ComposerCodexPowerEffort),
      ),
    ).toBe(true);
  });

  it("matches the selected pair exactly and does not coerce an unrepresented pair", () => {
    const represented = resolveComposerCodexPowerOptions({
      runtimeModels: fullCatalog(),
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    const unrepresented = resolveComposerCodexPowerOptions({
      runtimeModels: fullCatalog(),
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
    });

    expect(represented.selectedIndex).toBe(3);
    expect(unrepresented.selectedIndex).toBeNull();
  });

  it("fails closed when resolved model metadata has a non-selectable slug", () => {
    const result = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", TERRA_EFFORTS),
        descriptor("sol-account-alias", SOL_EFFORTS, { resolvedModel: "gpt-5.6-sol" }),
      ],
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });

    expect(result.choices.every((choice) => choice.model !== "gpt-5.6-sol")).toBe(true);
    expect(result.choices).toEqual(
      TERRA_EFFORTS.map((effort) =>
        expect.objectContaining({ model: "gpt-5.6-terra", reasoningEffort: effort }),
      ),
    );
    expect(result.selectedIndex).toBeNull();
  });

  it("follows the advertised default, Sol effort, medium, and first-choice fallback order", () => {
    const catalog = [
      descriptor("gpt-5.6-terra", ["low"], { defaultReasoningEffort: "xhigh" }),
      descriptor("gpt-5.6-sol", ["low", "medium", "high", "xhigh"]),
    ];
    const solEffortFallback = resolveComposerCodexPowerOptions({
      runtimeModels: catalog,
      defaultModel: "gpt-5.6-terra",
      defaultReasoningEffort: "xhigh",
    });
    expect(solEffortFallback.fallbackChoice).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    const mediumFallback = resolveComposerCodexPowerOptions({
      runtimeModels: [
        descriptor("gpt-5.6-terra", TERRA_EFFORTS),
        descriptor("gpt-5.6-sol", ["low", "medium", "high"]),
      ],
      defaultModel: "other-model",
      defaultReasoningEffort: "other-effort",
    });
    expect(mediumFallback.fallbackChoice).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
  });

  it("stamps the Codex effort option id on bundled choices", () => {
    const result = resolveComposerCodexPowerOptions({ runtimeModels: fullCatalog() });
    expect(result.choices.every((choice) => choice.optionId === "reasoningEffort")).toBe(true);
  });

  it("does not mutate or duplicate runtime catalog data", () => {
    const catalog = [
      descriptor("gpt-5.6-terra", TERRA_EFFORTS),
      descriptor("gpt-5.6-sol", SOL_EFFORTS),
      descriptor("gpt-5.6-sol", SOL_EFFORTS),
    ];
    const snapshot = structuredClone(catalog);

    const result = resolveComposerCodexPowerOptions({ runtimeModels: catalog });

    expect(catalog).toEqual(snapshot);
    expect(
      new Set(result.choices.map((choice) => `${choice.model}:${choice.reasoningEffort}`)).size,
    ).toBe(result.choices.length);
  });
});

const level = (value: string, label = value, isDefault = false) => ({
  value,
  label,
  ...(isDefault ? { isDefault: true as const } : {}),
});

describe("resolveComposerPowerOptions", () => {
  it("keeps the bundled Codex ladder for Terra and Sol", () => {
    const result = resolveComposerPowerOptions({
      provider: "codex",
      model: "gpt-5.6-sol",
      modelLabel: "5.6 Sol",
      optionId: "reasoningEffort",
      effortLevels: SOL_EFFORTS.map((value) => level(value)),
      effort: "high",
      runtimeModels: fullCatalog(),
    });

    expect(result.choices.map((choice) => choice.label)).toEqual([
      "5.6 Terra Light",
      "5.6 Sol Light",
      "5.6 Sol Standard",
      "5.6 Sol Extended",
      "5.6 Sol Extra High",
      "5.6 Sol Ultra",
    ]);
    expect(result.selectedIndex).toBe(3);
  });

  it("builds one tick per runtime-advertised effort for any other Codex model", () => {
    const input = {
      provider: "codex" as const,
      model: "gpt-5.5",
      modelLabel: "5.5",
      optionId: "reasoningEffort",
      effortLevels: [
        level("xhigh"),
        level("low"),
        level("medium", "Medium", true),
        level("high"),
        level("ultra"),
      ],
      effort: "high",
    };
    const result = resolveComposerPowerOptions({
      ...input,
      runtimeModels: [...fullCatalog(), descriptor("gpt-5.5", ["low", "medium", "high", "xhigh"])],
    });

    expect(result.choices.map((choice) => [choice.model, choice.reasoningEffort])).toEqual([
      ["gpt-5.5", "low"],
      ["gpt-5.5", "medium"],
      ["gpt-5.5", "high"],
      ["gpt-5.5", "xhigh"],
    ]);
    expect(result.selectedIndex).toBe(2);
    expect(result.fallbackChoice?.reasoningEffort).toBe("medium");
    expect(result.choices.every((choice) => !choice.isUltra)).toBe(true);

    // Static capability tables alone never create Codex ticks.
    expect(resolveComposerPowerOptions({ ...input, runtimeModels: fullCatalog() }).choices).toEqual(
      [],
    );
  });

  it("adapts to another vendor's effort vocabulary, option key, and labels", () => {
    const result = resolveComposerPowerOptions({
      provider: "claudeAgent",
      model: "claude-opus-4-8",
      modelLabel: "Opus 4.8",
      optionId: "effort",
      effortLevels: [
        level("low", "Low"),
        level("medium", "Medium"),
        level("high", "High"),
        level("max", "Max"),
      ],
      effort: "max",
      defaultEffort: "high",
      excludedEfforts: ["ultrathink"],
    });

    expect(result.choices.map((choice) => choice.reasoningEffort)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(result.choices.every((choice) => choice.optionId === "effort")).toBe(true);
    expect(result.choices.every((choice) => !choice.isUltra)).toBe(true);
    expect(result.choices[3]?.label).toBe("Opus 4.8 Max");
    expect(result.selectedIndex).toBe(3);
    expect(result.fallbackIndex).toBe(2);
  });

  it("drops prompt-injected levels and keeps vendor order for unknown values", () => {
    const result = resolveComposerPowerOptions({
      provider: "antigravity",
      model: "gemini-3-pro",
      modelLabel: "Gemini 3 Pro",
      optionId: "thinkingLevel",
      effortLevels: [level("ultra", "Ultra"), level("thinking", "Thinking"), level("deep", "Deep")],
      effort: "deep",
      excludedEfforts: ["deep"],
    });

    expect(result.choices.map((choice) => choice.reasoningEffort)).toEqual(["ultra", "thinking"]);
    expect(result.selectedIndex).toBeNull();
    // Antigravity's "ultra" is not Codex Ultra: no usage warning, no purple field.
    expect(result.choices[0]?.isUltra).toBe(false);
  });

  it("fails closed below two usable levels or without a model", () => {
    expect(
      resolveComposerPowerOptions({
        provider: "gemini",
        model: "gemini-3-flash",
        modelLabel: "Gemini 3 Flash",
        optionId: "thinkingLevel",
        effortLevels: [level("high")],
        effort: "high",
      }).choices,
    ).toEqual([]);
    expect(
      resolveComposerPowerOptions({
        provider: "codex",
        model: null,
        modelLabel: "",
        optionId: "reasoningEffort",
        effortLevels: [level("low"), level("high")],
        effort: "low",
      }).choices,
    ).toEqual([]);
  });
});
