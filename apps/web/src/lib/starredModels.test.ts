import { describe, expect, it } from "vitest";

import {
  normalizeStarredModels,
  seedStarredModelsFromLegacyFavorites,
  starredModelKey,
  starredModelSlotKey,
  toggleStarredModel,
  unstarModel,
} from "./starredModels";

const highFast = {
  provider: "codex" as const,
  model: "gpt-6-astra",
  effort: "high",
  fastMode: true,
  thinking: null,
};

describe("starred model storage", () => {
  it("allows multiple trait presets for one model", () => {
    const low = { ...highFast, effort: "low" };
    const stored = toggleStarredModel(toggleStarredModel([], highFast), low);
    expect(stored.map(starredModelKey)).toEqual([starredModelKey(highFast), starredModelKey(low)]);
  });

  it("unstars every preset in one provider-model slot", () => {
    const low = { ...highFast, effort: "low" };
    const other = { ...highFast, model: "gpt-6-sol" };
    expect(unstarModel([highFast, low, other], highFast)).toEqual([other]);
    expect(starredModelSlotKey(highFast)).not.toBe(starredModelSlotKey(other));
  });

  it("normalizes duplicate and unknown entries", () => {
    expect(
      normalizeStarredModels([highFast, highFast, { ...highFast, provider: "unknown-provider" }]),
    ).toEqual([highFast]);
  });

  it("migrates Moss provider-instance favorites into starred presets", () => {
    expect(
      seedStarredModelsFromLegacyFavorites({
        favorites: [{ provider: "codex_moss", model: "gpt-6-astra" }],
        providerInstances: [{ instanceId: "codex_moss", provider: "codex" }],
      }),
    ).toEqual([
      { provider: "codex", model: "gpt-6-astra", effort: null, fastMode: null, thinking: null },
    ]);
  });
});
