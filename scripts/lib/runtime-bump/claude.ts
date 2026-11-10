// FILE: claude.ts
// Purpose: Moves the bundled Claude Code runtime (Claude Agent SDK platform packages) to one version.
// Layer: Release/build helper (agent runtime bumps)

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import type { NpmVersionDocument } from "./bun-lock.ts";
import { downloadNpmTarball, fetchDistTags, fetchVersionDocument } from "./npm.ts";
import {
  addChangelogLine,
  replaceVersionLiterals,
  prepareBunLockRewrites,
  updateWindowsNativeManifest,
  type BumpContext,
} from "./shared.ts";
import { readTarFile } from "./tar.ts";

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Platform packages Moss stages into `claude-runtime/<folder>` (see bundled-claude-runtime.ts). */
const BUNDLED_TARGETS = [
  { suffix: "darwin-arm64", executable: "claude" },
  { suffix: "darwin-x64", executable: "claude" },
  { suffix: "linux-arm64", executable: "claude" },
  { suffix: "linux-x64", executable: "claude" },
  { suffix: "win32-arm64", executable: "claude.exe" },
  { suffix: "win32-x64", executable: "claude.exe" },
] as const;

/** Files holding the Agent SDK or Claude Code version as a literal, rewritten on every bump. */
export const CLAUDE_VERSION_LITERAL_FILES = [
  "apps/desktop/src/bundledClaude.test.ts",
  "apps/desktop/src/bundledClaude.ts",
  "apps/server/package.json",
  "scripts/desktop-stage-lock/package.json",
  "scripts/lib/bundled-claude-runtime.test.ts",
  "scripts/lib/bundled-claude-runtime.ts",
  "scripts/package.json",
] as const;

function currentVersions(repoRoot: string): { sdk: string; code: string } {
  const text = FS.readFileSync(
    Path.join(repoRoot, "scripts/lib/bundled-claude-runtime.ts"),
    "utf8",
  );
  const sdk = /BUNDLED_CLAUDE_AGENT_SDK_VERSION = "([^"]+)"/u.exec(text)?.[1];
  const code = /BUNDLED_CLAUDE_CODE_VERSION = "([^"]+)"/u.exec(text)?.[1];
  if (!sdk || !code)
    throw new Error("bundled-claude-runtime.ts no longer pins both Claude versions.");
  return { sdk, code };
}

export async function resolveLatestClaudeSdkVersion(context: BumpContext): Promise<string> {
  const tags = await fetchDistTags(context.registry, CLAUDE_SDK_PACKAGE);
  if (!tags.latest) throw new Error(`${CLAUDE_SDK_PACKAGE} has no latest dist-tag.`);
  return tags.latest;
}

export interface ClaudeBumpResult {
  readonly sdkVersion: string;
  readonly codeVersion: string;
  readonly previous: { readonly sdk: string; readonly code: string };
  readonly hostExecutable: string | null;
}

export async function bumpBundledClaude(
  context: BumpContext,
  sdkVersion: string,
): Promise<ClaudeBumpResult> {
  const { repoRoot, log } = context;
  const previous = currentVersions(repoRoot);
  const main = await fetchVersionDocument(context.registry, CLAUDE_SDK_PACKAGE, sdkVersion);
  const codeVersion = main.claudeCodeVersion;
  if (typeof codeVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(codeVersion)) {
    throw new Error(`${CLAUDE_SDK_PACKAGE}@${sdkVersion} does not state its claudeCodeVersion.`);
  }
  log(
    `Claude Code ${previous.code} (SDK ${previous.sdk}) -> ${codeVersion} (SDK ${sdkVersion}), registry ${context.registry}`,
  );

  const platformNames = Object.keys(main.optionalDependencies ?? {}).toSorted();
  for (const target of BUNDLED_TARGETS) {
    if (!platformNames.includes(`${CLAUDE_SDK_PACKAGE}-${target.suffix}`)) {
      throw new Error(`${CLAUDE_SDK_PACKAGE}@${sdkVersion} no longer ships ${target.suffix}.`);
    }
  }
  const documents = new Map<string, NpmVersionDocument>([[CLAUDE_SDK_PACKAGE, main]]);
  for (const name of platformNames) {
    if (main.optionalDependencies![name] !== sdkVersion) {
      throw new Error(
        `${CLAUDE_SDK_PACKAGE}@${sdkVersion} pins ${name}@${main.optionalDependencies![name]}.`,
      );
    }
    documents.set(name, await fetchVersionDocument(context.registry, name, sdkVersion));
  }

  // Download and integrity-check every bundled platform payload; hash the Windows executable.
  let windowsSha256: string | null = null;
  let hostExecutable: string | null = null;
  const hostSuffix = `${process.platform}-${process.arch}`;
  for (const target of BUNDLED_TARGETS) {
    const document = documents.get(`${CLAUDE_SDK_PACKAGE}-${target.suffix}`)!;
    log(`  npm ${document.name}@${document.version}`);
    const file = await downloadNpmTarball({ document, cacheDir: context.cacheDir });
    const entryPath = `package/${target.executable}`;
    let found = false;
    const hash = Crypto.createHash("sha256");
    const keep = target.suffix === hostSuffix;
    const parts: Buffer[] = [];
    await readTarFile(file.path, {
      entry: (header) => {
        if (header.path !== entryPath || header.type !== "file") return null;
        found = true;
        return {
          chunk: (bytes) => {
            hash.update(bytes);
            if (keep) parts.push(Buffer.from(bytes));
          },
          end: () => {},
        };
      },
    });
    if (!found) throw new Error(`${document.name}@${sdkVersion} has no ${target.executable}.`);
    const sha256 = hash.digest("hex");
    if (target.suffix === "win32-x64") windowsSha256 = sha256;
    if (keep) {
      hostExecutable = Path.join(
        context.cacheDir,
        "extract",
        `claude-${sdkVersion}`,
        target.executable,
      );
      FS.mkdirSync(Path.dirname(hostExecutable), { recursive: true });
      FS.writeFileSync(hostExecutable, Buffer.concat(parts), { mode: 0o755 });
    }
  }

  // Validate the lock rewrite before any file changes.
  const writeBunLocks = await prepareBunLockRewrites(context, {
    packageName: CLAUDE_SDK_PACKAGE,
    previousVersion: previous.sdk,
    version: sdkVersion,
    documents,
    fetchPrevious: (key) => fetchVersionDocument(context.registry, key, previous.sdk),
  });
  if (previous.sdk !== sdkVersion) {
    replaceVersionLiterals(repoRoot, CLAUDE_VERSION_LITERAL_FILES, previous.sdk, sdkVersion, log);
  }
  if (previous.code !== codeVersion) {
    replaceVersionLiterals(repoRoot, CLAUDE_VERSION_LITERAL_FILES, previous.code, codeVersion, log);
  }
  writeBunLocks();
  updateWindowsNativeManifest(repoRoot, {
    pathPrefix: "resources/claude-runtime/win32-x64/",
    sourcePrefix: `${CLAUDE_SDK_PACKAGE}-win32-x64@`,
    entries: [
      {
        path: "resources/claude-runtime/win32-x64/claude.exe",
        sha256: windowsSha256!,
        source: `${CLAUDE_SDK_PACKAGE}-win32-x64@${sdkVersion}`,
      },
    ],
  });
  if (previous.sdk !== sdkVersion) {
    addChangelogLine(
      repoRoot,
      `Updated the Claude runtime shipped with the Moss desktop app from Claude Code ${previous.code} (Agent SDK ${previous.sdk}) to Claude Code ${codeVersion} (Agent SDK ${sdkVersion}).`,
    );
  }
  return { sdkVersion, codeVersion, previous, hostExecutable };
}
