import { describe, expect, it } from "vitest";

import {
  normalizeMossShellRouteToggle,
  resolveMossShellProductizationState,
} from "./mossShellProductization";

describe("normalizeMossShellRouteToggle", () => {
  it("accepts explicit enabled route values", () => {
    expect(normalizeMossShellRouteToggle("1")).toBe("1");
    expect(normalizeMossShellRouteToggle("true")).toBe("1");
    expect(normalizeMossShellRouteToggle("on")).toBe("1");
    expect(normalizeMossShellRouteToggle("enabled")).toBe("1");
    expect(normalizeMossShellRouteToggle('"1"')).toBe("1");
    expect(normalizeMossShellRouteToggle("'true'")).toBe("1");
    expect(normalizeMossShellRouteToggle(true)).toBe("1");
    expect(normalizeMossShellRouteToggle(1)).toBe("1");
  });

  it("rejects closed or ambiguous route values", () => {
    expect(normalizeMossShellRouteToggle("0")).toBeUndefined();
    expect(normalizeMossShellRouteToggle("false")).toBeUndefined();
    expect(normalizeMossShellRouteToggle("off")).toBeUndefined();
    expect(normalizeMossShellRouteToggle("")).toBeUndefined();
  });
});

describe("resolveMossShellProductizationState", () => {
  it("keeps the Moss shell default-off without an explicit toggle", () => {
    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: false,
        routeEnabled: false,
        surfaceMode: "single",
        presentationMode: "default",
      }),
    ).toEqual({
      enabled: false,
      source: "default-off",
      mode: "default-off",
      reason: "default-off",
    });
  });

  it("enables the shell from a normal product thread route query", () => {
    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: false,
        routeEnabled: true,
        surfaceMode: "single",
        presentationMode: "default",
      }),
    ).toEqual({
      enabled: true,
      source: "route-toggle",
      mode: "explicit-toggle",
      reason: "normal-product-thread-route",
    });
  });

  it("enables the shell from the product-default placement switch", () => {
    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: true,
        routeEnabled: false,
        surfaceMode: "single",
        presentationMode: "default",
      }),
    ).toEqual({
      enabled: true,
      source: "product-default",
      mode: "product-default",
      reason: "product-default-placement",
    });
  });

  it("keeps the explicit route toggle above the product-default switch", () => {
    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: true,
        routeEnabled: true,
        surfaceMode: "single",
        presentationMode: "default",
      }),
    ).toMatchObject({
      enabled: true,
      source: "route-toggle",
      mode: "explicit-toggle",
    });
  });

  it("keeps the local feature flag as an explicit opt-in path", () => {
    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: true,
        productDefaultEnabled: false,
        routeEnabled: false,
        surfaceMode: "single",
        presentationMode: "default",
      }),
    ).toMatchObject({
      enabled: true,
      source: "feature-flag",
      mode: "explicit-toggle",
    });
  });

  it("does not inject the product shell into split or editor surfaces", () => {
    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: false,
        routeEnabled: true,
        surfaceMode: "split",
        presentationMode: "default",
      }),
    ).toMatchObject({
      enabled: false,
      source: "route-toggle",
      reason: "unsupported-surface",
    });

    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: true,
        routeEnabled: false,
        surfaceMode: "split",
        presentationMode: "default",
      }),
    ).toMatchObject({
      enabled: false,
      source: "product-default",
      mode: "product-default",
      reason: "unsupported-surface",
    });

    expect(
      resolveMossShellProductizationState({
        featureFlagEnabled: false,
        productDefaultEnabled: false,
        routeEnabled: true,
        surfaceMode: "single",
        presentationMode: "editor",
      }),
    ).toMatchObject({
      enabled: false,
      source: "route-toggle",
      reason: "unsupported-surface",
    });
  });
});
