// FILE: sshRemoteArchiveReceiver.ts
// Purpose: Receive resumable binary runtime archives and verify them before installation.
// Layer: Private remote SSH bootstrap
export const SSH_REMOTE_ARCHIVE_RECEIVER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const expected = process.env.MOSS_SSH_ARCHIVE_SHA256;
const total = Number(process.env.MOSS_SSH_ARCHIVE_BYTES);
const uploadId = process.env.MOSS_SSH_UPLOAD_ID;
const root = process.env.MOSS_SSH_RUNTIME_ROOT;
const prepare = process.env.MOSS_SSH_PREPARE_DIR;
const payload = process.env.MOSS_SSH_PAYLOAD_DIR;
if (!/^[a-f0-9]{64}$/.test(expected || "") || !/^[a-zA-Z0-9-]{1,80}$/.test(uploadId || "") || !Number.isSafeInteger(total) || total < 1 || total > 350 * 1024 * 1024) process.exit(64);
const cache = path.join(root, "uploads");
const partial = path.join(cache, expected + "-" + uploadId + ".partial");
const complete = path.join(cache, expected + "-" + uploadId + ".tar.gz");
const lock = path.join(cache, expected + "-" + uploadId + ".lock");
const nonce = crypto.randomUUID();
let lockOwned = false;
let output;
let count = 0;
function release() {
  if (!lockOwned) return;
  try { if (JSON.parse(fs.readFileSync(lock, "utf8")).nonce === nonce) fs.unlinkSync(lock); } catch {}
  lockOwned = false;
}
function closeOutput() { if (output !== undefined) { try { fs.closeSync(output); } catch {} output = undefined; } }
function fail(marker, code) { closeOutput(); release(); process.stderr.write(marker + "\n"); process.exit(code); }
process.on("exit", release);
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { closeOutput(); release(); process.exit(143); });
function regularSize(file) {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("unsafe-cache"); return stat.size; }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function verified(file) {
  if (regularSize(file) !== total) return false;
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex") === expected;
}
async function acquire() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 });
      lockOwned = true; return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((regularSize(lock) ?? 0) > 4096) throw Error("unsafe-cache");
      let previous; try { previous = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { throw Error("unsafe-cache"); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw Error("unsafe-cache");
      let running = true;
      try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === "ESRCH") running = false; }
      // An alive, possibly reused PID is never killed or stolen from.
      if (!running) { fs.unlinkSync(lock); continue; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  fail("MOSS_REMOTE_UPLOAD_BUSY", 76);
}
async function main() {
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(cache) !== path.join(fs.realpathSync(root), "uploads")) throw Error("unsafe-cache");
  await acquire();
  const installed = regularSize(path.join(payload, ".dependencies-ready")) !== undefined;
  let cached = false;
  if (!installed && regularSize(complete) !== undefined) {
    cached = await verified(complete);
    if (!cached) fs.unlinkSync(complete);
  }
  if (installed || cached) count = total;
  else {
    count = regularSize(partial) ?? 0;
    if (count > total) { fs.unlinkSync(partial); count = 0; }
    output = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  }
  process.stderr.write("MOSS_SSH_PAYLOAD_READY:" + count + "\n");
  process.stdin.on("data", bytes => {
    if (output === undefined || count + bytes.length > total) fail("MOSS_REMOTE_CHECKSUM_FAILED", 72);
    try { fs.writeSync(output, bytes); count += bytes.length; }
    catch { fail("MOSS_REMOTE_RUNTIME_INSTALL_FAILED", 73); }
  });
  process.stdin.once("error", () => fail("MOSS_REMOTE_UPLOAD_INCOMPLETE", 76));
  process.stdin.once("end", async () => {
    try {
      if (output !== undefined) { fs.fsyncSync(output); closeOutput(); }
      if (count !== total) return fail("MOSS_REMOTE_UPLOAD_INCOMPLETE", 76);
      if (!installed && !cached) {
        if (!await verified(partial)) { fs.unlinkSync(partial); return fail("MOSS_REMOTE_CHECKSUM_FAILED", 72); }
        fs.renameSync(partial, complete);
      }
      release();
      const child = cp.spawn("/bin/sh", [path.join(prepare, "continue.sh")], {
        stdio: ["ignore", "inherit", "inherit", 3],
        env: { ...process.env, MOSS_SSH_ARCHIVE_PATH: complete },
      });
      child.once("error", () => fail("MOSS_REMOTE_RUNTIME_INSTALL_FAILED", 73));
      child.once("close", code => process.exit(code ?? 1));
    } catch { fail("MOSS_REMOTE_CHECKSUM_FAILED", 72); }
  });
  process.stdin.resume();
}
main().catch(() => fail("MOSS_REMOTE_CHECKSUM_FAILED", 72));
`;
