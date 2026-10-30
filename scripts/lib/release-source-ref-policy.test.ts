import { describe, expect, it, vi } from "vitest";

import { resolveReleaseSourceTag } from "./release-source-ref-policy";

const sourceCommit = "a".repeat(40);

describe("release source ref policy", () => {
  it("accepts exact current main publication without inventing a source tag", () => {
    const resolveTagCommit = vi.fn();
    expect(
      resolveReleaseSourceTag({
        tag: "v0.5.6",
        publishRelease: true,
        refType: "branch",
        refName: "main",
        sourceCommit,
        resolveTagCommit,
      }),
    ).toBe("");
    expect(resolveTagCommit).not.toHaveBeenCalled();
  });

  it("accepts an exact source tag only when it resolves to the source commit", () => {
    expect(
      resolveReleaseSourceTag({
        tag: "v0.5.6",
        publishRelease: true,
        refType: "tag",
        refName: "v0.5.6",
        sourceCommit,
        resolveTagCommit: () => sourceCommit,
      }),
    ).toBe("v0.5.6");
  });

  it("rejects a mismatched source tag", () => {
    expect(() =>
      resolveReleaseSourceTag({
        tag: "v0.5.6",
        publishRelease: true,
        refType: "tag",
        refName: "v0.5.6",
        sourceCommit,
        resolveTagCommit: () => "b".repeat(40),
      }),
    ).toThrow("points to");
  });

  it("rejects publication from any other source ref", () => {
    expect(() =>
      resolveReleaseSourceTag({
        tag: "v0.5.6",
        publishRelease: true,
        refType: "branch",
        refName: "feature",
        sourceCommit,
        resolveTagCommit: () => sourceCommit,
      }),
    ).toThrow("exact source branch main");
  });
});
