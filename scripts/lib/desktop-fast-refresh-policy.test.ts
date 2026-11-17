import { describe, expect, it } from "vitest";

import { changedPackageFields, classifyFastRefreshChanges } from "./desktop-fast-refresh-policy.ts";

const noPackage = () => ({ before: null, after: null });

describe("classifyFastRefreshChanges", () => {
  it("lets app code through", () => {
    expect(
      classifyFastRefreshChanges(
        [
          "apps/web/src/components/chat/MessagesTimeline.tsx",
          "apps/server/src/provider/Layers/CodexAdapter.ts",
          "apps/desktop/src/main.ts",
          "packages/shared/src/theme.ts",
          "THIRD_PARTY_NOTICES.md",
          "scripts/lib/dev-moss-canvas-bundle.ts",
          "scripts/lib/desktop-fast-refresh-policy.ts",
          "scripts/lib/bundled-codex-runtime.test.ts",
          "turbo.json",
        ],
        noPackage,
      ),
    ).toEqual([]);
  });

  it("refuses dependency, resource, canvas and packaging changes", () => {
    const refused = classifyFastRefreshChanges(
      [
        "bun.lock",
        "scripts/desktop-stage-lock/bun.lock",
        "patches/foo@1.0.0.patch",
        "apps/desktop/resources/icon.ico",
        "scripts/lib/moss-canvas-source-pin.json",
        "scripts/build-desktop-artifact.ts",
        "scripts/lib/bundled-codex-pins.ts",
        "scripts/lib/desktop-platform-build-config.ts",
        "apps/desktop/native/helper.c",
      ],
      noPackage,
    ).map((r) => r.path);
    expect(refused).toHaveLength(9);
  });

  it("refuses a package.json whose dependencies or version changed, not one whose scripts changed", () => {
    const texts: Record<string, { before: string; after: string }> = {
      "apps/server/package.json": {
        before: JSON.stringify({ scripts: { test: "a" }, dependencies: { x: "1" } }),
        after: JSON.stringify({ scripts: { test: "b" }, dependencies: { x: "1" } }),
      },
      "apps/desktop/package.json": {
        before: JSON.stringify({ version: "1.0.7", dependencies: { electron: "43.8.1" } }),
        after: JSON.stringify({ version: "1.0.7", dependencies: { electron: "43.9.0" } }),
      },
    };
    const refusals = classifyFastRefreshChanges(Object.keys(texts), (p) => texts[p]!);
    expect(refusals).toEqual([
      { path: "apps/desktop/package.json", reason: "package fields changed: dependencies" },
    ]);
  });
});

describe("changedPackageFields", () => {
  it("ignores key order and devDependencies", () => {
    expect(
      changedPackageFields(
        JSON.stringify({ dependencies: { a: "1", b: "2" }, devDependencies: { v: "1" } }),
        JSON.stringify({ dependencies: { b: "2", a: "1" }, devDependencies: { v: "2" } }),
      ),
    ).toEqual([]);
    expect(changedPackageFields(null, "{}")).toEqual(["(file added or removed)"]);
    expect(changedPackageFields('{"version":"1.0.6"}', '{"version":"1.0.7"}')).toEqual(["version"]);
  });
});
