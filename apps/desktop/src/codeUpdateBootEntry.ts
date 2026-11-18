// FILE: codeUpdateBootEntry.ts
// Purpose: The packaged app's entry (package.json `main` = dist-electron/boot.js): wires the real
//          dependencies into the boot (codeUpdateBoot.ts) and runs it. Nothing else.
// Layer: Desktop shell entry. Never replaced by a code update.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { startMoss, type CodeUpdateBootApp, type CodeUpdateBootFs } from "./codeUpdateBoot";
import type { CodeUpdateBootHandle } from "./codeUpdateHealth";

// A computed path is never bundled: the code loaded here is chosen at run time.
const loadModule = (file: string): unknown => require(file);

const installedRoot = Path.resolve(__dirname, "..", "..", "..");

startMoss({
  env: process.env,
  platform: process.platform,
  homeDir: OS.homedir(),
  pid: process.pid,
  installedRoot,
  installedMain: Path.join(__dirname, "main.js"),
  fs: () => {
    try {
      return loadModule("original-fs") as CodeUpdateBootFs;
    } catch {
      return FS as unknown as CodeUpdateBootFs;
    }
  },
  readInstalledPackageJson: () => FS.readFileSync(Path.join(installedRoot, "package.json"), "utf8"),
  loadModule,
  app: () => {
    try {
      return (loadModule("electron") as { app: CodeUpdateBootApp }).app;
    } catch {
      return null;
    }
  },
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  now: () => new Date().toISOString(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
  setHandle: (handle: CodeUpdateBootHandle | null) => {
    const holder = globalThis as { __mossCodeUpdate?: CodeUpdateBootHandle };
    if (handle) holder.__mossCodeUpdate = handle;
    else delete holder.__mossCodeUpdate;
  },
  logError: (message, error) => console.error(message, error),
});
