// FILE: providerOrdering.test.ts
// Purpose: Keeps provider ordering normalization covered for every exposed provider.
// Layer: Web settings tests
// Depends on: provider display metadata from contracts and providerOrdering helpers.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_ORDER,
  isProviderKind,
  normalizeHiddenProviders,
  normalizeProviderOrder,
} from "./providerOrdering";
import { MOSS_ACTIVE_PROVIDER_KINDS } from "./providerProductCatalog";

const ALL_PROVIDER_KINDS = Object.keys(PROVIDER_DISPLAY_NAMES) as ProviderKind[];

describe("providerOrdering", () => {
  it("includes only active product providers in the default order", () => {
    expect(DEFAULT_PROVIDER_ORDER).toEqual(MOSS_ACTIVE_PROVIDER_KINDS);
    expect(DEFAULT_PROVIDER_ORDER).toContain("antigravity");
    expect(DEFAULT_PROVIDER_ORDER).toContain("omp");
    expect(DEFAULT_PROVIDER_ORDER).not.toContain("droid");
    expect(DEFAULT_PROVIDER_ORDER).not.toContain("kilo");
  });

  it("keeps Pi as a valid provider for persisted order and visibility settings", () => {
    expect(isProviderKind("pi")).toBe(true);
    expect(normalizeProviderOrder(["pi", "codex"])[0]).toBe("pi");
    expect(normalizeHiddenProviders(["bogus", "pi", "pi"])).toEqual(["pi"]);
  });
});
