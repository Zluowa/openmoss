// FILE: sshRemoteRuntimePruner.ts
// Purpose: Remove superseded remote Moss runtimes and finished uploads without touching one in use.
// Layer: Private remote SSH bootstrap
// Exports: SSH_REMOTE_RUNTIME_PRUNER, SSH_REMOTE_RUNTIME_PRUNE_GRACE_MS
//
// The script runs after this connection's runtime is ready. It only ever deletes
// inside ~/.moss/ssh-runtime, and fails closed: when it cannot tell which
// directories running processes use, it deletes no runtime directory at all.
export const SSH_REMOTE_RUNTIME_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

export const SSH_REMOTE_RUNTIME_PRUNER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const GRACE_MS = ${SSH_REMOTE_RUNTIME_PRUNE_GRACE_MS};
const root = process.env.MOSS_SSH_RUNTIME_ROOT;
const current = process.env.MOSS_SSH_PAYLOAD_DIR;
const ownArchive = process.env.MOSS_SSH_ARCHIVE_PATH;
const now = Date.now();
if (!root || !current) process.exit(0);
const resolvedRoot = path.resolve(root);
if (path.dirname(path.resolve(current)) !== resolvedRoot) process.exit(0);
function realRootChild(file) {
  try { return path.dirname(fs.realpathSync(file)) === fs.realpathSync(resolvedRoot); } catch { return false; }
}
function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
// Mark this runtime as used now, so another connection never prunes it.
try { fs.writeFileSync(path.join(current, ".last-used"), String(now) + "\n", { mode: 0o600 }); } catch {}
// Working directories of this account's processes. The backend runs with its
// runtime directory as its working directory. null means "unknown": prune none.
function workingDirectories() {
  if (process.env.MOSS_SSH_PRUNER_TEST_CWDS !== undefined) {
    try { return new Set(JSON.parse(process.env.MOSS_SSH_PRUNER_TEST_CWDS)); } catch { return null; }
  }
  if (process.platform === "linux") {
    const result = new Set();
    let entries;
    try { entries = fs.readdirSync("/proc"); } catch { return null; }
    for (const name of entries) {
      if (!/^[0-9]+$/.test(name)) continue;
      try { result.add(fs.readlinkSync("/proc/" + name + "/cwd")); } catch {}
    }
    return result;
  }
  if (process.platform === "darwin") {
    try {
      const output = cp.execFileSync("/usr/sbin/lsof", ["-a", "-u", String(process.getuid()), "-d", "cwd", "-Fn"], {
        encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" },
      });
      return new Set(output.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1)));
    } catch { return null; }
  }
  return null;
}
function inUse(directories, directory) {
  let real;
  try { real = fs.realpathSync(directory); } catch { real = directory; }
  for (const cwd of directories) {
    if (cwd === directory || cwd === real || cwd.startsWith(directory + "/") || cwd.startsWith(real + "/")) return true;
  }
  return false;
}
// Rename first: a half-deleted directory must never look like a ready runtime.
function removeDirectory(directory) {
  const trash = path.join(resolvedRoot, ".trash-" + crypto.randomUUID());
  try { fs.renameSync(directory, trash); } catch { return; }
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch {}
}
function lockHeld(lock) {
  try {
    const previous = JSON.parse(fs.readFileSync(lock, "utf8"));
    if (!Number.isInteger(previous.pid) || previous.pid < 1) return true;
    process.kill(previous.pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === "ESRCH") && fs.existsSync(lock);
  }
}
let entries = [];
try { entries = fs.readdirSync(resolvedRoot); } catch { process.exit(0); }
const directories = workingDirectories();
for (const name of entries) {
  const full = path.join(resolvedRoot, name);
  let stat;
  try { stat = fs.lstatSync(full); } catch { continue; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !realRootChild(full)) continue;
  if (/^\.trash-[0-9a-f-]{36}$/.test(name)) {
    if (now - stat.mtimeMs >= GRACE_MS) try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
    continue;
  }
  if (!/^payload-[a-f0-9]{64}-[A-Za-z0-9_.-]+$/.test(name) || full === path.resolve(current)) continue;
  if (directories === null) continue;
  const lastUsed = Math.max(stat.mtimeMs, mtime(path.join(full, ".last-used")), mtime(path.join(full, ".dependencies-ready")));
  if (now - lastUsed < GRACE_MS || inUse(directories, full)) continue;
  removeDirectory(full);
}
const uploads = path.join(resolvedRoot, "uploads");
let uploadEntries = [];
try {
  if (fs.realpathSync(uploads) === path.join(fs.realpathSync(resolvedRoot), "uploads")) uploadEntries = fs.readdirSync(uploads);
} catch {}
for (const name of uploadEntries) {
  const match = /^([a-f0-9]{64}-[A-Za-z0-9-]{1,80})\.(tar\.gz|partial)$/.exec(name);
  if (!match) continue;
  const full = path.join(uploads, name);
  let stat;
  try { stat = fs.lstatSync(full); } catch { continue; }
  if (!stat.isFile() || stat.isSymbolicLink()) continue;
  const own = ownArchive !== undefined && full === path.resolve(ownArchive);
  // This connection's runtime is installed, so its archive is no longer needed.
  // Another connection's archive is removed only when stale and unlocked.
  if (!own && (now - stat.mtimeMs < GRACE_MS || lockHeld(path.join(uploads, match[1] + ".lock")))) continue;
  try { fs.unlinkSync(full); } catch {}
}
`;
