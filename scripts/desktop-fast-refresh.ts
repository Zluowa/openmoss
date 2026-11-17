// Fast refresh of an installed Moss desktop app (Windows) with freshly built app code, for test builds.
//
// The full installer takes ~30 minutes; most of it reinstalls production dependencies and compresses an
// NSIS installer that did not change. This tool rebuilds only the app code (the same `bun run
// build:desktop` step the installer build runs), splices it into the installed app.asar (every other
// byte of the archive is kept), verifies the result through the installed Electron's own asar reader
// and a headless start of its server, and swaps it in with the previous archive kept for `restore`.
// The state folder holds two archive copies and the new one: keep ~2 GB free on its drive.
//
// It is a test path, not a release path. Run the full installer before publishing; what this does not
// refresh is printed with every run (FAST_REFRESH_NOT_REFRESHED).
//
//   node scripts/desktop-fast-refresh.ts run     --repo <clean checkout at the commit> [--install-dir <dir>] [--swap]
//   node scripts/desktop-fast-refresh.ts check   --repo <dir> [--install-dir <dir>] [--base <app.asar>]
//   node scripts/desktop-fast-refresh.ts build   --repo <dir>
//   node scripts/desktop-fast-refresh.ts pack    --repo <dir> --out <new.asar> [--install-dir <dir>] [--base <app.asar>]
//   node scripts/desktop-fast-refresh.ts verify  --repo <dir> --asar <new.asar> [--install-dir <dir>] [--base <app.asar>] [--electron <exe>]
//   node scripts/desktop-fast-refresh.ts swap    --asar <new.asar> [--install-dir <dir>]
//   node scripts/desktop-fast-refresh.ts restore [--to previous|base] [--install-dir <dir>]
//   node scripts/desktop-fast-refresh.ts status  [--install-dir <dir>]
//
// The build inherits this process's environment (production public config, Sentry DSNs, feedback
// endpoint), exactly as build-desktop-artifact.ts passes it to the same build step; the release wrapper
// that sets them for the installer sets them for this tool too.
//
// State (outside the install and the user's data): %LOCALAPPDATA%\moss-fast-refresh by default:
//   base\app.asar   the archive of the last full install, adopted the first time a swap replaces it
//   previous\app.asar  what was installed before the last swap
//   state.json      sha256 and commit of both, and of the archive the last swap wrote
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  findAsarNode,
  isAsarDirectory,
  isAsarLink,
  readAsarArchive,
  spliceAsar,
  walkAsarFiles,
  type AsarFileEntry,
} from "./lib/asar-splice.ts";
import {
  classifyFastRefreshChanges,
  FAST_REFRESH_NOT_REFRESHED,
  FAST_REFRESH_REPLACED_DIRECTORIES,
} from "./lib/desktop-fast-refresh-policy.ts";
import { createDesktopBuildSubprocessEnvironment } from "./lib/desktop-signing-environment.ts";

const localAppData =
  process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
const DEFAULT_INSTALL_DIR = path.join(localAppData, "Programs", "Moss");
const DEFAULT_STATE_DIR = path.join(localAppData, "moss-fast-refresh");

interface State {
  base?: { sha256: string; commit: string | null; adoptedAt: string };
  previous?: { sha256: string; commit: string | null };
  lastWritten?: { sha256: string; commit: string | null; writtenAt: string };
}

class Refused extends Error {}

const log = (line: string) => console.log(`[fast-refresh] ${line}`);
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

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
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 8 * 1024 * 1024 }))
    hash.update(chunk);
  return hash.digest("hex");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function readState(stateDir: string): Promise<State> {
  try {
    return JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")) as State;
  } catch {
    return {};
  }
}

async function writeState(stateDir: string, state: State): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, "state.json");
  await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

async function archivePackageJson(
  asarFile: string,
): Promise<{ text: string; commit: string | null }> {
  const archive = await readAsarArchive(asarFile);
  const node = findAsarNode(archive.header, "package.json");
  if (
    !node ||
    isAsarDirectory(node) ||
    isAsarLink(node) ||
    node.unpacked ||
    node.offset === undefined
  ) {
    throw new Error(`${asarFile} has no packed package.json`);
  }
  const handle = await open(asarFile, "r");
  try {
    const bytes = Buffer.alloc(node.size);
    await handle.read(bytes, 0, node.size, archive.dataStart + Number(node.offset));
    const text = bytes.toString("utf8");
    const commit = (JSON.parse(text) as { mossCommitHash?: unknown }).mossCommitHash;
    return {
      text,
      commit: typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit) ? commit : null,
    };
  } finally {
    await handle.close();
  }
}

/**
 * The archive to splice into: the installed one when it came from a full install, or the adopted base
 * when the installed one was written by an earlier fast refresh (never splice onto a spliced archive).
 */
async function resolveBase(
  installDir: string,
  stateDir: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return path.resolve(explicit);
  const installed = path.join(installDir, "resources", "app.asar");
  if (!(await exists(installed))) throw new Refused(`no installed app at ${installed}`);
  const state = await readState(stateDir);
  if (!state.lastWritten || !state.base) return installed;
  const current = await sha256File(installed);
  if (current === state.lastWritten.sha256 || current === state.base.sha256) {
    return path.join(stateDir, "base", "app.asar");
  }
  return installed; // a newer full install replaced our archive: it is the base now
}

async function check(repo: string, base: string): Promise<{ baseCommit: string; head: string }> {
  if (process.platform !== "win32")
    throw new Refused("the fast refresh is for the Windows app only");
  const dirty = git(repo, "status", "--porcelain", "--untracked-files=no");
  if (dirty) throw new Refused(`checkout ${repo} has uncommitted changes`);
  const head = git(repo, "rev-parse", "HEAD");
  const { commit: baseCommit } = await archivePackageJson(base);
  if (!baseCommit) throw new Refused(`${base} does not name the commit it was built from`);
  if (spawnSync("git", ["-C", repo, "cat-file", "-e", `${baseCommit}^{commit}`]).status !== 0) {
    throw new Refused(`base commit ${baseCommit} is not in ${repo}; fetch it first`);
  }
  const changed = git(repo, "diff", "--name-only", baseCommit, head).split("\n").filter(Boolean);
  const refusals = classifyFastRefreshChanges(changed, (p) => ({
    before: gitShowOrNull(repo, `${baseCommit}:${p}`),
    after: gitShowOrNull(repo, `${head}:${p}`),
  }));
  log(`base ${baseCommit.slice(0, 9)} -> ${head.slice(0, 9)}: ${changed.length} files changed`);
  if (refusals.length > 0) {
    for (const r of refusals.slice(0, 20))
      log(`  needs the full installer: ${r.path} (${r.reason})`);
    throw new Refused(`${refusals.length} change(s) need the full installer`);
  }
  return { baseCommit, head };
}

async function build(repo: string): Promise<void> {
  const bun = process.platform === "win32" ? "bun.exe" : "bun";
  await new Promise<void>((resolve, reject) => {
    // The same build build-desktop-artifact.ts runs, never from turbo's cache: a cache hit can restore
    // a bundle that misses root-level build inputs.
    // The release build runs one turbo task at a time (TURBO_CONCURRENCY=1, set for the memory of the
    // Mac build host); on this path the web bundle, the desktop main and the workspace libraries build
    // side by side. Same tasks, same inputs, same outputs.
    // `--cache=local:,remote:` executes every task like `--force` and also skips writing the outputs to
    // turbo's cache, which nobody reads after a forced build: storing the web bundle there kept turbo
    // running 90 s after the build was done (measured 2026-11-17).
    const child = spawn(bun, ["run", "build:desktop", "--cache=local:,remote:"], {
      cwd: repo,
      env: { ...createDesktopBuildSubprocessEnvironment(process.env), TURBO_CONCURRENCY: "4" },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build:desktop exit ${code}`)),
    );
  });
  for (const local of Object.values(FAST_REFRESH_REPLACED_DIRECTORIES)) {
    if (!(await exists(path.join(repo, local)))) throw new Error(`build produced no ${local}`);
  }
  if (!(await exists(path.join(repo, "apps/server/dist/client/index.html")))) {
    throw new Error("build produced no bundled web client (apps/server/dist/client/index.html)");
  }
}

async function pack(repo: string, base: string, out: string, head: string) {
  const { text, commit } = await archivePackageJson(base);
  // Change only the commit id, byte for byte otherwise, so an unchanged commit gives an identical file.
  const updatedPackageJson =
    commit && text.split(`"${commit}"`).length === 2
      ? text.replace(`"${commit}"`, `"${head}"`)
      : `${JSON.stringify({ ...(JSON.parse(text) as object), mossCommitHash: head }, null, 2)}${text.endsWith("\n") ? "\n" : ""}`;
  if ((JSON.parse(updatedPackageJson) as { mossCommitHash?: unknown }).mossCommitHash !== head) {
    throw new Error("could not record the new commit in the archive's package.json");
  }
  await mkdir(path.dirname(out), { recursive: true });
  return spliceAsar({
    base,
    output: out,
    replaceDirectories: Object.fromEntries(
      Object.entries(FAST_REFRESH_REPLACED_DIRECTORIES).map(([archivePath, local]) => [
        archivePath,
        path.join(repo, local),
      ]),
    ),
    replaceFiles: {
      "package.json": Buffer.from(updatedPackageJson),
      "THIRD_PARTY_NOTICES.md": await readFile(path.join(repo, "THIRD_PARTY_NOTICES.md")),
    },
  });
}

// Runs inside Electron (ELECTRON_RUN_AS_NODE): Electron's patched fs reads the archive the way the app will.
const ELECTRON_READER = `
const fs = require("fs"); const crypto = require("crypto");
const [asarFile, listFile, outFile] = process.argv.slice(2);
const out = {};
for (const p of JSON.parse(fs.readFileSync(listFile, "utf8"))) {
  out[p] = crypto.createHash("sha256").update(fs.readFileSync(asarFile + "/" + p)).digest("hex");
}
fs.writeFileSync(outFile, JSON.stringify(out));
`;

async function verify(input: {
  repo: string;
  base: string;
  asar: string;
  electron: string;
}): Promise<{ files: number; electronFiles: number; bootSeconds: number }> {
  const [base, next] = await Promise.all([
    readAsarArchive(input.base),
    readAsarArchive(input.asar),
  ]);
  const replaced = Object.keys(FAST_REFRESH_REPLACED_DIRECTORIES);
  const inReplaced = (p: string) => replaced.some((dir) => p === dir || p.startsWith(`${dir}/`));
  const rewritten = new Set(["package.json", "THIRD_PARTY_NOTICES.md"]);
  const problems: string[] = [];

  // 1. Same set of paths outside the replaced trees, with the same records (integrity, unpacked).
  const baseFiles = new Map([...walkAsarFiles(base.header)].map((f) => [f.path, f.entry]));
  const nextFiles = new Map([...walkAsarFiles(next.header)].map((f) => [f.path, f.entry]));
  for (const [p, entry] of baseFiles) {
    if (inReplaced(p) || rewritten.has(p)) continue;
    const other = nextFiles.get(p);
    if (!other) problems.push(`missing kept file ${p}`);
    else {
      const { offset: _a, ...a } = entry as AsarFileEntry;
      const { offset: _b, ...b } = other as AsarFileEntry;
      if (JSON.stringify(a) !== JSON.stringify(b))
        problems.push(`record changed for kept file ${p}`);
    }
  }
  for (const p of nextFiles.keys()) {
    if (!baseFiles.has(p) && !inReplaced(p)) problems.push(`unexpected new file ${p}`);
  }
  // 2. Replaced trees hold exactly the build output.
  for (const [archiveDir, local] of Object.entries(FAST_REFRESH_REPLACED_DIRECTORIES)) {
    const node = findAsarNode(next.header, archiveDir);
    if (!node || !isAsarDirectory(node)) {
      problems.push(`missing ${archiveDir}`);
      continue;
    }
    for (const { path: rel, entry } of walkAsarFiles(node)) {
      const bytes = await readFile(path.join(input.repo, local, ...rel.split("/")));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (isAsarLink(entry) || entry.integrity?.hash !== hash)
        problems.push(`${archiveDir}/${rel} differs from the build`);
    }
  }
  // 3. Every packed byte matches its integrity record (one sequential read).
  const handle = await open(input.asar, "r");
  let files = 0;
  try {
    for (const [p, entry] of nextFiles) {
      if (isAsarLink(entry) || entry.unpacked) continue;
      const bytes = Buffer.alloc(entry.size);
      if (entry.size > 0)
        await handle.read(bytes, 0, entry.size, next.dataStart + Number(entry.offset));
      if (createHash("sha256").update(bytes).digest("hex") !== entry.integrity?.hash) {
        problems.push(`bytes of ${p} do not match its integrity record`);
      }
      files += 1;
    }
  } finally {
    await handle.close();
  }
  if (problems.length > 0) {
    for (const p of problems.slice(0, 20)) log(`  ${p}`);
    throw new Error(`verification failed: ${problems.length} problem(s)`);
  }
  // 4. Read every packed file through Electron's own asar support.
  const work = await mkdtemp(path.join(tmpdir(), "moss-fast-refresh-verify-"));
  try {
    const packed = [...nextFiles].filter(([, e]) => !isAsarLink(e) && !e.unpacked);
    await writeFile(path.join(work, "reader.js"), ELECTRON_READER);
    await writeFile(path.join(work, "list.json"), JSON.stringify(packed.map(([p]) => p)));
    const result = spawnSync(
      input.electron,
      [
        path.join(work, "reader.js"),
        input.asar,
        path.join(work, "list.json"),
        path.join(work, "out.json"),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        windowsHide: true,
        timeout: 300_000,
      },
    );
    if (result.status !== 0)
      throw new Error(`Electron could not read the archive: ${result.stderr.trim().slice(0, 500)}`);
    const read = JSON.parse(await readFile(path.join(work, "out.json"), "utf8")) as Record<
      string,
      string
    >;
    const mismatched = packed.filter(([p, e]) => read[p] !== (e as AsarFileEntry).integrity?.hash);
    if (mismatched.length > 0) {
      throw new Error(
        `Electron read ${mismatched.length} file(s) differently, first ${mismatched[0]![0]}`,
      );
    }
    const boot = await bootCheck(input.electron, input.asar);
    return { files, electronFiles: packed.length, bootSeconds: boot };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object"
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/**
 * Start the server bundle from the new archive the way the desktop app does (Electron in node mode) in a
 * throwaway home with no inherited profile paths, and wait until it serves the bundled web client.
 * Proves the archive's server code resolves its packaged dependencies and starts; it does not open a
 * window and never touches the user's data. Returns the seconds to the first served page.
 */
async function bootCheck(electron: string, asar: string): Promise<number> {
  const home = await mkdtemp(path.join(tmpdir(), "moss-fast-refresh-boot-"));
  const dirs = ["moss", "codex", "claude", "AppData/Roaming", "AppData/Local"];
  for (const dir of dirs) await mkdir(path.join(home, dir), { recursive: true });
  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  const inherited = [
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "ComSpec",
    "PATHEXT",
    "Path",
    "PATH",
    "TEMP",
    "TMP",
  ];
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    inherited.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: "1",
    MOSS_MODE: "desktop",
    MOSS_NO_BROWSER: "1",
    MOSS_PORT: String(port),
    MOSS_HOME: path.join(home, "moss"),
    MOSS_AUTH_TOKEN: token,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CODEX_HOME: path.join(home, "codex"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
  });
  const started = performance.now();
  const child = spawn(electron, [`${asar}/apps/server/dist/index.mjs`], {
    env,
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000)));
  child.stderr.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000)));
  try {
    for (let attempt = 0; attempt < 180 && child.exitCode === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        const body = await response.text();
        if (response.status === 200 && body.includes('<div id="root"')) {
          return (performance.now() - started) / 1000;
        }
        throw new Error(`the server answered ${response.status} without the web client`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("the server answered")) throw error;
      }
    }
    throw new Error(`the server from the new archive did not start: ${output.trim().slice(-1500)}`);
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() =>
      log(`note: could not remove the boot check home ${home}`),
    );
  }
}

function runningFrom(installDir: string): number[] {
  // Read-only process listing; this tool never stops a process.
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)" }',
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error("could not list processes");
  const prefix = path.resolve(installDir).toLowerCase() + path.sep;
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.split("\t"))
    .filter(([, exe]) => exe && path.resolve(exe).toLowerCase().startsWith(prefix))
    .map(([pid]) => Number(pid));
}

async function swap(installDir: string, stateDir: string, asar: string): Promise<void> {
  const pids = runningFrom(installDir);
  if (pids.length > 0)
    throw new Refused(
      `Moss is running from ${installDir} (pids ${pids.join(", ")}); close it first`,
    );
  const installed = path.join(installDir, "resources", "app.asar");
  const state = await readState(stateDir);
  const currentSha = await sha256File(installed);
  const { commit: currentCommit } = await archivePackageJson(installed);
  const fromFullInstall =
    currentSha !== state.lastWritten?.sha256 && currentSha !== state.base?.sha256;
  await mkdir(path.join(stateDir, "base"), { recursive: true });
  await mkdir(path.join(stateDir, "previous"), { recursive: true });
  if (fromFullInstall) {
    // The installed archive came from a full installer: keep it as the base of later refreshes.
    await copyFile(installed, path.join(stateDir, "base", "app.asar.tmp"));
    await rename(
      path.join(stateDir, "base", "app.asar.tmp"),
      path.join(stateDir, "base", "app.asar"),
    );
    state.base = { sha256: currentSha, commit: currentCommit, adoptedAt: new Date().toISOString() };
    log(`adopted the installed archive (${currentCommit?.slice(0, 9) ?? "?"}) as the base`);
  }
  await copyFile(installed, path.join(stateDir, "previous", "app.asar.tmp"));
  await rename(
    path.join(stateDir, "previous", "app.asar.tmp"),
    path.join(stateDir, "previous", "app.asar"),
  );
  state.previous = { sha256: currentSha, commit: currentCommit };
  await writeState(stateDir, state);

  const staged = `${installed}.fast-new`;
  const old = `${installed}.fast-old`;
  await copyFile(asar, staged);
  await rename(installed, old);
  try {
    await rename(staged, installed);
  } catch (error) {
    await rename(old, installed);
    throw error;
  }
  await rm(old, { force: true });
  const writtenSha = await sha256File(installed);
  const { commit } = await archivePackageJson(installed);
  state.lastWritten = { sha256: writtenSha, commit, writtenAt: new Date().toISOString() };
  await writeState(stateDir, state);
  log(
    `installed ${commit?.slice(0, 9) ?? "?"} into ${installed}; previous kept in ${path.join(stateDir, "previous")}`,
  );
}

async function restore(
  installDir: string,
  stateDir: string,
  to: "previous" | "base",
): Promise<void> {
  const pids = runningFrom(installDir);
  if (pids.length > 0)
    throw new Refused(
      `Moss is running from ${installDir} (pids ${pids.join(", ")}); close it first`,
    );
  const state = await readState(stateDir);
  const source = path.join(stateDir, to, "app.asar");
  const expected = to === "base" ? state.base?.sha256 : state.previous?.sha256;
  if (!expected || !(await exists(source))) throw new Refused(`nothing to restore from ${source}`);
  if ((await sha256File(source)) !== expected)
    throw new Refused(`${source} does not match state.json`);
  const installed = path.join(installDir, "resources", "app.asar");
  await copyFile(source, `${installed}.fast-new`);
  await rename(`${installed}.fast-new`, installed);
  state.lastWritten = {
    sha256: expected,
    commit: (await archivePackageJson(installed)).commit,
    writtenAt: new Date().toISOString(),
  };
  await writeState(stateDir, state);
  log(`restored ${to} (${state.lastWritten.commit?.slice(0, 9) ?? "?"}) into ${installed}`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      "install-dir": { type: "string", default: DEFAULT_INSTALL_DIR },
      "state-dir": { type: "string", default: DEFAULT_STATE_DIR },
      base: { type: "string" },
      out: { type: "string" },
      asar: { type: "string" },
      electron: { type: "string" },
      to: { type: "string", default: "previous" },
      swap: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  const installDir = path.resolve(values["install-dir"]!);
  const stateDir = path.resolve(values["state-dir"]!);
  const repo = values.repo ? path.resolve(values.repo) : undefined;
  const needRepo = () => {
    if (!repo) throw new Refused("--repo <checkout> is required");
    return repo;
  };
  const electron = values.electron
    ? path.resolve(values.electron)
    : path.join(installDir, "Moss.exe");

  switch (command) {
    case "check": {
      await check(needRepo(), await resolveBase(installDir, stateDir, values.base));
      log("ok: this change can be carried by a fast refresh");
      return;
    }
    case "build": {
      const started = performance.now();
      await build(needRepo());
      log(`build ${seconds(started)}`);
      return;
    }
    case "pack": {
      if (!values.out) throw new Refused("--out <new app.asar> is required");
      const base = await resolveBase(installDir, stateDir, values.base);
      const report = await pack(
        needRepo(),
        base,
        path.resolve(values.out),
        git(needRepo(), "rev-parse", "HEAD"),
      );
      log(
        `packed ${report.newFiles} new + ${report.keptFiles} kept files, ${(report.outputBytes / 1e6).toFixed(1)} MB`,
      );
      return;
    }
    case "verify": {
      if (!values.asar) throw new Refused("--asar <new app.asar> is required");
      const base = await resolveBase(installDir, stateDir, values.base);
      const result = await verify({
        repo: needRepo(),
        base,
        asar: path.resolve(values.asar),
        electron,
      });
      log(
        `verified ${result.files} packed files; Electron read ${result.electronFiles} identically; the server from the archive served the web client after ${result.bootSeconds.toFixed(1)} s`,
      );
      return;
    }
    case "swap": {
      if (!values.asar) throw new Refused("--asar <new app.asar> is required");
      await swap(installDir, stateDir, path.resolve(values.asar));
      return;
    }
    case "restore": {
      if (values.to !== "previous" && values.to !== "base") throw new Refused("--to previous|base");
      await restore(installDir, stateDir, values.to);
      return;
    }
    case "status": {
      console.log(
        JSON.stringify({ installDir, stateDir, ...(await readState(stateDir)) }, null, 2),
      );
      return;
    }
    case "run": {
      const r = needRepo();
      const timings: Array<[string, string]> = [];
      let t = performance.now();
      const base = await resolveBase(installDir, stateDir, values.base);
      const { head } = await check(r, base);
      timings.push(["check", seconds(t)]);
      if (!values["skip-build"]) {
        t = performance.now();
        await build(r);
        timings.push(["build", seconds(t)]);
      }
      t = performance.now();
      const out = values.out
        ? path.resolve(values.out)
        : path.join(stateDir, "out", `app-${head.slice(0, 9)}.asar`);
      const report = await pack(r, base, out, head);
      timings.push(["pack", seconds(t)]);
      t = performance.now();
      const verified = await verify({ repo: r, base, asar: out, electron });
      timings.push(["verify", seconds(t)]);
      if (values.swap) {
        t = performance.now();
        await swap(installDir, stateDir, out);
        timings.push(["swap", seconds(t)]);
      }
      log(
        `archive ${out}: ${report.newFiles} new + ${report.keptFiles} kept files, ${verified.electronFiles} read back through Electron, server started and served the web client in ${verified.bootSeconds.toFixed(1)} s`,
      );
      log(`timings: ${timings.map(([k, v]) => `${k} ${v}`).join(", ")}`);
      log("not refreshed (run the full installer before publishing):");
      for (const item of FAST_REFRESH_NOT_REFRESHED) log(`  - ${item}`);
      if (!values.swap) log(`not installed: rerun with --swap, or: swap --asar ${out}`);
      return;
    }
    default:
      throw new Refused("command: run | check | build | pack | verify | swap | restore | status");
  }
}

main().catch((error: unknown) => {
  if (error instanceof Refused) {
    console.error(`[fast-refresh] refused: ${error.message}`);
    process.exit(3);
  }
  console.error(`[fast-refresh] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
