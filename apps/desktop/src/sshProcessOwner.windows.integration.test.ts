// FILE: sshProcessOwner.windows.integration.test.ts
// Purpose: Prove Windows SSH ownership stops real private proxy descendants.
// Layer: Desktop native process integration tests
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { nativeSshProcessOwner } from "./sshProcessOwner";

const enabled = process.platform === "win32" && process.env.MOSS_QA_SSH_OWNER_NATIVE === "1";
describe.runIf(enabled)("Windows private SSH proxy ownership", () => {
  it.each([false, true])(
    "proves proxy descendant exit with an already-exited root=%s",
    async (rootExits) => {
      const parent = process.env.MOSS_QA_SSH_OWNER_ROOT;
      if (!parent) throw new Error("private native fixture root is required");
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, "owned-"));
      const node = process.env.MOSS_QA_SSH_OWNER_NODE ?? process.execPath;
      const program = join(root, "proxy-root.cjs");
      await writeFile(
        program,
        `const fs=require('node:fs'),cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),120000)'],{stdio:'ignore',env:process.env,cwd:process.cwd()});
fs.writeFileSync('pids.json',JSON.stringify({root:process.pid,child:child.pid}));
${rootExits ? "setTimeout(()=>process.exit(0),250);" : "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),120000);"}
`,
      );
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (
          /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/iu.test(
            key,
          )
        )
          env[key] = value;
      }
      for (const key of [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "MOSS_HOME",
        "CODEX_HOME",
        "CODEX_SQLITE_HOME",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      ])
        env[key] = root;
      env.PATH = process.env.SystemRoot + "\\System32";
      let child!: ChildProcessWithoutNullStreams;
      await nativeSshProcessOwner.spawn({
        beforeSpawn: () => undefined,
        signal: new AbortController().signal,
        spawn: () =>
          spawn(node, [program], {
            cwd: root,
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        bind: (created) => {
          child = created;
          child.stdout.resume();
          child.stderr.resume();
          return child;
        },
      });
      let pids: { root: number; child: number } | undefined;
      try {
        const readyDeadline = Date.now() + 10_000;
        while (Date.now() < readyDeadline && !pids) {
          try {
            pids = JSON.parse(await readFile(join(root, "pids.json"), "utf8"));
          } catch {
            await delay(25);
          }
        }
        if (!pids || !Number.isInteger(pids.root) || !Number.isInteger(pids.child))
          throw new Error("private fixture PID receipt missing");
        if (rootExits) {
          const exitDeadline = Date.now() + 5000;
          while (child.exitCode === null && Date.now() < exitDeadline) await delay(25);
          expect(child.exitCode).toBe(0);
        }
        const proof = nativeSshProcessOwner.stop(child);
        expect(nativeSshProcessOwner.stop(child)).toBe(proof);
        await proof;
        const alive = (pid: number) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        expect(alive(pids.root)).toBe(false);
        expect(alive(pids.child)).toBe(false);
        console.log(JSON.stringify({ nativeSshOwner: true, rootExits, pids, allGone: true }));
      } finally {
        await nativeSshProcessOwner.stop(child);
      }
    },
    90_000,
  );
});
