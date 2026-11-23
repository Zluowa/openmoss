import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findAsarNode, packAsar, readAsarArchive } from "@moss/shared/asarArchive";

import {
  computeDesktopAsarBaseCacheKey,
  createAsarMainPackageJsonBuffer,
  preparePrepackedAsarFromCache,
  resolveDesktopAsarCacheDir,
  saveDesktopAsarToCache,
} from "./desktop-asar-cache.ts";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function freshDir(): string {
  root = mkdtempSync(Path.join(tmpdir(), "moss-asar-cache-test-"));
  return root;
}

async function readAsarEntryUtf8(archivePath: string, entryPath: string): Promise<string> {
  const archive = await readAsarArchive(archivePath);
  const node = findAsarNode(archive.header, entryPath);
  if (!node || "files" in node || "link" in node || node.offset === undefined) {
    throw new Error(`Missing file entry ${entryPath}`);
  }
  const handle = await open(archivePath, "r");
  try {
    const buffer = Buffer.alloc(node.size);
    await handle.read(buffer, 0, node.size, archive.dataStart + Number(node.offset));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

describe("desktop-asar-cache", () => {
  it("resolves env var and strips build/devDependencies from packaged package.json", () => {
    expect(resolveDesktopAsarCacheDir({})).toBeUndefined();
    expect(resolveDesktopAsarCacheDir({ MOSS_DESKTOP_ASAR_CACHE: "  " })).toBeUndefined();
    expect(resolveDesktopAsarCacheDir({ MOSS_DESKTOP_ASAR_CACHE: "asar-dir" })).toMatch(
      /asar-dir$/u,
    );

    const serialized = createAsarMainPackageJsonBuffer({
      name: "moss-desktop",
      version: "1.0.15",
      mossCommitHash: "abc123",
      main: "apps/desktop/dist-electron/boot.js",
      build: { appId: "com.moss" },
      devDependencies: { electron: "43.8.1" },
      dependencies: { ws: "8.21.0" },
    }).toString("utf8");
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.version).toBe("1.0.15");
    expect(parsed.mossCommitHash).toBe("abc123");
    expect(parsed.build).toBeUndefined();
    expect(parsed.devDependencies).toBeUndefined();
    expect(parsed.dependencies).toEqual({ ws: "8.21.0" });
  });

  it("changes base cache key when resources change, but stays stable when only app dist changes", async () => {
    const dir = freshDir();
    const stage = Path.join(dir, "stage");
    mkdirSync(Path.join(stage, "apps/desktop/dist-electron"), { recursive: true });
    mkdirSync(Path.join(stage, "apps/server/dist"), { recursive: true });
    mkdirSync(Path.join(stage, "apps/desktop/resources"), { recursive: true });
    writeFileSync(Path.join(stage, "apps/desktop/dist-electron/main.js"), "v1");
    writeFileSync(Path.join(stage, "apps/server/dist/index.mjs"), "v1");
    writeFileSync(Path.join(stage, "apps/desktop/resources/public.json"), '{"v":1}');

    const keyInput = {
      stageAppDir: stage,
      platform: "win",
      arch: "x64",
      electronVersion: "43.8.1",
      agentRuntimes: "bundled",
      stageDepsCacheKey: "deps-key-1",
      filesPatterns: ["**/*"],
      asarUnpackPatterns: ["node_modules/node-pty/**"],
    };
    const k1 = await computeDesktopAsarBaseCacheKey(keyInput);

    // Changing only compiled app code keeps the base key stable (spliced on restore).
    writeFileSync(Path.join(stage, "apps/desktop/dist-electron/main.js"), "v2");
    writeFileSync(Path.join(stage, "apps/server/dist/index.mjs"), "v2");
    const k2 = await computeDesktopAsarBaseCacheKey(keyInput);
    expect(k2).toBe(k1);

    // Changing any staged resource invalidates the base cache key immediately.
    writeFileSync(Path.join(stage, "apps/desktop/resources/public.json"), '{"v":2}');
    const k3 = await computeDesktopAsarBaseCacheKey(keyInput);
    expect(k3).not.toBe(k1);
  });

  it("saves a packaged app.asar + unpacked dir and splices updated code & package.json on hit", async () => {
    const dir = freshDir();
    const cacheDir = Path.join(dir, "cache");

    // Build an initial base app.asar + app.asar.unpacked simulating a cold electron-builder run.
    const baseTree = Path.join(dir, "base-tree");
    mkdirSync(Path.join(baseTree, "node_modules/ws"), { recursive: true });
    mkdirSync(Path.join(baseTree, "apps/desktop/dist-electron"), { recursive: true });
    mkdirSync(Path.join(baseTree, "apps/server/dist"), { recursive: true });
    writeFileSync(Path.join(baseTree, "node_modules/ws/index.js"), "unchanged-dep");
    writeFileSync(Path.join(baseTree, "apps/desktop/dist-electron/boot.js"), "old-boot");
    writeFileSync(Path.join(baseTree, "apps/server/dist/index.mjs"), "old-server");
    writeFileSync(
      Path.join(baseTree, "package.json"),
      JSON.stringify({ name: "moss-desktop", version: "1.0.14" }, null, 2),
    );

    const resourcesDir = Path.join(dir, "win-unpacked/resources");
    mkdirSync(Path.join(resourcesDir, "app.asar.unpacked/node_modules/node-pty"), {
      recursive: true,
    });
    writeFileSync(
      Path.join(resourcesDir, "app.asar.unpacked/node_modules/node-pty/pty.node"),
      "native-pty",
    );
    await packAsar({
      output: Path.join(resourcesDir, "app.asar"),
      directories: {
        node_modules: Path.join(baseTree, "node_modules"),
        apps: Path.join(baseTree, "apps"),
      },
      files: {
        "package.json": Buffer.from(
          JSON.stringify({ name: "moss-desktop", version: "1.0.14" }, null, 2),
        ),
      },
    });

    // Next build stage has updated compiled code + updated version metadata.
    const stage2 = Path.join(dir, "stage2");
    mkdirSync(Path.join(stage2, "apps/desktop/dist-electron"), { recursive: true });
    mkdirSync(Path.join(stage2, "apps/server/dist"), { recursive: true });
    writeFileSync(Path.join(stage2, "apps/desktop/dist-electron/boot.js"), "new-boot-v2");
    writeFileSync(Path.join(stage2, "apps/server/dist/index.mjs"), "new-server-v2");

    const cacheKey = await computeDesktopAsarBaseCacheKey({
      stageAppDir: stage2,
      platform: "win",
      arch: "x64",
      electronVersion: "43.8.1",
      agentRuntimes: "bundled",
      stageDepsCacheKey: "deps-1",
      filesPatterns: ["**/*"],
      asarUnpackPatterns: ["node_modules/node-pty/**"],
    });

    const saved = await saveDesktopAsarToCache({
      cacheDir,
      cacheKey,
      packagedResourcesDir: resourcesDir,
    });
    expect(saved).toEqual({ saved: true, pruned: 0 });

    const prepared = await preparePrepackedAsarFromCache({
      cacheDir,
      cacheKey,
      stageAppDir: stage2,
      stagePackageJson: {
        name: "moss-desktop",
        version: "1.0.15",
        mossCommitHash: "deadbeef",
        build: { appId: "stripped" },
        devDependencies: { electron: "43.8.1" },
      },
    });
    expect(prepared.hit).toBe(true);
    expect(existsSync(Path.join(stage2, "app.asar"))).toBe(true);
    expect(existsSync(Path.join(stage2, "prepacked-app/app.asar"))).toBe(true);
    expect(
      readFileSync(
        Path.join(stage2, "prepacked-app/app.asar.unpacked/node_modules/node-pty/pty.node"),
        "utf8",
      ),
    ).toBe("native-pty");

    const prepackedAsar = Path.join(stage2, "prepacked-app/app.asar");
    expect(await readAsarEntryUtf8(prepackedAsar, "node_modules/ws/index.js")).toBe(
      "unchanged-dep",
    );
    expect(await readAsarEntryUtf8(prepackedAsar, "apps/desktop/dist-electron/boot.js")).toBe(
      "new-boot-v2",
    );
    expect(await readAsarEntryUtf8(prepackedAsar, "apps/server/dist/index.mjs")).toBe(
      "new-server-v2",
    );
    const pkgInside = JSON.parse(await readAsarEntryUtf8(prepackedAsar, "package.json")) as Record<
      string,
      unknown
    >;
    expect(pkgInside.version).toBe("1.0.15");
    expect(pkgInside.mossCommitHash).toBe("deadbeef");
    expect(pkgInside.build).toBeUndefined();
  });
});
