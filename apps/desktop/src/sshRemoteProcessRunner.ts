// FILE: sshRemoteProcessRunner.ts
// Purpose: Own remote prepare/backend descendants and observe the SSH output lifeline.
// Layer: Private SSH POSIX runtime controller
export const SSH_REMOTE_PROCESS_RUNNER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const command = process.argv[2];
const args = process.argv.slice(3);
if (!command) process.exit(64);
let stopping = false;
let heartbeat;
let drainTimer;
let observeTimer;
let exitCode;
let childExited = false;
let drainStarted = 0;
let owned = new Map();
function processTable() {
  const result = new Map();
  if (process.platform === "linux") {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync("/proc/" + name + "/stat", "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        result.set(Number(name), { parent: Number(fields[1]), born: fields[19] });
      } catch {}
    }
    return result;
  }
  const rows = cp.execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  for (const row of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(row);
    if (match) result.set(Number(match[1]), { parent: Number(match[2]), born: match[3] });
  }
  return result;
}
function snapshot() {
  try {
    const table = processTable();
    const direct = table.get(child.pid);
    if (!owned.has(child.pid) && !childExited && direct?.parent === process.pid) owned.set(child.pid, direct);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, record] of table) {
        if (!owned.has(pid) && owned.has(record.parent) && table.get(record.parent)?.born === owned.get(record.parent).born) { owned.set(pid, record); changed = true; }
      }
    }
    return table;
  } catch { return null; }
}
function signalOwned(signal) {
  const current = snapshot();
  if (!current) return;
  for (const [pid, record] of [...owned].reverse()) {
    if (current.get(pid)?.born !== record.born) continue;
    try { process.kill(pid, signal); } catch {}
  }
}
function cleanPrepare() {
  if (process.env.MOSS_SSH_RUNNER_CLEANUP !== "1") return;
  const directory = process.env.MOSS_SSH_PREPARE_DIR;
  const expected = path.resolve(process.env.HOME, ".moss", "ssh-runtime");
  if (!directory || path.dirname(path.resolve(directory)) !== expected || !/^\.prepare\.[A-Za-z0-9]+$/.test(path.basename(directory))) return;
  try {
    if (fs.realpathSync(directory) === path.resolve(directory)) fs.rmSync(directory, { recursive: true, force: true });
  } catch {}
}
function finish(code, drained) {
  clearInterval(heartbeat); clearInterval(observeTimer); clearInterval(drainTimer);
  if (drained) cleanPrepare();
  process.exit(code);
}
function drain() {
  const table = snapshot();
  const live = table && [...owned].some(([pid, record]) => table.get(pid)?.born === record.born);
  if (table && !live && childExited) { finish(exitCode, true); return; }
  const elapsed = Date.now() - drainStarted;
  if (elapsed >= 2000) signalOwned("SIGKILL");
  // Metadata failure is not proof of exit. Preserve the prepare directory on
  // bounded failure rather than deleting files still used by an owned process.
  if (elapsed >= 4000) finish(exitCode || 70, false);
}
function stop(code) {
  if (stopping) return;
  stopping = true; exitCode = code; drainStarted = Date.now();
  signalOwned("SIGTERM");
  drainTimer = setInterval(drain, 100);
  drain();
}
// Extra descriptor 3 is the SSH output pipe, independent of the script's
// normally-completed stdin and of installer stdout redirected to a log file.
function pulse() {
  try { fs.writeSync(3, "MOSS_SSH_KEEPALIVE\n"); }
  catch { stop(143); }
}
try { if (!processTable().has(process.pid)) process.exit(70); } catch { process.exit(70); }
const forwardInput = process.env.MOSS_SSH_CHILD_STDIN === "1";
const childEnvironment = { ...process.env };
delete childEnvironment.MOSS_SSH_CHILD_STDIN;
const child = cp.spawn(command, args, {
  stdio: forwardInput ? ["pipe", "inherit", "inherit", 3] : ["ignore", "inherit", "inherit"],
  env: childEnvironment,
});
if (forwardInput) {
  child.stdin.on("error", () => undefined);
  process.stdin.pipe(child.stdin);
}
child.once("error", () => { childExited = true; stop(127); });
child.once("close", (code) => {
  childExited = true;
  // A root may exit before its children. Both ordinary completion and
  // cancellation drain every previously verified descendant before cleanup.
  if (!stopping) stop(code ?? 1);
  else drain();
});
for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => stop(code));
observeTimer = setInterval(snapshot, 250);
heartbeat = setInterval(pulse, 1000);
snapshot(); pulse();
`;
