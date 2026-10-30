import { describe, expect, it } from "vitest";

import { resolveRepoDiffScopeSelection, sanitizeRepoDiffCompareRefs } from "./repoDiffScopeStore";

describe("resolveRepoDiffScopeSelection", () => {
  it("keeps the ref scope for a repository that has a compare ref", () => {
    expect(resolveRepoDiffScopeSelection("ref", "release/1.2")).toEqual({
      scope: "ref",
      compareRef: "release/1.2",
    });
  });

  it("keeps ref scope when a compare ref is unavailable", () => {
    expect(resolveRepoDiffScopeSelection("ref", null)).toEqual({
      scope: "ref",
      compareRef: null,
    });
  });

  it("passes other scopes through untouched", () => {
    expect(resolveRepoDiffScopeSelection("branch", null)).toEqual({
      scope: "branch",
    });
    expect(resolveRepoDiffScopeSelection("staged", "ignored")).toEqual({
      scope: "staged",
    });
  });
});

describe("sanitizeRepoDiffCompareRefs", () => {
  it("keeps non-empty string refs and trims whitespace", () => {
    expect(sanitizeRepoDiffCompareRefs(" feature/x ")).toBe("feature/x");
    expect(sanitizeRepoDiffCompareRefs("   ")).toBeNull();
  });

  it("drops legacy and malformed persisted values", () => {
    expect(sanitizeRepoDiffCompareRefs(undefined)).toBeNull();
    expect(sanitizeRepoDiffCompareRefs("feature/x")).toBe("feature/x");
    expect(sanitizeRepoDiffCompareRefs(null)).toBeNull();
  });
});
