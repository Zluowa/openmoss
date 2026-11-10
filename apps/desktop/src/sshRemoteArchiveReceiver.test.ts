// FILE: sshRemoteArchiveReceiver.test.ts
// Purpose: Exercise real archive bytes, resume boundaries and integrity before installation.
// Layer: SSH runtime tests
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { SSH_REMOTE_ARCHIVE_RECEIVER } from "./sshRemoteArchiveReceiver";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "moss-ssh-upload-"));
  roots.push(root);
  return root;
}
function receive(root: string, archive: Buffer) {
  const hash = crypto.createHash("sha256").update(archive).digest("hex");
  const payload = path.join(root, "payload");
  fs.mkdirSync(payload, { recursive: true });
  const prepare = path.join(root, ".prepare.QA123");
  fs.mkdirSync(prepare, { recursive: true });
  const marker = path.join(root, `installed-${crypto.randomUUID()}`);
  const wrapper = path.join(root, "receiver-worker.cjs");
  // Only the final POSIX installer launch is adapted for this cross-platform
  // test. The shipped receiver runs unchanged with real stdin and filesystem.
  fs.writeFileSync(
    wrapper,
    `const cp=require("node:child_process"),vm=require("node:vm");
const installer={spawn:()=>cp.spawn(process.execPath,["-e",'require("node:fs").writeFileSync(process.env.MOSS_QA_INSTALL_MARKER,"verified-install")'],{stdio:"ignore",env:process.env})};
vm.runInNewContext(${JSON.stringify(SSH_REMOTE_ARCHIVE_RECEIVER)},{require:name=>name==="node:child_process"?installer:require(name),process,setTimeout});`,
  );
  const child = spawn(process.execPath, [wrapper], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      TEMP: root,
      TMP: root,
      MOSS_SSH_ARCHIVE_SHA256: hash,
      MOSS_SSH_ARCHIVE_BYTES: String(archive.length),
      MOSS_SSH_UPLOAD_ID: "owned-qa-profile",
      MOSS_SSH_RUNTIME_ROOT: root,
      MOSS_SSH_PREPARE_DIR: prepare,
      MOSS_SSH_PAYLOAD_DIR: payload,
      MOSS_QA_INSTALL_MARKER: marker,
    },
  }) as ChildProcessWithoutNullStreams;
  let readyResolve!: (offset: number) => void;
  const ready = new Promise<number>((resolve) => {
    readyResolve = resolve;
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", reject);
  });
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
    const match = /MOSS_SSH_PAYLOAD_READY:(\d+)\n/u.exec(errors);
    if (match) readyResolve(Number(match[1]));
  });
  return {
    input: child.stdin,
    ready,
    exited,
    installed: () => fs.existsSync(marker),
    payload,
    cache: path.join(root, "uploads"),
    hash,
    errors: () => errors,
  };
}

describe("SSH binary archive transfer", () => {
  it("retains interrupted bytes and resumes exactly at the partial length", async () => {
    const root = directory(),
      archive = crypto.randomBytes(8192);
    const first = receive(root, archive);
    expect(await first.ready).toBe(0);
    first.input.end(archive.subarray(0, 2048));
    expect(await first.exited).toBe(76);
    expect(first.installed()).toBe(false);
    const retry = receive(root, archive);
    expect(await retry.ready).toBe(2048);
    retry.input.end(archive.subarray(2048));
    expect(await retry.exited).toBe(0);
    expect(retry.installed()).toBe(true);
    const complete = path.join(retry.cache, `${retry.hash}-owned-qa-profile.tar.gz`);
    expect(fs.readFileSync(complete)).toEqual(archive);
  });

  it("rejects a corrupted partial before any installation command", async () => {
    const root = directory(),
      archive = crypto.randomBytes(8192);
    const first = receive(root, archive);
    await first.ready;
    first.input.end(Buffer.alloc(2048, 1));
    await first.exited;
    const retry = receive(root, archive);
    expect(await retry.ready).toBe(2048);
    retry.input.end(archive.subarray(2048));
    expect(await retry.exited).toBe(72);
    expect(retry.errors()).toContain("MOSS_REMOTE_CHECKSUM_FAILED");
    expect(retry.installed()).toBe(false);
  });

  it("skips cached input and rejects duplicate bytes instead of leaving backpressure", async () => {
    const root = directory(),
      archive = crypto.randomBytes(128);
    const first = receive(root, archive);
    await first.ready;
    first.input.end(archive);
    expect(await first.exited).toBe(0);
    const cached = receive(root, archive);
    expect(await cached.ready).toBe(archive.length);
    cached.input.end();
    expect(await cached.exited).toBe(0);
    const duplicate = receive(root, archive);
    expect(await duplicate.ready).toBe(archive.length);
    duplicate.input.end(archive);
    expect(await duplicate.exited).toBe(72);
    expect(duplicate.installed()).toBe(false);
  });

  it("uses installed dependencies without demanding an absent archive cache", async () => {
    const root = directory(),
      archive = crypto.randomBytes(128);
    fs.mkdirSync(path.join(root, "payload"));
    fs.writeFileSync(path.join(root, "payload/.dependencies-ready"), "owned-runtime");
    const installed = receive(root, archive);
    expect(await installed.ready).toBe(archive.length);
    installed.input.end();
    expect(await installed.exited).toBe(0);
    expect(fs.readdirSync(installed.cache)).toEqual([]);
  });
});
