// FILE: pluginLibraryRouteModel.test.ts
// Purpose: Locks the current Codex Skills & Apps route grammar and legacy compatibility.
// Layer: Web routing model test

import { describe, expect, it } from "vitest";

import {
  buildPluginLibraryPath,
  isCanonicalPluginLibraryPath,
  resolvePluginDetailRouteViewState,
  resolvePluginLibraryRoute,
} from "./pluginLibraryRouteModel";

describe("plugin library routes", () => {
  it("uses /skills as the canonical browse and manage root", () => {
    expect(buildPluginLibraryPath({ mode: "browse" })).toBe("/skills");
    expect(buildPluginLibraryPath({ mode: "manage" })).toBe("/skills/manage");
  });

  it("builds browse and manage plugin details without losing ids", () => {
    const pluginId = "browser@openai-curated";
    expect(buildPluginLibraryPath({ mode: "browse", pluginId })).toBe(
      "/skills/plugins/browser%40openai-curated",
    );
    expect(buildPluginLibraryPath({ mode: "manage", pluginId })).toBe(
      "/skills/manage/plugins/browser%40openai-curated",
    );
  });

  it("resolves every current route and treats /plugins as a legacy alias", () => {
    expect(resolvePluginLibraryRoute("/skills")).toEqual({ mode: "browse", pluginId: null });
    expect(resolvePluginLibraryRoute("/skills/manage")).toEqual({
      mode: "manage",
      pluginId: null,
    });
    expect(resolvePluginLibraryRoute("/settings/plugins-settings")).toEqual({
      mode: "manage",
      pluginId: null,
      settings: true,
    });
    expect(resolvePluginLibraryRoute("/skills/plugins/browser%40openai-curated")).toEqual({
      mode: "browse",
      pluginId: "browser@openai-curated",
    });
    expect(resolvePluginLibraryRoute("/skills/manage/plugins/browser%40openai-curated")).toEqual({
      mode: "manage",
      pluginId: "browser@openai-curated",
    });
    expect(resolvePluginLibraryRoute("/plugins")).toEqual({
      mode: "browse",
      pluginId: null,
      legacy: true,
    });
  });

  it("rejects unrelated paths and malformed detail ids", () => {
    expect(resolvePluginLibraryRoute("/settings")).toBeNull();
    expect(resolvePluginLibraryRoute("/settings/plugins-settings/extra")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/%E0%A4%A")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/a%2Fb")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/%20github")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/github%0A")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/.")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/..")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/%C2%85")).toBeNull();
    expect(resolvePluginLibraryRoute("/skills/plugins/github%40openai%2dcurated")).toBeNull();
  });

  it("distinguishes canonical plugin history paths from normalized or forged paths", () => {
    expect(isCanonicalPluginLibraryPath("/skills")).toBe(true);
    expect(isCanonicalPluginLibraryPath("/skills/manage")).toBe(true);
    expect(isCanonicalPluginLibraryPath("/settings/plugins-settings")).toBe(true);
    expect(isCanonicalPluginLibraryPath("/skills/plugins/browser%40openai-curated")).toBe(true);
    expect(isCanonicalPluginLibraryPath("/plugins")).toBe(false);
    expect(isCanonicalPluginLibraryPath("/skills/")).toBe(false);
    expect(isCanonicalPluginLibraryPath("/settings?section=plugins")).toBe(false);
    expect(isCanonicalPluginLibraryPath("https://attacker.test/skills")).toBe(false);
  });
});

describe("plugin detail route view state", () => {
  it("keeps browse, loading, error, not-found, and found detail distinct", () => {
    expect(
      resolvePluginDetailRouteViewState({
        pluginId: null,
        isLoading: false,
        error: null,
        found: false,
      }),
    ).toBe("browse");
    expect(
      resolvePluginDetailRouteViewState({
        pluginId: "browser@openai-curated",
        isLoading: true,
        error: null,
        found: false,
      }),
    ).toBe("loading");
    expect(
      resolvePluginDetailRouteViewState({
        pluginId: "browser@openai-curated",
        isLoading: false,
        error: new Error("offline"),
        found: false,
      }),
    ).toBe("error");
    expect(
      resolvePluginDetailRouteViewState({
        pluginId: "missing",
        isLoading: false,
        error: null,
        found: false,
      }),
    ).toBe("not-found");
    expect(
      resolvePluginDetailRouteViewState({
        pluginId: "browser@openai-curated",
        isLoading: true,
        error: new Error("stale refetch failed"),
        found: true,
      }),
    ).toBe("detail");
  });
});
