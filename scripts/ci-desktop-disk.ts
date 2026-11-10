// Bound disk use in hosted Linux build jobs without removing live tools.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  MOSS_CANVAS_BUNDLE_DIR,
  MOSS_CANVAS_BUNDLE_RECEIPT,
  validateMossCanvasBundle,
} from "./lib/bundled-moss-canvas.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const CACHE_OWNER = ".moss-desktop-ci-owner.json";
export const BROWSER_DISK_RESERVE_BYTES = 2n * 1024n ** 3n;
export const PACKAGED_DISK_RESERVE_BYTES = 4n * 1024n ** 3n;

function exactDirectory(directory: string): string {
  const absolute = resolve(directory);
  if (
    !isAbsolute(directory) ||
    absolute === parse(absolute).root ||
    lstatSync(absolute).isSymbolicLink() ||
    !lstatSync(absolute).isDirectory() ||
    realpathSync(absolute) !== absolute
  ) {
    throw new Error(`Refusing noncanonical CI directory: ${directory}`);
  }
  return absolute;
}

export function desktopDiskContext(env: Environment, platform: string = process.platform) {
  const startup = env.GITHUB_JOB === "packaged_startup";
  const release =
    env.GITHUB_JOB === "build" &&
    (env.MOSS_CI_PACKAGED_PLATFORM !== undefined || env.MOSS_CI_PACKAGED_ARCH !== undefined);
  const packaged = startup || release;
  if (
    platform !== "linux" ||
    env.MOSS_CI_RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.RUNNER_OS !== "Linux" ||
    env.GITHUB_ACTIONS !== "true" ||
    (env.GITHUB_JOB !== "build" && !startup) ||
    (packaged &&
      (env.MOSS_CI_PACKAGED_PLATFORM !== "linux" || env.MOSS_CI_PACKAGED_ARCH !== "x64")) ||
    !/^\d+$/u.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")
  ) {
    throw new Error("Disk preparation is restricted to approved hosted Linux build jobs.");
  }
  const workspace = exactDirectory(env.GITHUB_WORKSPACE ?? "");
  const temporary = exactDirectory(env.RUNNER_TEMP ?? "");
  const cacheScope = release
    ? "moss-release-linux"
    : startup
      ? "moss-packaged-linux"
      : "moss-desktop";
  const cache = join(
    temporary,
    `${cacheScope}-canvas-npm-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
  if (env.npm_config_cache !== cache)
    throw new Error("Canvas npm cache must use its exact job path.");
  // Only the startup job builds Cua locally. Release downloads a verified artifact.
  const cargoCache = startup
    ? join(temporary, `moss-packaged-linux-cargo-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`)
    : undefined;
  if (cargoCache && env.CARGO_HOME !== cargoCache) {
    throw new Error("Cua Cargo cache must use its exact job path.");
  }
  return {
    workspace,
    temporary,
    cache,
    cargoCache,
    packaged,
    owner: JSON.stringify({
      workspace,
      run: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      ...(packaged ? { job: env.GITHUB_JOB, platform: "linux", arch: "x64" } : {}),
    }),
  };
}

type DiskContext = ReturnType<typeof desktopDiskContext>;

function initializeOwnedCache(context: DiskContext, cache: string): void {
  // An exclusive new directory marks ownership; never adopt an existing cache.
  exactDirectory(context.temporary);
  mkdirSync(cache);
  writeFileSync(join(cache, CACHE_OWNER), context.owner, { flag: "wx" });
}

export function initializeCanvasNpmCache(context: DiskContext): void {
  initializeOwnedCache(context, context.cache);
}

function ownedCache(context: DiskContext, directory: string): string {
  const cache = exactDirectory(directory);
  const marker = join(cache, CACHE_OWNER);
  if (
    !lstatSync(marker).isFile() ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf8") !== context.owner
  ) {
    throw new Error("Build cache ownership does not match this run.");
  }
  return cache;
}

function packagedCargoCache(context: DiskContext): string {
  if (!context.packaged || !context.cargoCache)
    throw new Error("Cargo cleanup requires the packaged Linux scope.");
  return context.cargoCache;
}

export function initializeCuaCargoCache(context: DiskContext): void {
  initializeOwnedCache(context, packagedCargoCache(context));
}

export function releaseCanvasBuildInputs(context: DiskContext): void {
  exactDirectory(context.workspace);
  const cache = ownedCache(context, context.cache);
  const source = exactDirectory(join(context.workspace, ".tmp/moss-canvas-source"));
  const dependencies = exactDirectory(join(source, "node_modules"));
  const bundle = join(context.workspace, MOSS_CANVAS_BUNDLE_DIR);
  const receipt = JSON.parse(readFileSync(join(bundle, MOSS_CANVAS_BUNDLE_RECEIPT), "utf8"));
  const validation = validateMossCanvasBundle(bundle);
  if (receipt.sha256 !== validation.sha256 || receipt.fileCount !== validation.fileCount) {
    throw new Error("Staged Canvas payload no longer matches its successful build receipt.");
  }
  // The allowlist is fixed, both real paths are checked before either removal,
  // and fs.rm removes nested symlinks themselves rather than following them.
  for (const target of [dependencies, cache]) rmSync(target, { recursive: true });
}

export function releaseCuaBuildCache(context: DiskContext, artifactDirectory: string): void {
  exactDirectory(context.workspace);
  const cache = ownedCache(context, packagedCargoCache(context));
  const artifact = exactDirectory(join(context.temporary, "cua-verified"));
  if (artifactDirectory !== artifact)
    throw new Error("Cua cleanup requires this job's exact verified artifact.");
  const read = (relative: string): Buffer => {
    const path = join(artifact, relative);
    if (
      lstatSync(path).isSymbolicLink() ||
      !lstatSync(path).isFile() ||
      realpathSync(path) !== path
    ) {
      throw new Error("Cua artifact files must remain canonical regular files.");
    }
    return readFileSync(path);
  };
  // Reuse the production validator; no second definition of Cua provenance.
  const validators = createRequire(import.meta.url)(
    "../apps/desktop/scripts/cua-artifact-provenance.mjs",
  );
  const release = JSON.parse(
    readFileSync(join(context.workspace, "packages/shared/src/cuaDriverRelease.json"), "utf8"),
  );
  const provenance = JSON.parse(read("provenance.json").toString("utf8"));
  if (provenance.patched !== true)
    throw new Error("Cua cleanup requires the verified patched Linux artifact.");
  const binary = read("cua-driver");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  validators.assertLinuxCuaBinaryIdentity(binary, ["x64"]);
  validators.assertCuaArtifactProvenance({
    provenance,
    release,
    platform: "linux",
    architectures: ["x64"],
    binarySha256: digest(binary),
  });
  validators.assertLinuxCuaSidecarChecksums(
    provenance,
    Object.fromEntries(
      (validators.LINUX_CUA_SIDECAR_PATHS as readonly string[]).map((path) => [
        path,
        digest(read(path)),
      ]),
    ),
  );
  rmSync(cache, { recursive: true });
}

function reportDisk(context: DiskContext, stage: string): void {
  console.log(`[desktop-ci-disk] ${stage}`);
  const directories = [
    context.workspace,
    join(context.workspace, "node_modules"),
    join(context.workspace, ".turbo"),
    join(context.workspace, ".tmp/moss-canvas-source"),
    join(context.workspace, MOSS_CANVAS_BUNDLE_DIR),
    join(context.workspace, "apps/desktop/dist-electron"),
    join(context.workspace, "apps/server/dist"),
    join(homedir(), ".bun/install/cache"),
    join(homedir(), ".npm"),
    join(homedir(), ".cache/electron"),
    join(homedir(), ".cache/ms-playwright"),
    context.cache,
    context.cargoCache,
    join(context.temporary, "cua-artifact"),
    join(context.temporary, "cua-verified"),
  ].filter((directory): directory is string => !!directory && existsSync(directory));
  // Separate du calls avoid suppressing nested paths already counted by a parent.
  // The entire diagnostic, rather than each individual directory, gets 30s.
  const deadline = Date.now() + 30_000;
  for (const [command, args] of [
    ["df", ["-Pk", context.workspace, context.temporary, ...(context.packaged ? [tmpdir()] : [])]],
    ...directories.map((directory) => ["du", ["-sk", directory]] as const),
  ] as const) {
    const result = spawnSync(command, args, {
      stdio: "inherit",
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (result.error || result.status !== 0)
      throw new Error(`Disk diagnostic failed: ${command}`, { cause: result.error });
  }
}

export function requirePackagedDiskSpace(availableBytes: bigint): void {
  // A distinct operational reserve for staging/unpacked/AppImage copies and
  // archive output. The failing run had no measurements of its actual peak.
  if (availableBytes < PACKAGED_DISK_RESERVE_BYTES) {
    throw new Error(
      `Linux package build requires a 4 GiB disk reserve; available ${availableBytes} bytes.`,
    );
  }
}

export function requireBrowserDiskSpace(availableBytes: bigint): void {
  // An operational reserve for browser archive/extraction and worker logs,
  // not a claim that the whole job's unmeasured peak is only 2 GiB.
  if (availableBytes < BROWSER_DISK_RESERVE_BYTES) {
    throw new Error(
      `Browser install requires a 2 GiB disk reserve; available ${availableBytes} bytes.`,
    );
  }
}

if (import.meta.main) {
  const context = desktopDiskContext(process.env);
  const operation = process.argv[2];
  if (operation === "initialize") {
    reportDisk(context, "after-workspace-setup");
    initializeCanvasNpmCache(context);
  } else if (operation === "release-canvas") {
    reportDisk(context, "after-canvas-build-before-cleanup");
    releaseCanvasBuildInputs(context);
    reportDisk(context, "after-canvas-cleanup");
  } else if (operation === "browser-preflight") {
    reportDisk(context, "after-desktop-build-before-browser");
    const stats = statfsSync(context.workspace, { bigint: true });
    requireBrowserDiskSpace(stats.bavail * stats.bsize);
  } else if (operation === "initialize-cua") {
    initializeCuaCargoCache(context);
  } else if (operation === "release-cua") {
    reportDisk(context, "after-cua-provision-before-cleanup");
    releaseCuaBuildCache(context, process.env.MOSS_CUA_ARTIFACT_DIR ?? "");
    reportDisk(context, "after-cua-cache-cleanup");
  } else if (operation === "package-preflight") {
    if (!context.packaged)
      throw new Error("Package preflight requires a hosted Linux x64 package.");
    reportDisk(context, "before-linux-package-build");
    // electron-builder writes its stage and squashfs image under the OS temp
    // directory before the finished files are copied into the workspace.
    for (const directory of [tmpdir(), context.workspace]) {
      const stats = statfsSync(directory, { bigint: true });
      requirePackagedDiskSpace(stats.bavail * stats.bsize);
    }
  } else if (operation === "report") {
    reportDisk(context, "after-checkout");
  } else {
    throw new Error(`Unknown Desktop disk operation: ${operation}`);
  }
}
