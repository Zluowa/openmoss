// Packs a staged app the way the installer build does (electron-builder's own file matcher, then a
// real app.asar) and checks that every payload copied out to resources/ ships exactly once.
import * as FS from "node:fs";
import { createRequire } from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";

import * as Asar from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

import { desktopAsarFilePatterns, desktopExtraResources } from "./build-desktop-artifact.ts";
import { BUNDLED_CLAUDE_RUNTIME_DIR } from "./lib/bundled-claude-runtime.ts";
import { BUNDLED_CODEX_RUNTIME_DIR } from "./lib/bundled-codex-runtime.ts";
import { BUNDLED_CUA_DRIVER_DIR } from "./lib/bundled-cua-driver.ts";
import { MOSS_CANVAS_BUNDLE_DIR } from "./lib/bundled-moss-canvas.ts";
import {
  createDesktopPlatformBuildConfig,
  SSH_RUNTIME_STAGE_PATH,
} from "./lib/desktop-platform-build-config.ts";
import { WINDOWS_JOB_LAUNCHER_STAGE_PATH } from "./lib/windows-native-job-launcher.ts";

type FileFilter = (file: string, stat: FS.Stats) => boolean;
interface FileMatcherModule {
  FileMatcher: new (
    from: string,
    to: string,
    macroExpander: (pattern: string) => string,
    patterns: ReadonlyArray<string>,
  ) => { createFilter(): FileFilter };
}
// The matcher electron-builder itself runs over `files`, so pattern order is judged exactly as the
// installer build judges it (a later include re-adds what an earlier exclusion removed).
const requireFromBuilder = createRequire(
  createRequire(import.meta.url).resolve("electron-builder"),
);
const { FileMatcher } = requireFromBuilder("app-builder-lib/out/fileMatcher") as FileMatcherModule;

// The production public config is 2 KB and also sits in the staged resources folder; nothing else
// staged for resources/ may stay inside app.asar.
const SMALL_RESOURCE_ALSO_IN_ASAR = "apps/desktop/resources/moss-production-public-config.json";

const STAGED_FILES = [
  "package.json",
  "apps/desktop/dist-electron/main.cjs",
  "apps/desktop/resources/icon.ico",
  SMALL_RESOURCE_ALSO_IN_ASAR,
  `${MOSS_CANVAS_BUNDLE_DIR}/canvas-bundle-receipt.json`,
  `${MOSS_CANVAS_BUNDLE_DIR}/apps/codex-canvas/dist/index.html`,
  `${MOSS_CANVAS_BUNDLE_DIR}/apps/codex-canvas/electron/desktop-runtime.mjs`,
  `${MOSS_CANVAS_BUNDLE_DIR}/apps/codex-canvas/server/hosted-storage.mjs`,
  SSH_RUNTIME_STAGE_PATH,
  "apps/server/dist/bin.mjs",
  "apps/server/dist/client/index.html",
  "third-party-licenses/openai-codex/LICENSE",
  `${BUNDLED_CODEX_RUNTIME_DIR}/codex.exe`,
  `${BUNDLED_CLAUDE_RUNTIME_DIR}/claude.exe`,
  `${BUNDLED_CUA_DRIVER_DIR}/cua-driver.exe`,
  `${WINDOWS_JOB_LAUNCHER_STAGE_PATH}`,
] as const;
const APP_CODE = [
  "package.json",
  "apps/desktop/dist-electron/main.cjs",
  "apps/server/dist/bin.mjs",
  "apps/server/dist/client/index.html",
] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function stageApp(root: string): string {
  const stage = Path.join(root, "stage");
  for (const file of STAGED_FILES) {
    FS.mkdirSync(Path.dirname(Path.join(stage, file)), { recursive: true });
    FS.writeFileSync(Path.join(stage, file), `fixture ${file}\n`);
  }
  return stage;
}

/**
 * Walks the stage like electron-builder: a directory the filter refuses is never entered. (The
 * root node_modules goes through electron-builder's dependency collector, not this walk.)
 */
function selectAppFiles(stage: string, filter: FileFilter, directory = stage): string[] {
  const selected: string[] = [];
  for (const entry of FS.readdirSync(directory, { withFileTypes: true })) {
    const file = Path.join(directory, entry.name);
    if (!filter(file, FS.statSync(file))) continue;
    if (entry.isDirectory()) selected.push(...selectAppFiles(stage, filter, file));
    else selected.push(Path.relative(stage, file).split(Path.sep).join("/"));
  }
  return selected;
}

interface AsarNode {
  readonly files?: Record<string, AsarNode>;
}
/** Every file the archive's header lists, as forward-slash paths. */
function packedFiles(asar: string): string[] {
  const walk = (node: AsarNode, prefix: string): string[] =>
    Object.entries(node.files ?? {}).flatMap(([name, child]) =>
      child.files ? walk(child, `${prefix}${name}/`) : [`${prefix}${name}`],
    );
  return walk(Asar.getRawHeader(asar).header as AsarNode, "");
}

/** Builds resources/ (app.asar plus the extraResources copies) from one staged app. */
async function packageLayout(platform: "mac" | "linux" | "win") {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-asar-contents-"));
  roots.push(root);
  const stage = stageApp(root);
  const platformConfig = createDesktopPlatformBuildConfig({
    hostPlatform: platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux",
    platform,
    target: platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "AppImage",
  });
  const patterns = desktopAsarFilePatterns(platformConfig.files ?? []);
  const filter = new FileMatcher(stage, stage, (pattern) => pattern, patterns).createFilter();

  const appDir = Path.join(root, "app");
  for (const file of selectAppFiles(stage, filter)) {
    FS.mkdirSync(Path.dirname(Path.join(appDir, file)), { recursive: true });
    FS.copyFileSync(Path.join(stage, file), Path.join(appDir, file));
  }
  const resources = Path.join(root, "resources");
  FS.mkdirSync(resources, { recursive: true });
  const asar = Path.join(resources, "app.asar");
  await Asar.createPackage(appDir, asar);

  const extraResources = desktopExtraResources({
    platform,
    includeProductionPublicConfig: true,
    includeMossCanvasBundle: true,
  });
  for (const resource of extraResources) {
    FS.cpSync(Path.join(stage, resource.from), Path.join(resources, resource.to), {
      recursive: true,
    });
  }
  return { resources, asarFiles: packedFiles(asar), extraResources };
}

describe("app.asar contents", () => {
  for (const platform of ["win", "mac", "linux"] as const) {
    it(`ships the Canvas bundle and the SSH runtime once, outside app.asar (${platform})`, async () => {
      const { resources, asarFiles, extraResources } = await packageLayout(platform);

      // The packaged app still has what it runs: its code in app.asar...
      expect(asarFiles).toEqual(expect.arrayContaining([...APP_CODE]));
      // ...and the Canvas and SSH runtime where the desktop and the server read them in a
      // packaged build (resourcesPath/moss-canvas, resourcesPath/ssh-runtime.tar.gz).
      for (const file of [
        "moss-canvas/apps/codex-canvas/dist/index.html",
        "moss-canvas/apps/codex-canvas/electron/desktop-runtime.mjs",
        "moss-canvas/apps/codex-canvas/server/hosted-storage.mjs",
        "ssh-runtime.tar.gz",
      ]) {
        expect(FS.existsSync(Path.join(resources, file)), file).toBe(true);
      }

      // Nothing copied out to resources/ keeps a second copy inside app.asar.
      const duplicated = extraResources
        .filter((resource) => resource.from !== SMALL_RESOURCE_ALSO_IN_ASAR)
        .flatMap((resource) =>
          asarFiles.filter(
            (entry) => entry === resource.from || entry.startsWith(`${resource.from}/`),
          ),
        );
      expect(duplicated).toEqual([]);
      expect(asarFiles.filter((entry) => entry.startsWith("apps/desktop/canvas-bundle"))).toEqual(
        [],
      );
      expect(asarFiles).not.toContain("apps/desktop/ssh-runtime.tar.gz");
    });
  }
});
