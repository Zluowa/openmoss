import { createRequire } from "node:module";
import { matchesGlob } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopBundleFilePatterns,
  isDesktopClientPrecompressedSidecar,
  preserveDependencyDiagnostics,
} from "./lib/desktop-bundle-files.ts";

// These are the real platform preference names, not a second copy of the UI map.
import { desktopAppIconResourceName } from "../apps/desktop/src/desktopAppIcon.ts";

interface MinimatchConstructor {
  new (
    pattern: string,
    options?: { readonly dot?: boolean },
  ): {
    readonly negate: boolean;
    match(path: string): boolean;
  };
}

const requireFromBuilder = createRequire(
  createRequire(import.meta.url).resolve("electron-builder"),
);
const { Minimatch } = requireFromBuilder("minimatch") as {
  readonly Minimatch: MinimatchConstructor;
};

function excluded(path: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some((pattern) => pattern.startsWith("!") && matchesGlob(path, pattern.slice(1)));
}

function excludedByElectronBuilderMinimatch(
  path: string,
  patterns: ReadonlyArray<string>,
): boolean {
  let included = false;
  for (const pattern of patterns) {
    const matcher = new Minimatch(pattern, { dot: true });
    if (matcher.negate) {
      if (!matcher.match(path)) included = false;
    } else if (matcher.match(path)) {
      included = true;
    }
  }
  return !included;
}

describe("desktop bundle file selection", () => {
  it("drops dependency diagnostics by default, not executable JavaScript or runtime helper sources", () => {
    const patterns = createDesktopBundleFilePatterns("mac");
    for (const path of [
      "node_modules/effect/dist/Effect.js.map",
      "node_modules/@anthropic-ai/sdk/index.d.mts",
      "node_modules/zod/v4/index.d.cts",
      "node_modules/effect/tsconfig.tsbuildinfo",
      "node_modules/effect/src/Effect.ts",
      "node_modules/@effect/platform-node-shared/src/ChildProcess.ts",
      "node_modules/@noble/hashes/src/sha256.ts",
    ]) {
      expect(excluded(path, patterns), path).toBe(true);
      expect(excludedByElectronBuilderMinimatch(path, patterns), path).toBe(true);
    }
    for (const path of [
      "node_modules/effect/dist/Effect.js",
      "node_modules/effect/package.json",
      "node_modules/@effect/platform-node-shared/dist/ChildProcess.js",
      "node_modules/custom-extension/src/index.ts",
      "apps/server/dist/device-helper/Sources/main.swift",
      "node_modules/node-pty/build/Release/pty.node",
      "node_modules/node-pty/build/Release/spawn-helper",
      "node_modules/@anthropic-ai/sdk/index.mjs",
      "node_modules/@sentry/node/build/cjs/index.js",
      "node_modules/yjs/dist/yjs.cjs",
      "node_modules/slate/dist/index.js",
      "node_modules/@pierre/diffs/dist/components/File.js",
    ]) {
      expect(excluded(path, patterns), path).toBe(false);
      expect(excludedByElectronBuilderMinimatch(path, patterns), path).toBe(false);
    }
  });

  it("retains dependency source maps and sources in diagnostic builds", () => {
    for (const name of ["MOSS_WEB_SOURCEMAP", "MOSS_SERVER_SOURCEMAP", "MOSS_DESKTOP_SOURCEMAP"]) {
      for (const value of ["1", " true ", "HIDDEN"]) {
        const diagnostics = preserveDependencyDiagnostics({ [name]: value });
        expect(diagnostics).toBe(true);
        const patterns = createDesktopBundleFilePatterns("linux", { diagnostics });
        expect(excluded("node_modules/effect/dist/Effect.js.map", patterns)).toBe(false);
        expect(excluded("node_modules/effect/src/Effect.ts", patterns)).toBe(false);
      }
    }
    expect(preserveDependencyDiagnostics({})).toBe(false);
    expect(preserveDependencyDiagnostics({ MOSS_SERVER_SOURCEMAP: "false" })).toBe(false);
  });

  it("retains vendored licenses and non-TypeScript source assets", () => {
    const patterns = createDesktopBundleFilePatterns("linux");
    for (const path of [
      "node_modules/@anthropic-ai/sdk/src/internal/qs/LICENSE.md",
      "node_modules/effect/src/NOTICE",
      "node_modules/@effect/platform-node-shared/src/runtime-data.json",
    ]) {
      expect(excluded(path, patterns), path).toBe(false);
      expect(excludedByElectronBuilderMinimatch(path, patterns), path).toBe(false);
    }
    expect(excluded("node_modules/@anthropic-ai/sdk/src/internal/qs/index.ts", patterns)).toBe(
      true,
    );
  });

  it("preserves every supported icon preference and shared fallback while dropping build-only files", () => {
    for (const [platform, host] of [
      ["mac", "darwin"],
      ["linux", "linux"],
      ["win", "win32"],
    ] as const) {
      const patterns = createDesktopBundleFilePatterns(platform);
      for (const icon of ["default", "icon", "dark", "beta"] as const) {
        for (const isDarkAppearance of [true, false]) {
          const name = desktopAppIconResourceName({
            platform: host,
            icon,
            isDarkAppearance,
            isBetaFlavor: true,
          });
          expect(
            excluded(`apps/desktop/prod-resources/${name}`, patterns),
            `${platform}/${name}`,
          ).toBe(false);
        }
      }
      expect(excluded("apps/desktop/prod-resources/moss.png", patterns)).toBe(false);
      expect(excluded("apps/desktop/prod-resources/icon.png", patterns)).toBe(false);
      expect(
        excluded("apps/desktop/prod-resources/moss-production-public-config.json", patterns),
      ).toBe(false);
      expect(excluded("apps/desktop/prod-resources/entitlements.mac.plist", patterns)).toBe(true);
      expect(excluded("apps/desktop/prod-resources/entitlements.mac.inherit.plist", patterns)).toBe(
        true,
      );
      expect(excluded("apps/desktop/prod-resources/installer.nsh", patterns)).toBe(true);
      expect(excluded("apps/desktop/resources/entitlements.mac.plist", patterns)).toBe(false);
    }
  });

  it("removes MSVC build intermediates, not terminal runtime binaries", () => {
    const patterns = createDesktopBundleFilePatterns("win");
    for (const file of [
      "build/Release/winpty-agent.iobj",
      "build/Release/pty.ipdb",
      "build/deps/winpty/src/Release/obj/winpty/winpty.tlog/CL.read.1.tlog",
      "build/pty.vcxproj",
      "build/Release/pty.lib",
      "lib/unixTerminal.test.js",
    ]) {
      expect(excluded(`node_modules/node-pty/${file}`, patterns), file).toBe(true);
      expect(
        excludedByElectronBuilderMinimatch(`node_modules/node-pty/${file}`, patterns),
        file,
      ).toBe(true);
    }
    for (const file of [
      "build/Release/conpty.node",
      "build/Release/winpty.dll",
      "build/Release/winpty-agent.exe",
      "third_party/conpty/1.23.251008001/win10-x64/OpenConsole.exe",
    ]) {
      expect(excluded(`node_modules/node-pty/${file}`, patterns), file).toBe(false);
    }
  });

  it("keeps native PTY prebuilds for the target platform, including both Mac architectures", () => {
    const mac = createDesktopBundleFilePatterns("mac");
    expect(excluded("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", mac)).toBe(false);
    expect(excluded("node_modules/node-pty/prebuilds/darwin-x64/spawn-helper", mac)).toBe(false);
    expect(excluded("node_modules/node-pty/prebuilds/win32-x64/pty.node", mac)).toBe(true);

    const win = createDesktopBundleFilePatterns("win");
    expect(excluded("node_modules/node-pty/prebuilds/win32-x64/conpty.node", win)).toBe(false);
    expect(excluded("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", win)).toBe(true);

    const linux = createDesktopBundleFilePatterns("linux");
    expect(excluded("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", linux)).toBe(true);
    expect(excluded("node_modules/node-pty/prebuilds/win32-x64/conpty.node", linux)).toBe(true);
  });

  it("prunes verified unused dependency payloads and precompressed client sidecars while retaining runtime entrypoints", () => {
    const patterns = createDesktopBundleFilePatterns("mac");
    for (const path of [
      "node_modules/patchright-core/lib/index.js",
      "node_modules/playwright-core/lib/vite/traceViewer/index.html",
      "node_modules/playwright/node_modules/playwright-core/lib/vite/htmlReport/index.html",
      "node_modules/@ghostery/adblocker/dist/esm/index.js",
      "node_modules/betterwright/docs/README.md",
      "node_modules/effect/dist/unstable/httpapi/internal/httpApiScalar.js",
      "node_modules/effect/dist/unstable/httpapi/internal/httpApiSwagger.js",
      "node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js",
      "node_modules/zod/src/v4/classic/schemas.ts",
      "node_modules/undici/docs/docs/api/Client.md",
      "node_modules/foo/node_modules/undici/docs/README.md",
      "apps/server/dist/client/index.html.gz",
      "apps/server/dist/client/index.html.br",
      "apps/server/dist/client/assets/index-abc123.js.gz",
      "apps/server/dist/client/assets/index-abc123.js.br",
    ]) {
      expect(excluded(path, patterns), path).toBe(true);
      expect(excludedByElectronBuilderMinimatch(path, patterns), path).toBe(true);
    }
    for (const path of [
      "node_modules/betterwright/dist/src/index.js",
      "node_modules/playwright-core/index.js",
      "node_modules/playwright/node_modules/playwright-core/index.js",
      "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
      "node_modules/zod/v4/classic/schemas.js",
      "node_modules/tldts/dist/cjs/index.js",
      "apps/server/dist/client/index.html",
      "apps/server/dist/client/assets/index-abc123.js",
    ]) {
      expect(excluded(path, patterns), path).toBe(false);
      expect(excludedByElectronBuilderMinimatch(path, patterns), path).toBe(false);
    }
  });

  it("identifies precompressed web client sidecars relative to apps/server/dist", () => {
    expect(isDesktopClientPrecompressedSidecar("client/index.html.gz")).toBe(true);
    expect(isDesktopClientPrecompressedSidecar("client/assets/index-abc123.js.br")).toBe(true);
    expect(isDesktopClientPrecompressedSidecar("client\\assets\\index-abc123.js.gz")).toBe(true);
    expect(isDesktopClientPrecompressedSidecar("client/index.html")).toBe(false);
    expect(isDesktopClientPrecompressedSidecar("client/assets/index-abc123.js")).toBe(false);
    expect(isDesktopClientPrecompressedSidecar("index.mjs")).toBe(false);
    expect(isDesktopClientPrecompressedSidecar("ssh-runtime.tar.gz")).toBe(false);
  });
});
