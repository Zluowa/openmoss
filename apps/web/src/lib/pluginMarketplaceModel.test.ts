// FILE: pluginMarketplaceModel.test.ts
// Purpose: Frozen Codex add-marketplace form normalization contract.
// Layer: Unit test

import { describe, expect, it } from "vitest";

import { normalizePluginMarketplaceForm } from "./pluginMarketplaceModel";

describe("normalizePluginMarketplaceForm", () => {
  it("requires a non-empty source", () => {
    expect(normalizePluginMarketplaceForm({ source: "   ", refName: "", sparsePaths: "" })).toEqual(
      { ok: false, field: "source" },
    );
  });

  it("trims source/ref and splits comma or newline sparse paths", () => {
    expect(
      normalizePluginMarketplaceForm({
        source: "  openai/plugins  ",
        refName: " main ",
        sparsePaths: " plugins/codex, plugins/docs\n\nplugins/ops ",
      }),
    ).toEqual({
      ok: true,
      value: {
        source: "openai/plugins",
        refName: "main",
        sparsePaths: ["plugins/codex", "plugins/docs", "plugins/ops"],
      },
    });
  });

  it("uses null for omitted optional fields", () => {
    expect(
      normalizePluginMarketplaceForm({
        source: "git@github.com:org/repo.git",
        refName: " ",
        sparsePaths: "\n, ",
      }),
    ).toEqual({
      ok: true,
      value: {
        source: "git@github.com:org/repo.git",
        refName: null,
        sparsePaths: null,
      },
    });
  });
});
