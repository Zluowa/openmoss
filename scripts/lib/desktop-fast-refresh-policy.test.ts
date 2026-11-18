import { describe, expect, it } from "vitest";

import {
  changedPackageFields,
  classifyFastRefreshChanges,
  webBuildInputs,
  type DependencyDecision,
} from "./desktop-fast-refresh-policy.ts";

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

describe("webBuildInputs", () => {
  it("keeps the web client for server, desktop, docs, tooling and test-only changes", () => {
    expect(
      webBuildInputs([
        "apps/server/src/provider/Layers/CodexAdapter.ts",
        "apps/desktop/src/main.ts",
        "apps/server/src/http.ts",
        "docs/handbook/resources.md",
        ".github/workflows/ci.yml",
        "scripts/desktop-fast-refresh.ts",
        "tools/check/cli.ts",
        "README.md",
        "apps/web/src/components/ChatView.test.tsx",
        "apps/web/src/components/ChatView.browser.tsx",
        "packages/contracts/src/orchestration.test.ts",
      ]),
    ).toEqual([]);
  });

  it("rebuilds for the web app, the packages it compiles, its config imports and root files", () => {
    const inputs = [
      "apps/web/src/components/ChatView.tsx",
      "apps/web/vite.config.ts",
      "apps/web/public/icon.svg",
      "packages/contracts/src/orchestration.ts",
      "packages/shared/src/index.ts",
      "packages/shared/src/types.d.ts",
      "tools/test-quarantine/vitest.ts",
      "tsconfig.base.json",
      "package.json",
      "turbo.json",
    ];
    expect(webBuildInputs([...inputs, "apps/server/src/http.ts"])).toEqual(inputs);
    expect(webBuildInputs(["apps\\web\\src\\main.tsx"])).toEqual(["apps/web/src/main.tsx"]);
  });
});

// bun.lock is JSON with trailing commas; the fixtures keep them to exercise the parser.
const lockText = (webDeps: Record<string, string>, packages: Record<string, unknown[]>) =>
  `{
"lockfileVersion": 1,
"workspaces": {
  "": { "name": "@moss/monorepo", },
  "apps/server": { "name": "@moss/cli", "dependencies": { "ws": "^8.0.0", "betterwright": "2.7.3", }, "devDependencies": { "@moss/web": "workspace:*", }, },
  "apps/desktop": { "name": "@moss/desktop", "dependencies": { "electron": "43.8.1", }, },
  "apps/web": { "name": "@moss/web", "dependencies": ${JSON.stringify(webDeps)}, },
},
"packages": ${JSON.stringify(packages, null, 2).replace(/\n\}$/u, ",\n}")},
}`;

const reader =
  (files: Record<string, { before: string | null; after: string | null }>) => (p: string) =>
    files[p] ?? { before: null, after: null };

const rootPackage = (patched: Record<string, string>) =>
  JSON.stringify({ workspaces: { catalog: {} }, patchedDependencies: patched });

const stagePackage = (deps: Record<string, string>, patched: Record<string, string>) =>
  JSON.stringify({ dependencies: deps, patchedDependencies: patched });

describe("dependency changes decided from bun.lock", () => {
  const basePackages: Record<string, unknown[]> = {
    ws: ["ws@8.21.0", "", {}, "sha512-a"],
    betterwright: [
      "betterwright@2.7.3",
      "",
      { dependencies: { "playwright-core": "1.58.2" } },
      "x",
    ],
    "playwright-core": ["playwright-core@1.58.2", "", {}, "sha512-b"],
    electron: ["electron@43.8.1", "", {}, "sha512-c"],
    react: ["react@19.2.0", "", {}, "sha512-d"],
    "@moss/web": ["@moss/web@workspace:apps/web"],
  };
  const uiSdk = {
    "@ui-sdk/core": ["@ui-sdk/core@0.1.0-beta.7", "", {}, "sha512-e"],
    "@ui-sdk/react": [
      "@ui-sdk/react@0.1.0-beta.7",
      "",
      { peerDependencies: { "@ui-sdk/core": "^0.1.0-beta.7", react: ">=19" } },
      "sha512-f",
    ],
  };

  it("carries packages only the web client bundles, and says so per package", () => {
    const files = reader({
      "bun.lock": {
        before: lockText({ react: "19.2.0" }, basePackages),
        after: lockText(
          { react: "19.2.0", "@ui-sdk/core": "0.1.0-beta.7", "@ui-sdk/react": "0.1.0-beta.7" },
          { ...basePackages, ...uiSdk },
        ),
      },
      "apps/web/package.json": {
        before: JSON.stringify({ dependencies: { react: "19.2.0" } }),
        after: JSON.stringify({
          dependencies: { react: "19.2.0", "@ui-sdk/core": "0.1.0-beta.7" },
        }),
      },
    });
    const decisions: DependencyDecision[] = [];
    expect(
      classifyFastRefreshChanges(["apps/web/package.json", "bun.lock"], files, decisions),
    ).toEqual([]);
    expect(decisions.map((d) => [d.name, d.packaged])).toEqual([
      ["@ui-sdk/core", false],
      ["@ui-sdk/react", false],
    ]);
    expect(decisions[0]!.reason).toContain("apps/web");
  });

  it("refuses a change to a package the server loads, directly or through another package", () => {
    const bumped = (key: string, version: string) => ({
      ...basePackages,
      [key]: [`${key}@${version}`, "", basePackages[key]![2], "sha512-new"],
    });
    for (const [key, version] of [
      ["ws", "8.22.0"],
      ["playwright-core", "1.59.0"],
    ] as const) {
      const decisions: DependencyDecision[] = [];
      const refusals = classifyFastRefreshChanges(
        ["bun.lock"],
        reader({
          "bun.lock": {
            before: lockText({}, basePackages),
            after: lockText({}, bumped(key, version)),
          },
        }),
        decisions,
      );
      expect(refusals).toEqual([
        {
          path: "bun.lock",
          reason: `packaged dependencies changed (the installed app loads them): ${key}`,
        },
      ]);
      expect(decisions).toEqual([expect.objectContaining({ name: key, packaged: true })]);
    }
  });

  it("carries a patched web-only package through the root and the packaged stage files", () => {
    const patch = "patches/@ui-sdk%2Fcore@0.1.0-beta.7.patch";
    const stageLock = (packages: Record<string, unknown[]>) =>
      lockText({}, packages).replace('"apps/web"', '"unused"');
    const files = reader({
      "bun.lock": {
        before: lockText({ "@ui-sdk/core": "0.1.0-beta.7" }, { ...basePackages, ...uiSdk }),
        after: lockText(
          { "@ui-sdk/core": "0.1.0-beta.7" },
          {
            ...basePackages,
            ...uiSdk,
            "@ui-sdk/core": ["@ui-sdk/core@0.1.0-beta.7", "", {}, "sha512-patched"],
          },
        ),
      },
      "package.json": {
        before: rootPackage({}),
        after: rootPackage({ "@ui-sdk/core@0.1.0-beta.7": patch }),
      },
      [patch]: { before: null, after: "diff --git a/index.js b/index.js\n" },
      "scripts/desktop-stage-lock/package.json": {
        before: stagePackage({ ws: "^8.0.0" }, {}),
        after: stagePackage(
          { ws: "^8.0.0", "@ui-sdk/core": "0.1.0-beta.7" },
          { "@ui-sdk/core@0.1.0-beta.7": patch },
        ),
      },
      "scripts/desktop-stage-lock/bun.lock": {
        before: stageLock({ ws: basePackages.ws! }),
        after: stageLock({ ws: basePackages.ws!, "@ui-sdk/core": uiSdk["@ui-sdk/core"] }),
      },
    });
    const decisions: DependencyDecision[] = [];
    expect(
      classifyFastRefreshChanges(
        [
          "bun.lock",
          "package.json",
          patch,
          "scripts/desktop-stage-lock/bun.lock",
          "scripts/desktop-stage-lock/package.json",
        ],
        files,
        decisions,
      ),
    ).toEqual([]);
    expect(decisions.map((d) => [d.name, d.packaged])).toEqual([["@ui-sdk/core", false]]);
  });

  it("refuses a patch to a packaged package, and anything when bun.lock cannot be read", () => {
    const patch = "patches/betterwright@2.7.3.patch";
    const lock = lockText({}, basePackages);
    const root = JSON.stringify({ patchedDependencies: { "betterwright@2.7.3": patch } });
    expect(
      classifyFastRefreshChanges(
        [patch],
        reader({
          "bun.lock": { before: lock, after: lock },
          "package.json": { before: root, after: root },
          [patch]: { before: "a", after: "b" },
        }),
      ),
    ).toEqual([
      {
        path: patch,
        reason: "packaged dependencies changed (the installed app loads them): betterwright",
      },
    ]);
    expect(
      classifyFastRefreshChanges(
        ["bun.lock"],
        reader({ "bun.lock": { before: "{ not json", after: lock } }),
      ),
    ).toEqual([{ path: "bun.lock", reason: "could not read bun.lock" }]);
  });
});
