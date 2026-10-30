import { describe, expect, it } from "vitest";

import {
  BETA_ONLY_FEATURES,
  desktopFlavorFromBundleId,
  desktopFlavorFromProtocol,
  GROUPS_BETA_FEATURE,
  INLINE_VISUALS_BETA_FEATURE,
  isBetaFeatureEnabled,
  MCP_CONNECTORS_BETA_FEATURE,
} from "./betaFeatures";
import {
  MOSS_BETA_BUNDLE_ID,
  MOSS_CANARY_BUNDLE_ID,
  MOSS_CUA_BUNDLE_ID,
  MOSS_DEVELOPMENT_BUNDLE_ID,
  MOSS_PRODUCTION_BUNDLE_ID,
} from "./desktopIdentity";

describe("isBetaFeatureEnabled", () => {
  it.each(["inbox", "pull-request-auto-fix", "tasks"])(
    "offers %s in Stable and Beta",
    (feature) => {
      expect(isBetaFeatureEnabled(feature, "production")).toBe(true);
      expect(isBetaFeatureEnabled(feature, "beta")).toBe(true);
    },
  );

  it("enables Oh My Pi in Stable and all other flavors", () => {
    for (const flavor of [
      "production",
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
    ] as const) {
      expect(isBetaFeatureEnabled("omp", flavor)).toBe(true);
    }
  });

  it("offers inline visuals in Stable and all other flavors", () => {
    expect(BETA_ONLY_FEATURES).not.toContain(INLINE_VISUALS_BETA_FEATURE);
    for (const flavor of [
      "production",
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
    ] as const) {
      expect(isBetaFeatureEnabled(INLINE_VISUALS_BETA_FEATURE, flavor)).toBe(true);
    }
  });

  it("offers Connectors in Stable and all other flavors", () => {
    expect(BETA_ONLY_FEATURES).not.toContain(MCP_CONNECTORS_BETA_FEATURE);
    for (const flavor of [
      "production",
      "beta",
      "development",
      "canary",
      "cua",
      "unknown",
    ] as const) {
      expect(isBetaFeatureEnabled(MCP_CONNECTORS_BETA_FEATURE, flavor)).toBe(true);
    }
  });

  it("keeps Groups out of Stable only", () => {
    expect(BETA_ONLY_FEATURES).toContain(GROUPS_BETA_FEATURE);
    for (const flavor of ["development", "canary", "cua", "beta", "unknown"] as const) {
      expect(isBetaFeatureEnabled(GROUPS_BETA_FEATURE, flavor)).toBe(true);
    }
    expect(isBetaFeatureEnabled(GROUPS_BETA_FEATURE, "production")).toBe(false);
  });

  it("enables the rail sidebar layout in both Beta and Stable", () => {
    expect(isBetaFeatureEnabled("sidebarV2", "beta")).toBe(true);
    expect(isBetaFeatureEnabled("sidebarV2", "production")).toBe(true);
  });

  it("enables audio-driven message trails in both Beta and Stable", () => {
    expect(isBetaFeatureEnabled("audio-trail", "beta")).toBe(true);
    expect(isBetaFeatureEnabled("audio-trail", "production")).toBe(true);
  });

  it("leaves unlisted features enabled everywhere", () => {
    // The list is the whole gate: a feature not present is enabled everywhere,
    // which is also the steady state once a feature is promoted to Stable.
    for (const flavor of [
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
      "production",
    ] as const) {
      expect(isBetaFeatureEnabled("codex", flavor)).toBe(true);
    }
  });
});

describe("desktopFlavorFromBundleId", () => {
  it("maps each known bundle id", () => {
    expect(desktopFlavorFromBundleId(MOSS_PRODUCTION_BUNDLE_ID)).toBe("production");
    expect(desktopFlavorFromBundleId(MOSS_DEVELOPMENT_BUNDLE_ID)).toBe("development");
    expect(desktopFlavorFromBundleId(MOSS_CANARY_BUNDLE_ID)).toBe("canary");
    expect(desktopFlavorFromBundleId(MOSS_CUA_BUNDLE_ID)).toBe("cua");
    expect(desktopFlavorFromBundleId(MOSS_BETA_BUNDLE_ID)).toBe("beta");
  });

  it("trims surrounding whitespace", () => {
    expect(desktopFlavorFromBundleId(` ${MOSS_BETA_BUNDLE_ID} `)).toBe("beta");
  });

  it("returns unknown for blank or unrecognized ids", () => {
    expect(desktopFlavorFromBundleId(undefined)).toBe("unknown");
    expect(desktopFlavorFromBundleId("")).toBe("unknown");
    expect(desktopFlavorFromBundleId("   ")).toBe("unknown");
    expect(desktopFlavorFromBundleId("com.example.other")).toBe("unknown");
  });
});

describe("desktopFlavorFromProtocol", () => {
  it("maps each desktop scheme", () => {
    expect(desktopFlavorFromProtocol("moss-beta:", false)).toBe("beta");
    expect(desktopFlavorFromProtocol("moss-canary:", false)).toBe("canary");
    expect(desktopFlavorFromProtocol("moss-cua:", false)).toBe("cua");
    expect(desktopFlavorFromProtocol("moss:", false)).toBe("production");
  });

  it("treats the moss scheme in a dev build as development", () => {
    expect(desktopFlavorFromProtocol("moss:", true)).toBe("development");
  });

  it("returns unknown for non-desktop protocols and missing values", () => {
    expect(desktopFlavorFromProtocol("http:", false)).toBe("unknown");
    expect(desktopFlavorFromProtocol("https:", true)).toBe("unknown");
    expect(desktopFlavorFromProtocol(undefined, false)).toBe("unknown");
  });
});
