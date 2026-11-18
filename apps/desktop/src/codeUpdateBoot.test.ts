import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { startMoss, type CodeUpdateBootDeps, type CodeUpdateBootFs } from "./codeUpdateBoot";
import type { CodeUpdateBootHandle } from "./codeUpdateHealth";

const STORE = Path.resolve("/store");
const SHELL = "a".repeat(40);
const B = "bbbbbbbbbbbb-2222222222222222";
const INSTALLED_MAIN = Path.resolve("/app/resources/app.asar/apps/desktop/dist-electron/main.js");
const B_MAIN = Path.join(STORE, B, "app.asar", "apps", "desktop", "dist-electron", "main.js");

/** An in-memory store: path -> file text (or a size for the archive). */
function memoryFs(files: Map<string, string | { size: number }>): CodeUpdateBootFs {
  return {
    readFileSync: (file) => {
      const value = files.get(Path.resolve(file));
      if (typeof value !== "string") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return value;
    },
    writeFileSync: (file, data) => void files.set(Path.resolve(file), data),
    appendFileSync: (file, data) =>
      void files.set(
        Path.resolve(file),
        `${(files.get(Path.resolve(file)) as string) ?? ""}${data}`,
      ),
    renameSync: (from, to) => {
      files.set(Path.resolve(to), files.get(Path.resolve(from))!);
      files.delete(Path.resolve(from));
    },
    mkdirSync: () => undefined,
    statSync: (file) => {
      const value = files.get(Path.resolve(file));
      if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: typeof value === "string" ? value.length : value.size };
    },
    readdirSync: (dir) => [
      ...new Set(
        [...files.keys()]
          .filter((key) => key.startsWith(`${Path.resolve(dir)}${Path.sep}`))
          .map((key) => key.slice(Path.resolve(dir).length + 1).split(Path.sep)[0]!),
      ),
    ],
    rmSync: (target) => {
      for (const key of [...files.keys()])
        if (key.startsWith(Path.resolve(target))) files.delete(key);
    },
  };
}

function storeWithPending(options: { installedJson?: boolean } = {}) {
  const files = new Map<string, string | { size: number }>();
  files.set(
    Path.join(STORE, "state.json"),
    JSON.stringify({
      schema: 1,
      active: null,
      pending: B,
      trial: null,
      packages: [B],
      rebuild: null,
      rejected: {},
    }),
  );
  if (options.installedJson !== false) {
    files.set(
      Path.join(STORE, B, "installed.json"),
      JSON.stringify({
        schema: 1,
        id: B,
        commit: "c".repeat(40),
        codeVersion: "v",
        channel: "preview",
        sequence: 5,
        shellCommit: SHELL,
        archiveSize: 1000,
        archiveSha256: "0".repeat(64),
        migrations: { latest: 170, readerFloor: 169 },
        installedAt: "t",
      }),
    );
  }
  files.set(Path.join(STORE, B, "app.asar"), { size: 1000 });
  return files;
}

function deps(
  overrides: Partial<CodeUpdateBootDeps> & { files?: Map<string, string | { size: number }> } = {},
) {
  const files = overrides.files ?? new Map();
  const loaded: string[] = [];
  const handles: Array<CodeUpdateBootHandle | null> = [];
  const app = { relaunch: vi.fn(), exit: vi.fn(), once: vi.fn() };
  const timers: Array<() => void> = [];
  const fsCalls = vi.fn(() => memoryFs(files));
  const value: CodeUpdateBootDeps = {
    env: { MOSS_CODE_UPDATES: "1", MOSS_CODE_UPDATE_DIR: STORE },
    platform: "win32",
    homeDir: Path.resolve("/home"),
    pid: 100,
    installedRoot: Path.resolve("/app/resources/app.asar"),
    installedMain: INSTALLED_MAIN,
    fs: fsCalls,
    readInstalledPackageJson: () => JSON.stringify({ mossCommitHash: SHELL }),
    loadModule: (file) => void loaded.push(file),
    app: () => app,
    isProcessAlive: () => false,
    now: () => "2026-11-18T00:00:00.000Z",
    setTimer: (callback) => {
      timers.push(callback);
      return {};
    },
    clearTimer: () => undefined,
    setHandle: (handle) => void handles.push(handle),
    logError: vi.fn(),
    ...overrides,
  };
  const state = () => JSON.parse(files.get(Path.join(STORE, "state.json")) as string);
  return { value, files, loaded, handles, app, timers, fsCalls, state };
}

describe("startMoss", () => {
  it("with the switch off loads the installed code and touches nothing else", () => {
    const run = deps({ env: {} });
    startMoss(run.value);
    expect(run.loaded).toEqual([INSTALLED_MAIN]);
    expect(run.fsCalls).not.toHaveBeenCalled();
  });

  it("stays off on macOS even with the switch", () => {
    const run = deps({ platform: "darwin" });
    startMoss(run.value);
    expect(run.loaded).toEqual([INSTALLED_MAIN]);
    expect(run.fsCalls).not.toHaveBeenCalled();
  });

  it("starts the installed code when the boot itself throws, whatever throws", () => {
    for (const broken of [
      {
        fs: () => {
          throw new Error("store unreadable");
        },
      },
      {
        now: () => {
          throw new Error("clock");
        },
      },
      {
        fs: () => ({
          ...memoryFs(storeWithPending()),
          readFileSync: () => {
            throw new Error("EACCES");
          },
          writeFileSync: () => {
            throw new Error("ENOSPC");
          },
        }),
      },
    ] satisfies Array<Partial<CodeUpdateBootDeps>>) {
      const run = deps(broken);
      startMoss(run.value);
      expect(run.loaded).toEqual([INSTALLED_MAIN]);
    }
  });

  it("starts the installed code when the store is empty or its state is damaged", () => {
    const empty = deps();
    startMoss(empty.value);
    expect(empty.loaded).toEqual([INSTALLED_MAIN]);

    const files = new Map<string, string | { size: number }>([
      [Path.join(STORE, "state.json"), "{half-writ"],
    ]);
    const damaged = deps({ files });
    startMoss(damaged.value);
    expect(damaged.loaded).toEqual([INSTALLED_MAIN]);
    // The desktop log gets the boot's events: it says why.
    expect(damaged.handles.at(-1)?.events).toContain(
      "code-update state.json damaged; starting the installed code",
    );
    expect(empty.handles.at(-1)?.events).toEqual([]);
  });

  it("says why when the store cannot be read", () => {
    const run = deps({
      fs: () => ({
        ...memoryFs(new Map()),
        readFileSync: () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      }),
    });
    startMoss(run.value);
    expect(run.loaded).toEqual([INSTALLED_MAIN]);
    expect(run.handles.at(-1)?.events).toContain(
      "code-update store unreadable (EACCES); starting the installed code",
    );
  });

  it("refuses a half-written update (no installed.json) and starts the installed code", () => {
    const run = deps({ files: storeWithPending({ installedJson: false }) });
    startMoss(run.value);
    expect(run.loaded).toEqual([INSTALLED_MAIN]);
    expect(run.state().rejected[B]).toMatchObject({ reason: "damaged" });
  });

  it("starts a pending update as a trial from the store", () => {
    const run = deps({ files: storeWithPending() });
    startMoss(run.value);
    expect(run.loaded).toEqual([B_MAIN]);
    expect(run.handles.at(-1)).toMatchObject({ id: B, trial: true, sequence: 5 });
    expect(run.state().trial).toMatchObject({ id: B, running: true, pid: 100 });
  });

  it("rejects an update whose code throws at load and relaunches; it never loads it again", () => {
    const run = deps({
      files: storeWithPending(),
      loadModule: (file) => {
        if (file === B_MAIN) throw new Error("broken on purpose");
      },
    });
    startMoss(run.value);
    expect(run.state().rejected[B]).toMatchObject({
      reason: "load-error",
      detail: "broken on purpose",
    });
    expect(run.app.relaunch).toHaveBeenCalledOnce();
    expect(run.app.exit).toHaveBeenCalledWith(0);

    const next = deps({ files: run.files });
    startMoss(next.value);
    expect(next.loaded).toEqual([INSTALLED_MAIN]);
  });

  it("rejects a trial that is not healthy in time and relaunches", () => {
    const run = deps({ files: storeWithPending() });
    startMoss(run.value);
    run.timers[0]!();
    expect(run.state().rejected[B]).toMatchObject({ reason: "timeout" });
    expect(run.app.relaunch).toHaveBeenCalledOnce();
  });

  it("does not reject a trial that reported healthy before the deadline", () => {
    const run = deps({ files: storeWithPending() });
    startMoss(run.value);
    run.handles.at(-1)!.reportHealthy();
    run.timers[0]!();
    expect(run.state()).toMatchObject({ active: B, trial: null, rejected: {} });
    expect(run.app.relaunch).not.toHaveBeenCalled();
  });

  it("lets a throw from the installed code itself reach Electron, as today", () => {
    const run = deps({
      env: {},
      loadModule: () => {
        throw new Error("installed code broken");
      },
    });
    expect(() => startMoss(run.value)).toThrow("installed code broken");
  });
});
