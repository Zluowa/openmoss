import { spawn, spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  canaryAppCommandPattern,
  canaryCloneArgs,
  parseCanaryArgs,
  resolveCanaryPaths,
  resolveCanaryRef,
  runCanaryCommand,
} from "./canary";

describe("canary tooling", () => {
  it("keeps managed source and Canary data separate from Stable", () => {
    const userHome = Path.resolve("/Users/tester");
    expect(resolveCanaryPaths({}, userHome)).toEqual({
      home: Path.join(userHome, ".moss-canary"),
      source: Path.join(userHome, ".cache/moss-canary/source"),
      state: Path.join(userHome, ".moss-canary/canary-state.json"),
      pid: Path.join(userHome, ".moss-canary/canary.pid"),
      log: Path.join(userHome, ".moss-canary/canary.log"),
    });
  });

  it("supports explicit path overrides", () => {
    expect(
      resolveCanaryPaths(
        {
          MOSS_CANARY_HOME: "/tmp/canary-data",
          MOSS_CANARY_SOURCE: "/tmp/canary-source",
        },
        "/Users/tester",
      ),
    ).toEqual({
      home: Path.resolve("/tmp/canary-data"),
      source: Path.resolve("/tmp/canary-source"),
      state: Path.resolve("/tmp/canary-data/canary-state.json"),
      pid: Path.resolve("/tmp/canary-data/canary.pid"),
      log: Path.resolve("/tmp/canary-data/canary.log"),
    });
  });

  it("accepts legacy Moss Canary path overrides for compatibility", () => {
    expect(
      resolveCanaryPaths(
        {
          MOSS_CANARY_HOME: "/tmp/legacy-canary-data",
          MOSS_CANARY_SOURCE: "/tmp/legacy-canary-source",
        },
        "/Users/tester",
      ),
    ).toMatchObject({
      home: Path.resolve("/tmp/legacy-canary-data"),
      source: Path.resolve("/tmp/legacy-canary-source"),
    });
  });

  it("tracks main by default and accepts a stacked PR ref", () => {
    expect(parseCanaryArgs(["update"])).toEqual({ command: "update", ref: null });
    expect(parseCanaryArgs(["setup", "--ref", "codex/moss-canary"])).toEqual({
      command: "setup",
      ref: "codex/moss-canary",
    });
  });

  it("checks out the managed source during clone so the cleanliness guard starts clean", () => {
    expect(canaryCloneArgs("git@example.com:moss.git", "/tmp/canary-source")).toEqual([
      "clone",
      "--",
      "git@example.com:moss.git",
      "/tmp/canary-source",
    ]);
  });

  it("keeps updating the selected stacked ref until explicitly moved to main", () => {
    expect(resolveCanaryRef(parseCanaryArgs(["setup"]), null)).toBe("main");
    expect(resolveCanaryRef(parseCanaryArgs(["update"]), "codex/moss-canary")).toBe(
      "codex/moss-canary",
    );
    expect(resolveCanaryRef(parseCanaryArgs(["update", "--ref", "main"]), "old-ref")).toBe("main");
  });

  it("matches only the Canary app's main process in its managed checkout", () => {
    const source = "/Users/tester/.cache/synara-canary/source";
    const app = `${source}/apps/desktop/.electron-runtime/Synara Canary.app/Contents/MacOS/Electron`;
    const pattern = new RegExp(canaryAppCommandPattern(source), "u");
    expect(pattern.test(`${app} ${source}/apps/desktop/dist-electron/main.js`)).toBe(true);
    // The app stops its own backend; another checkout's app is not Canary.
    expect(
      pattern.test(`${app} --max-old-space-size=8192 ${source}/apps/server/dist/index.mjs`),
    ).toBe(false);
    expect(
      pattern.test(
        "/Users/tester/synara/apps/desktop/.electron-runtime/Synara (Dev).app/Contents/MacOS/Electron /Users/tester/synara/apps/desktop/dist-electron/main.js",
      ),
    ).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "stops the app that LaunchServices started, even after its launcher is gone",
    async () => {
      const root = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-canary-stop-")));
      // A configured source may be a symlink and contain spaces or regex characters.
      const source = Path.join(root, "a (b)+[c]{d}|$^.*?\\");
      const desktop = Path.join(source, "apps/desktop");
      const main = Path.join(desktop, "dist-electron/main.js");
      FS.mkdirSync(Path.dirname(main), { recursive: true });
      FS.writeFileSync(main, "setTimeout(() => {}, 60_000);\n");
      FS.symlinkSync(source, Path.join(root, "link"));
      const paths = resolveCanaryPaths({
        SYNARA_CANARY_HOME: Path.join(root, "home"),
        SYNARA_CANARY_SOURCE: Path.join(root, "link"),
      });
      // The launcher opens the app by its real path, and the app outlives the launcher.
      const app = spawn(process.execPath, [main], {
        argv0: Path.join(desktop, ".electron-runtime/Synara Canary.app/Contents/MacOS/Electron"),
        stdio: "ignore",
      });
      try {
        await vi.waitFor(() =>
          expect(
            spawnSync("ps", ["-o", "command=", "-p", String(app.pid)], { encoding: "utf8" }).stdout,
          ).toContain(main),
        );
        runCanaryCommand({ command: "stop", ref: null }, paths);
        await vi.waitFor(() => expect(app.signalCode).toBe("SIGTERM"), { timeout: 2_000 });
      } finally {
        app.kill("SIGKILL");
        FS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects unsupported commands and incomplete refs", () => {
    expect(() => parseCanaryArgs(["reset"])).toThrow(/Unknown Canary command/u);
    expect(() => parseCanaryArgs(["update", "--ref"])).toThrow(/Missing value/u);
  });
});
