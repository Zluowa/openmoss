// FILE: gate.ts
// Purpose: The checks a runtime bump must pass before review: compliance bundle, locks, native manifest, version probe.
// Layer: Release/build helper (agent runtime bumps)

import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { MOSS_BUNDLED_CODEX_VERSION } from "@moss/shared/codexRuntime";
import {
  BUNDLED_CLAUDE_AGENT_SDK_VERSION,
  BUNDLED_CLAUDE_CODE_VERSION,
} from "../bundled-claude-runtime.ts";
import { validateRepositoryBundledCodexComplianceBundle } from "../bundled-codex-release-compliance.ts";
import {
  assertDesktopStageInstallPackageMatches,
  createDesktopStageInstallPackageJson,
  DESKTOP_STAGE_LOCK_DIRECTORY,
} from "../desktop-stage-lock.ts";
import { findBunLockPackageEntry } from "./bun-lock.ts";

const readJson = (repoRoot: string, relative: string) =>
  JSON.parse(FS.readFileSync(Path.join(repoRoot, relative), "utf8")) as Record<string, any>;

function assertStageLock(repoRoot: string, packageName: string, version: string): void {
  const expected = createDesktopStageInstallPackageJson({
    rootPackageJson: readJson(repoRoot, "package.json"),
    serverPackageJson: readJson(repoRoot, "apps/server/package.json"),
    desktopPackageJson: readJson(repoRoot, "apps/desktop/package.json"),
  });
  assertDesktopStageInstallPackageMatches(
    readJson(repoRoot, `${DESKTOP_STAGE_LOCK_DIRECTORY}/package.json`),
    expected,
  );
  for (const lock of ["bun.lock", `${DESKTOP_STAGE_LOCK_DIRECTORY}/bun.lock`]) {
    const entry = findBunLockPackageEntry(
      FS.readFileSync(Path.join(repoRoot, lock), "utf8"),
      packageName,
    );
    if (!entry?.includes(`"${packageName}@${version}"`)) {
      throw new Error(`${lock} does not resolve ${packageName}@${version}.`);
    }
  }
}

function probeVersion(executable: string, expected: string, label: string): string {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 60_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !output.includes(expected)) {
    throw new Error(
      `${label} --version printed "${output}" (exit ${result.status}); expected ${expected}.`,
    );
  }
  return output;
}

/** The host-platform executable a bump extracted into its cache, when it exists. */
function extractedExecutable(
  cacheDir: string,
  folder: string,
  name: "codex" | "claude",
): string | null {
  const executable = Path.join(
    cacheDir,
    "extract",
    folder,
    process.platform === "win32" ? `${name}.exe` : name,
  );
  return FS.existsSync(executable) ? executable : null;
}

export async function runBundledRuntimeGate(
  repoRoot: string,
  runtime: "codex" | "claude",
  log: (message: string) => void,
): Promise<void> {
  const cacheDir =
    process.env.MOSS_RUNTIME_BUMP_CACHE ?? Path.join(repoRoot, ".runtime-bump-cache");
  if (runtime === "codex") {
    const validation = validateRepositoryBundledCodexComplianceBundle({
      repoRoot,
      expectedVersion: MOSS_BUNDLED_CODEX_VERSION,
    });
    log(
      `gate: Codex ${MOSS_BUNDLED_CODEX_VERSION} license bundle ok (${validation.componentCount} components, ${validation.licenseTextCount} license texts, ${validation.payloadFileCount} payload files, root ${validation.bundleRootSha256.slice(0, 12)})`,
    );
    const desktop = readJson(repoRoot, "apps/desktop/package.json");
    if (desktop.dependencies?.["@openai/codex"] !== MOSS_BUNDLED_CODEX_VERSION) {
      throw new Error("apps/desktop/package.json does not pin the bundled Codex version.");
    }
    assertStageLock(repoRoot, "@openai/codex", MOSS_BUNDLED_CODEX_VERSION);
    log("gate: desktop package, bun.lock and stage lock agree");
    const payloads = readJson(
      repoRoot,
      `third_party/openai-codex/${MOSS_BUNDLED_CODEX_VERSION}/PAYLOADS.json`,
    );
    const win = payloads.archives.find((archive: { id: string }) => archive.id === "win32-x64");
    const expected = win.files
      .filter(
        (file: { path: string }) =>
          file.path.startsWith("vendor/") && /\.(?:dll|exe|node|pdb)$/u.test(file.path),
      )
      .map(
        (file: { path: string; sha256: string }) =>
          `${file.path.replace(/^vendor\//u, "resources/codex-runtime/")} ${file.sha256} @openai/codex@${win.npmVersion}`,
      )
      .toSorted();
    const actual = readJson(repoRoot, "scripts/windows-native-payload-manifest.json")
      .windows.x64.preservedPayloads.filter((entry: { path: string }) =>
        entry.path.startsWith("resources/codex-runtime/"),
      )
      .map(
        (entry: { path: string; sha256: string; source: string }) =>
          `${entry.path} ${entry.sha256} ${entry.source}`,
      )
      .toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        "scripts/windows-native-payload-manifest.json does not match the Codex win32-x64 payload.",
      );
    }
    log(`gate: Windows native payload manifest binds ${expected.length} Codex files`);
    const executable = extractedExecutable(
      cacheDir,
      `codex-${MOSS_BUNDLED_CODEX_VERSION}-${process.platform}-${process.arch}`,
      "codex",
    );
    if (executable) {
      log(`gate: ${probeVersion(executable, MOSS_BUNDLED_CODEX_VERSION, "codex")}`);
    }
    return;
  }
  const server = readJson(repoRoot, "apps/server/package.json");
  if (
    server.dependencies?.["@anthropic-ai/claude-agent-sdk"] !== BUNDLED_CLAUDE_AGENT_SDK_VERSION
  ) {
    throw new Error("apps/server/package.json does not pin the bundled Claude Agent SDK.");
  }
  assertStageLock(repoRoot, "@anthropic-ai/claude-agent-sdk", BUNDLED_CLAUDE_AGENT_SDK_VERSION);
  log("gate: server package, bun.lock and stage lock agree");
  const entry = readJson(
    repoRoot,
    "scripts/windows-native-payload-manifest.json",
  ).windows.x64.preservedPayloads.find(
    (item: { path: string }) => item.path === "resources/claude-runtime/win32-x64/claude.exe",
  );
  if (
    entry?.source !== `@anthropic-ai/claude-agent-sdk-win32-x64@${BUNDLED_CLAUDE_AGENT_SDK_VERSION}`
  ) {
    throw new Error(
      "scripts/windows-native-payload-manifest.json does not name the bundled claude.exe.",
    );
  }
  const executable = extractedExecutable(
    cacheDir,
    `claude-${BUNDLED_CLAUDE_AGENT_SDK_VERSION}`,
    "claude",
  );
  if (executable) log(`gate: ${probeVersion(executable, BUNDLED_CLAUDE_CODE_VERSION, "claude")}`);
}
