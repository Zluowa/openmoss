// Builds a code update from a built checkout: the app code only (desktop main and preloads, the
// server bundle with the web client), packed into one archive, compressed, with its manifest.
// Nothing is uploaded. Signing uses a key file given on the command line (a test key in the
// prototype; the release key is the lead's step). It does not build: run `bun run build:desktop`
// in the checkout first.
//
//   bun scripts/build-code-update.ts --repo <checkout after build:desktop, HEAD = the commit>
//        --out <dir> [--channel preview|desktop]
//        [--shell <shell commit>]…                 installed shells the package may run on
//        [--base-archive <shell app.asar | packaged app folder>]   a shell at hand: its commit
//                                                  joins --shell, and the package is applied
//                                                  onto it to record the result hash
//        [--apply-to <packaged app folder>]       a COPY of that shell: its resources/app.asar
//                                                  is replaced by the applied result (for a smoke)
//        [--previous-result <result.json>]         exit 4 when the code is the same as that run's
//        [--sign | --sign-key-file <base64 PKCS#8 Ed25519>] [--sequence <n>] [--level <zstd, default 9>]
//        --sign reads MOSS_UPDATE_MIRROR_SIGNING_KEY as the mirror sync does (the environment or the
//        update-mirror settings folders), so no second copy of the release key is written to a file.
//
// Output (the hosting layout, CODE-UPDATES.md §3 and §5), and a result file for pipelines:
//   <out>/desktop/code/v1/moss-code-<commit12>-<sha16>.asar.zst
//   <out>/<channel>/code/latest.json (+ latest.json.sig when a key is given)
//   <out>/result.json  {decision, commit, shells, refusals, package, codeSha256, ms}
//
// Exit 0 package written; 3 full installer needed (no shell can take the commit; reasons in
// result.json); 4 unchanged (same code as --previous-result: nothing to publish); 1 error.
// Design: D:\ceshi\moss-codex-handoff\rounds\20261117-owner-test\CODE-UPDATES.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { packAsar, readAsarArchive, walkAsarFiles } from "@moss/shared/asarArchive";
import {
  applyCodeUpdate,
  CODE_UPDATE_CHANNELS,
  CODE_UPDATE_IDENTITY_PATH,
  codeUpdateManifestPath,
  codeUpdatePackagePath,
  parseCodeUpdateManifest,
  readArchiveCommit,
  sha256OfPath,
  signCodeUpdateManifest,
  type CodeUpdateChannel,
  type CodeUpdateManifest,
} from "@moss/shared/codeUpdate";

import {
  classifyCodeUpdateChanges,
  MIGRATIONS_SOURCE,
  readMigrationLevels,
} from "./lib/code-update-policy.ts";
import { LOCAL_SETTINGS_FILES, resolveUpdateMirrorStores } from "./lib/update-mirror-stores.ts";
import { resolveUpdateMirrorSigningKey } from "./sync-update-mirror.ts";

/** The signing key: from a file, or from the mirror settings; null when not signing. */
export async function resolveCodeUpdateSigningKey(input: {
  readonly sign: boolean;
  readonly signKeyFile: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): Promise<string | null> {
  if (input.sign && input.signKeyFile) throw new Error("give --sign or --sign-key-file, not both");
  if (input.signKeyFile) return (await readFile(path.resolve(input.signKeyFile), "utf8")).trim();
  if (!input.sign) return null;
  const { stores } = await resolveUpdateMirrorStores({
    env: input.env,
    homeDirectory: input.homeDirectory,
    files: LOCAL_SETTINGS_FILES,
  });
  return resolveUpdateMirrorSigningKey(stores);
}

const log = (line: string) => console.log(`[code-update] ${line}`);

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitShowOrNull(repo: string, spec: string): string | null {
  const result = spawnSync("git", ["-C", repo, "show", spec], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

/** Precompressed copies of the web client: the server serves the plain file when one is missing. */
export const isCodeUpdateSkippedPath = (archivePath: string) =>
  archivePath.startsWith("apps/server/dist/client/") && /\.(?:gz|br)$/u.test(archivePath);

export interface ShellDecision {
  readonly shell: string;
  readonly refusals: ReadonlyArray<{ path: string; reason: string }>;
}

export function decideShells(repo: string, commit: string, shells: ReadonlyArray<string>) {
  return shells.map((shell): ShellDecision => {
    const changed = git(repo, "diff", "--name-only", `${shell}..${commit}`)
      .split("\n")
      .filter(Boolean);
    return {
      shell,
      refusals: classifyCodeUpdateChanges(changed, (file) => ({
        before: gitShowOrNull(repo, `${shell}:${file}`),
        after: gitShowOrNull(repo, `${commit}:${file}`),
      })),
    };
  });
}

export type CodeUpdateDecision = "code-update" | "full-installer" | "unchanged";

/** Hash of the code alone (paths and file hashes, identity file excluded): equal = nothing changed. */
export async function codeContentSha256(codeArchive: string): Promise<string> {
  const parsed = await readAsarArchive(codeArchive);
  const rows: Array<[string, string]> = [];
  for (const { path: archivePath, entry } of walkAsarFiles(parsed.header)) {
    if (archivePath === CODE_UPDATE_IDENTITY_PATH || !("integrity" in entry)) continue;
    rows.push([archivePath, entry.integrity?.hash ?? ""]);
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** A packaged app folder or an archive path -> the archive. */
async function resolveArchive(input: string): Promise<string> {
  const resolved = path.resolve(input);
  const info = await stat(resolved);
  return info.isDirectory() ? path.join(resolved, "resources", "app.asar") : resolved;
}

function refuseInstalledLocation(folder: string): void {
  const lower = path.resolve(folder).toLowerCase();
  const programs = path.join(process.env.LOCALAPPDATA ?? "", "Programs").toLowerCase();
  if (
    (process.env.LOCALAPPDATA && lower.startsWith(programs)) ||
    lower.includes(`${path.sep}program files`) ||
    lower.startsWith("/applications")
  ) {
    throw new Error(`--apply-to must be a copy of the shell, not an installed app: ${folder}`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      channel: { type: "string", default: "preview" },
      shell: { type: "string", multiple: true },
      "base-archive": { type: "string" },
      "apply-to": { type: "string" },
      "previous-result": { type: "string" },
      sign: { type: "boolean", default: false },
      "sign-key-file": { type: "string" },
      sequence: { type: "string" },
      level: { type: "string", default: "9" },
      out: { type: "string" },
    },
  });
  const repo = path.resolve(values.repo ?? ".");
  const out = values.out ? path.resolve(values.out) : null;
  const channel = values.channel as CodeUpdateChannel;
  if (!out) throw new Error("--out is required");
  if (!CODE_UPDATE_CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}`);
  await mkdir(out, { recursive: true });
  const started = performance.now();
  const ms: Record<string, number> = {};
  const lap = (name: string, since: number) => (ms[name] = Math.round(performance.now() - since));
  const result: Record<string, unknown> = { ms };
  const finish = async (code: number, decision: CodeUpdateDecision | "error") => {
    result.decision = decision;
    ms.total = Math.round(performance.now() - started);
    await writeFile(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    return code;
  };

  const commit = git(repo, "rev-parse", "HEAD");
  result.commit = commit;
  if (git(repo, "status", "--porcelain", "--untracked-files=no") !== "") {
    throw new Error("the checkout has uncommitted changes: the package would not be this commit");
  }
  const shellCommits = (values.shell ?? []).map((shell) => git(repo, "rev-parse", shell));
  const baseArchive = values["base-archive"] ? await resolveArchive(values["base-archive"]) : null;
  const baseCommit = baseArchive ? await readArchiveCommit(baseArchive) : null;
  if (baseArchive && !baseCommit) throw new Error(`${baseArchive} names no commit`);
  if (baseCommit && !shellCommits.includes(baseCommit)) shellCommits.push(baseCommit);
  if (shellCommits.length === 0) throw new Error("give at least one --shell or --base-archive");
  const applyTo = values["apply-to"] ? path.resolve(values["apply-to"]) : null;
  if (applyTo) {
    if (!baseArchive) throw new Error("--apply-to needs --base-archive (the shell it copies)");
    refuseInstalledLocation(applyTo);
    if ((await readArchiveCommit(path.join(applyTo, "resources", "app.asar"))) !== baseCommit) {
      throw new Error(`--apply-to ${applyTo} is not a copy of the --base-archive shell`);
    }
  }

  // 1. The rule.
  let since = performance.now();
  const decisions = decideShells(repo, commit, shellCommits);
  lap("policy", since);
  result.refusals = Object.fromEntries(decisions.map((d) => [d.shell, d.refusals]));
  for (const decision of decisions) {
    log(
      `shell ${decision.shell.slice(0, 12)}: ${decision.refusals.length === 0 ? "code update" : "full installer needed"}`,
    );
    for (const refusal of decision.refusals) log(`  ${refusal.path}: ${refusal.reason}`);
  }
  const shells = decisions.filter((d) => d.refusals.length === 0).map((d) => d.shell);
  result.shells = shells;
  if (shells.length === 0) return finish(3, "full-installer");

  // 2. The package.
  for (const required of [
    "apps/desktop/dist-electron/boot.js",
    "apps/desktop/dist-electron/main.js",
    "apps/server/dist/index.mjs",
  ]) {
    await stat(path.join(repo, required)).catch(() => {
      throw new Error(`${required} is missing: run \`bun run build:desktop\` first`);
    });
  }
  const migrations = readMigrationLevels(
    await readFile(path.join(repo, MIGRATIONS_SOURCE), "utf8"),
  );
  if (!migrations) throw new Error(`could not read the migration list in ${MIGRATIONS_SOURCE}`);
  const desktopVersion = (
    JSON.parse(await readFile(path.join(repo, "apps/desktop/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const codeVersion = `${desktopVersion}+${commit.slice(0, 9)}`;
  const work = await mkdtemp(path.join(tmpdir(), "moss-code-update-"));
  try {
    const codeArchive = path.join(work, "code.asar");
    since = performance.now();
    const packed = await packAsar({
      output: codeArchive,
      directories: {
        "apps/desktop/dist-electron": path.join(repo, "apps/desktop/dist-electron"),
        "apps/server/dist": path.join(repo, "apps/server/dist"),
      },
      files: {
        [CODE_UPDATE_IDENTITY_PATH]: Buffer.from(
          `${JSON.stringify({ commit, codeVersion })}\n`,
          "utf8",
        ),
      },
      skip: (archivePath) =>
        isCodeUpdateSkippedPath(archivePath) || archivePath === CODE_UPDATE_IDENTITY_PATH,
    });
    lap("pack", since);
    const codeSha256 = await codeContentSha256(codeArchive);
    result.codeSha256 = codeSha256;
    if (values["previous-result"]) {
      const previous = JSON.parse(
        await readFile(path.resolve(values["previous-result"]), "utf8"),
      ) as { codeSha256?: unknown };
      if (previous.codeSha256 === codeSha256) {
        log("unchanged: the code is the same as the previous run's; nothing to publish");
        return finish(4, "unchanged");
      }
    }
    const archiveBytes = await readFile(codeArchive);
    since = performance.now();
    const compressed = zstdCompressSync(archiveBytes, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: Number(values.level) },
    });
    lap("compress", since);
    const sha256 = createHash("sha256").update(compressed).digest("hex");
    const packagePath = codeUpdatePackagePath(commit, sha256);
    await mkdir(path.dirname(path.join(out, packagePath)), { recursive: true });
    await writeFile(path.join(out, packagePath), compressed);
    result.package = {
      path: packagePath,
      file: path.join(out, packagePath),
      bytes: compressed.length,
      sha256,
      archiveBytes: archiveBytes.length,
      files: packed.files,
    };
    log(
      `package ${packagePath}: ${packed.files} files, archive ${archiveBytes.length} bytes, zstd-${values.level} ${compressed.length} bytes (pack ${ms.pack} ms, compress ${ms.compress} ms)`,
    );

    const manifest: CodeUpdateManifest = {
      schema: 1,
      channel,
      sequence: values.sequence
        ? Number(values.sequence)
        : Number(git(repo, "log", "-1", "--format=%ct", commit)),
      commit,
      codeVersion,
      shells,
      package: {
        path: packagePath,
        size: compressed.length,
        sha256,
        archiveSize: archiveBytes.length,
        archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      },
      migrations,
      results: {},
    };

    // 3. The result on a shell at hand: the same apply step a client runs.
    if (baseArchive && baseCommit && shells.includes(baseCommit)) {
      const store = path.join(work, "store");
      since = performance.now();
      const applied = await applyCodeUpdate({
        manifest,
        packageFile: path.join(out, packagePath),
        installedArchive: baseArchive,
        shellCommit: baseCommit,
        storeDir: store,
      });
      lap("apply", since);
      (manifest.results as Record<string, string>)[await sha256OfPath(baseArchive)] =
        applied.installed.archiveSha256;
      log(
        `applied onto ${baseCommit.slice(0, 12)} in ${(applied.totalMs / 1000).toFixed(1)} s (unpack ${(applied.unpackMs / 1000).toFixed(1)}, splice ${(applied.spliceMs / 1000).toFixed(1)}): archive ${applied.installed.archiveSize} bytes`,
      );
      if (applyTo) {
        const target = path.join(applyTo, "resources", "app.asar");
        await copyFile(path.join(store, applied.installed.id, "app.asar"), `${target}.code-update`);
        await rename(`${target}.code-update`, target);
        result.appliedTo = target;
        log(`wrote the applied archive to ${target}`);
      }
    } else if (applyTo) {
      throw new Error("--apply-to: the base shell cannot take this commit");
    }

    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    if (!parseCodeUpdateManifest(manifestText)) throw new Error("the manifest does not validate");
    const manifestFile = path.join(out, codeUpdateManifestPath(channel));
    await mkdir(path.dirname(manifestFile), { recursive: true });
    await writeFile(manifestFile, manifestText);
    result.manifest = manifestFile;
    const privateKey = await resolveCodeUpdateSigningKey({
      sign: values.sign,
      signKeyFile: values["sign-key-file"],
      env: process.env,
      homeDirectory: homedir(),
    });
    if (privateKey) {
      await writeFile(
        `${manifestFile}.sig`,
        `${signCodeUpdateManifest({ manifest: manifestText, channel, privateKey })}\n`,
      );
      log(`signed ${codeUpdateManifestPath(channel)}`);
    }
    log(`done in ${((performance.now() - started) / 1000).toFixed(1)} s: ${manifestFile}`);
    return finish(0, "code-update");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`[code-update] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
