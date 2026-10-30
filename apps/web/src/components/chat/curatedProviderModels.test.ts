import { resolveSelectableModel } from "@synara/shared/model";
import { describe, expect, it } from "vitest";

import type { ProviderModelOption } from "../../providerModelOptions";
import { curateProviderModelOptions } from "./curatedProviderModels";

function option(slug: string): ProviderModelOption {
  return { slug, name: slug };
}

describe("curateProviderModelOptions", () => {
  it("preserves the complete runtime catalog in provider order", () => {
    expect(
      curateProviderModelOptions({
        provider: "codex",
        options: [option("gpt-5.5"), option("gpt-5.6-sol"), option("gpt-5.4")],
      }).map((entry) => entry.slug),
    ).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-5.4"]);
  });

  it("keeps runtime-advertised Astra selectable with its provider label", () => {
    const options = curateProviderModelOptions({
      provider: "codex",
      options: [
        { slug: "gpt-6-astra", name: "GPT-6-Astra" },
        option("gpt-5.6-sol"),
        option("gpt-5.5"),
      ],
      activeModel: "gpt-5.5",
    });

    expect(options).toEqual([
      { slug: "gpt-6-astra", name: "GPT-6-Astra" },
      option("gpt-5.6-sol"),
      option("gpt-5.5"),
    ]);
    expect(resolveSelectableModel("codex", "gpt-6-astra", options)).toBe("gpt-6-astra");
  });

  it("does not invent an Astra choice when the account does not advertise it", () => {
    const options = curateProviderModelOptions({
      provider: "codex",
      options: [option("gpt-5.6-sol"), option("gpt-5.5")],
      activeModel: "gpt-5.5",
    });

    expect(options.map((entry) => entry.slug)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(resolveSelectableModel("codex", "gpt-6-astra", options)).toBeNull();
  });

  it("does not hide non-favorite models", () => {
    expect(
      curateProviderModelOptions({
        provider: "opencode",
        options: [option("vendor/default"), option("vendor/favorite"), option("vendor/secondary")],
        favoriteModels: new Set(["vendor/favorite"]),
      }).map((entry) => entry.slug),
    ).toEqual(["vendor/default", "vendor/favorite", "vendor/secondary"]);
  });

  it("keeps the Moss Kimi channel label without removing sibling models", () => {
    expect(
      curateProviderModelOptions({
        provider: "claudeAgent",
        options: [option("kimi-for-coding"), option("claude-opus-4-8")],
      }),
    ).toEqual([{ slug: "kimi-for-coding", name: "K3" }, option("claude-opus-4-8")]);
  });

  it("represents an active model that disappeared from the live catalog", () => {
    expect(
      curateProviderModelOptions({
        provider: "codex",
        options: [option("gpt-5.6-sol")],
        activeModel: "retired/codex",
        activeModelName: "Retired Codex",
      }),
    ).toEqual([option("gpt-5.6-sol"), { slug: "retired/codex", name: "Retired Codex" }]);
  });

  it("deduplicates repeated runtime rows and does not duplicate the active model", () => {
    expect(
      curateProviderModelOptions({
        provider: "codex",
        options: [option("gpt-5.5"), option("GPT-5.5"), option("gpt-5.4")],
        activeModel: "gpt-5.5",
      }).map((entry) => entry.slug),
    ).toEqual(["gpt-5.5", "gpt-5.4"]);
  });
});
