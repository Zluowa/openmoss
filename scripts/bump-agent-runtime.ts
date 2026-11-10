// FILE: bump-agent-runtime.ts
// Purpose: One-command bump of the agent runtimes bundled in the Moss desktop app.
// Layer: Release/build script
//
//   bun run bump:codex <version|latest> [options]
//   bun run bump:claude <agent-sdk-version|latest> [options]
//
// Options:
//   --registry npmjs|npmmirror|<https url>   npm registry to download from (default npmjs).
//                                            Locks always record registry.npmjs.org; the bytes
//                                            are checked against the registry's sha512 integrity.
//   --crates-mirror crates-io|rsproxy|<url>  .crate download template with {name} and {version}.
//   --cache-dir <dir>                        download cache (default <repo>/.runtime-bump-cache).
//   --concurrency <n>                        parallel crate downloads (default 16).
//   --skip-gate                              do not run the release gate afterwards.
//
// The output depends only on the version and the upstream bytes: rerunning a bump rewrites the
// same files byte for byte (the committed Codex source archive is reused, not downloaded again).

import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { bumpBundledClaude, resolveLatestClaudeSdkVersion } from "./lib/runtime-bump/claude.ts";
import {
  bumpBundledCodex,
  CODEX_PINS_FILE,
  resolveLatestCodexVersion,
} from "./lib/runtime-bump/codex.ts";
import { resolveRegistry } from "./lib/runtime-bump/npm.ts";
import { formatFiles, type BumpContext } from "./lib/runtime-bump/shared.ts";

const REPO_ROOT = Path.resolve(import.meta.dirname, "..");

const CRATES_MIRRORS: Record<string, { download: string; index: string }> = {
  "crates-io": {
    download: "https://static.crates.io/crates/{name}/{name}-{version}.crate",
    index: "https://index.crates.io",
  },
  rsproxy: {
    download: "https://rsproxy.cn/api/v1/crates/{name}/{version}/download",
    index: "https://rsproxy.cn/index",
  },
};

const FORMATTED_FILES = [
  CODEX_PINS_FILE,
  "apps/desktop/package.json",
  "apps/server/package.json",
  "scripts/package.json",
  "scripts/desktop-stage-lock/package.json",
  "scripts/windows-native-payload-manifest.json",
];

function parseArgs(argv: readonly string[]) {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (key === "skip-gate") options.set(key, true);
    else options.set(key, inline ?? argv[++index] ?? "");
  }
  return { positional, options };
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "usage: node scripts/bump-agent-runtime.ts <codex|claude> <version|latest> [--registry npmjs|npmmirror|url] [--crates-mirror crates-io|rsproxy|url] [--cache-dir dir] [--concurrency n] [--skip-gate]\n" +
      "       node scripts/bump-agent-runtime.ts gate <codex|claude>",
  );
  process.exit(2);
}

function runGateProcess(runtime: "codex" | "claude", cacheDir: string): void {
  // A fresh process loads the pins just written.
  const result = spawnSync(process.execPath, [import.meta.filename, "gate", runtime], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, MOSS_RUNTIME_BUMP_CACHE: cacheDir },
  });
  if (result.status !== 0) {
    console.error(
      `\nThe ${runtime} gate failed; the working tree holds the regenerated files for review.`,
    );
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, value] = positional;
  if (command === "gate") {
    if (value !== "codex" && value !== "claude") usage("gate needs codex or claude");
    const { runBundledRuntimeGate } = await import("./lib/runtime-bump/gate.ts");
    await runBundledRuntimeGate(REPO_ROOT, value, (message) => console.log(message));
    return;
  }
  if (command !== "codex" && command !== "claude") usage();
  if (!value) usage("missing version");

  const mirrorOption = options.get("crates-mirror");
  const mirror =
    typeof mirrorOption === "string"
      ? (CRATES_MIRRORS[mirrorOption] ?? {
          download: mirrorOption,
          index: CRATES_MIRRORS["crates-io"]!.index,
        })
      : CRATES_MIRRORS["crates-io"]!;
  const cacheDir = Path.resolve(
    typeof options.get("cache-dir") === "string"
      ? (options.get("cache-dir") as string)
      : Path.join(REPO_ROOT, ".runtime-bump-cache"),
  );
  FS.mkdirSync(cacheDir, { recursive: true });
  const context: BumpContext = {
    repoRoot: REPO_ROOT,
    registry: resolveRegistry(options.get("registry") as string | undefined),
    cacheDir,
    cratesUrlTemplate: mirror.download,
    cratesIndexUrl: mirror.index,
    concurrency: Number(options.get("concurrency") ?? 16) || 16,
    log: (message) => console.log(message),
  };

  if (command === "codex") {
    const version = value === "latest" ? await resolveLatestCodexVersion(context) : value;
    const result = await bumpBundledCodex(context, version);
    formatFiles(REPO_ROOT, FORMATTED_FILES);
    console.log(
      `Codex ${result.previousVersion} -> ${result.version}: ${result.crateCount} crates, ${result.licenseTextCount} license texts in ${Path.relative(REPO_ROOT, result.bundleDirectory)}`,
    );
  } else {
    const version = value === "latest" ? await resolveLatestClaudeSdkVersion(context) : value;
    const result = await bumpBundledClaude(context, version);
    formatFiles(REPO_ROOT, FORMATTED_FILES);
    console.log(
      `Claude Code ${result.previous.code} -> ${result.codeVersion} (Agent SDK ${result.previous.sdk} -> ${result.sdkVersion})`,
    );
  }
  if (options.get("skip-gate") !== true) runGateProcess(command, cacheDir);
  console.log(
    "\nNext: review `git diff --stat`, then run the focused tests:\n" +
      "  bun run --cwd scripts test -- lib/bundled-codex-release-compliance.test.ts lib/bundled-claude-runtime.test.ts lib/desktop-stage-lock.test.ts lib/windows-native-payload-audit.test.mjs lib/runtime-bump",
  );
}

await main();
