import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendDirectoriesToPathEnv,
  buildOpenCodeServerProcessEnv,
  commandExistsOnPath,
  directoriesContainingCommand,
  isBrokenWindowsCommandShim,
  openCodeBinarySearchDirectories,
  resolveOpenCodeBinaryPath,
  resolveWindowsLocalAppDataBinary,
} from "./providerBinaryResolution.ts";

const missingPath = () => false;

describe("commandExistsOnPath", () => {
  it.skipIf(process.platform === "win32")(
    "rejects non-executable files and directories in PATH",
    () => {
      const home = mkdtempSync(join(tmpdir(), "synara-provider-cli-"));
      const commandPath = join(home, "codex");
      const options = { platform: "linux" as const, env: { PATH: home } };
      try {
        mkdirSync(commandPath);
        expect(commandExistsOnPath("codex", options)).toBe(false);

        rmSync(commandPath, { recursive: true });
        writeFileSync(commandPath, "#!/bin/sh");
        chmodSync(commandPath, 0o644);
        expect(commandExistsOnPath("codex", options)).toBe(false);

        chmodSync(commandPath, 0o755);
        expect(commandExistsOnPath("codex", options)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("respects an injected executable predicate over a permissive pathExists mock", () => {
    expect(
      commandExistsOnPath("cursor-agent", {
        platform: "win32",
        env: { Path: "C:\\Tools", PATHEXT: ".CMD" },
        pathExists: () => true,
        isExecutable: (path) => path.endsWith("cursor-agent.CMD"),
      }),
    ).toBe(true);
    expect(
      commandExistsOnPath("cursor-agent", {
        platform: "win32",
        env: { Path: "C:\\Tools", PATHEXT: ".CMD" },
        pathExists: () => true,
        isExecutable: () => false,
      }),
    ).toBe(false);
  });
});

describe("resolveWindowsLocalAppDataBinary", () => {
  it("rejects a non-executable candidate even when the path exists", () => {
    const directory = "C:\\Users\\tester\\AppData\\Local";
    const candidate = "C:\\Users\\tester\\AppData\\Local\\devin\\cli\\bin\\devin.exe";
    const paths = [["devin", "cli", "bin", "devin.exe"]] as const;
    const options = {
      platform: "win32" as const,
      env: { LOCALAPPDATA: directory },
      pathExists: () => true,
    };
    expect(
      resolveWindowsLocalAppDataBinary(paths, { ...options, isExecutable: () => false }),
    ).toBeUndefined();
    expect(
      resolveWindowsLocalAppDataBinary(paths, {
        ...options,
        isExecutable: (path) => path === candidate,
      }),
    ).toBe(candidate);
  });
});

describe("openCodeBinarySearchDirectories", () => {
  it.skipIf(process.platform === "win32").each([
    [".nvm", "versions", "node", "v24.13.1", "bin"],
    ["Library", "Application Support", "fnm", "node-versions", "v24.13.1", "installation", "bin"],
    [".local", "share", "fnm", "node-versions", "v24.13.1", "installation", "bin"],
  ])("discovers a new version-manager install after an earlier lookup (%j)", (...segments) => {
    const home = mkdtempSync(join(tmpdir(), "moss-opencode-refresh-"));
    const env = { HOME: home, PATH: "/usr/bin:/bin" };
    const binDirectory = join(home, ...segments);
    try {
      expect(openCodeBinarySearchDirectories({ env })).not.toContain(binDirectory);
      mkdirSync(binDirectory, { recursive: true });
      const binaryPath = join(binDirectory, "opencode");
      writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binaryPath, 0o755);

      expect(openCodeBinarySearchDirectories({ env })).toContain(binDirectory);
      expect(buildOpenCodeServerProcessEnv({ baseEnv: env }).PATH?.split(":")).toContain(
        binDirectory,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("includes installer, bun, local, and version-manager bin dirs under HOME on posix", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "darwin",
      env: { HOME: "/home/test" },
      pathExists: missingPath,
    });
    expect(dirs).toContain("/home/test/.opencode/bin");
    expect(dirs).toContain("/home/test/.bun/bin");
    expect(dirs).toContain("/home/test/.local/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/home/test/.local/share/pnpm");
    expect(dirs).toContain("/home/test/Library/pnpm");
    expect(dirs).toContain("/home/test/.yarn/bin");
    // The installer's own dir leads the list.
    expect(dirs[0]).toBe("/home/test/.opencode/bin");
  });

  it("honors PNPM_HOME and npm_config_prefix on posix", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "linux",
      env: {
        HOME: "/home/test",
        PNPM_HOME: "/opt/custom/pnpm",
        npm_config_prefix: "/opt/npm-prefix",
      },
      pathExists: missingPath,
    });
    expect(dirs).toContain("/opt/custom/pnpm");
    expect(dirs).toContain("/opt/npm-prefix/bin");
  });

  it("honors PNPM_HOME and npm_config_prefix without HOME on posix", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "linux",
      env: {
        PNPM_HOME: "/opt/custom/pnpm",
        npm_config_prefix: "/opt/npm-prefix",
      },
      pathExists: missingPath,
    });
    expect(dirs).toContain("/opt/custom/pnpm");
    expect(dirs).toContain("/opt/npm-prefix/bin");
  });

  it("includes installer, bun, scoop, and npm dirs under USERPROFILE on windows", () => {
    const dirs = openCodeBinarySearchDirectories({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\test", PNPM_HOME: "D:\\pnpm-home" },
      pathExists: missingPath,
    });
    expect(dirs).toContain("C:\\Users\\test\\.opencode\\bin");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\Programs\\opencode");
    expect(dirs).toContain("C:\\Users\\test\\.bun\\bin");
    expect(dirs).toContain("C:\\Users\\test\\scoop\\shims");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Roaming\\npm");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\pnpm");
    expect(dirs).toContain("C:\\Users\\test\\AppData\\Local\\Yarn\\bin");
    expect(dirs).toContain("D:\\pnpm-home");
  });
});

describe("directoriesContainingCommand", () => {
  it("keeps only directories holding an executable command file on posix", () => {
    const dirs = directoriesContainingCommand(
      "opencode",
      ["/opt/a/bin", "/opt/b/bin", "/opt/c/bin"],
      {
        platform: "linux",
        env: {},
        isExecutable: (path) => path === "/opt/a/bin/opencode" || path === "/opt/c/bin/opencode",
      },
    );
    expect(dirs).toEqual(["/opt/a/bin", "/opt/c/bin"]);
  });

  it("matches PATHEXT executable names on windows", () => {
    const dirs = directoriesContainingCommand("opencode", ["C:\\tools\\oc", "D:\\none"], {
      platform: "win32",
      env: { PATHEXT: ".EXE;.CMD" },
      isExecutable: (path) => path === "C:\\tools\\oc\\opencode.EXE",
    });
    expect(dirs).toEqual(["C:\\tools\\oc"]);
  });
});

describe("appendDirectoriesToPathEnv", () => {
  it("appends only directories that exist, preserving PATH order", () => {
    const env = appendDirectoriesToPathEnv(
      { PATH: "/usr/bin", HOME: "/home/test" },
      ["/opt/opencode/bin", "/missing/bin", "/opt/bun/bin"],
      {
        platform: "darwin",
        pathExists: (path) => path !== "/missing/bin",
      },
    );
    expect(env.PATH).toBe("/usr/bin:/opt/opencode/bin:/opt/bun/bin");
  });

  it("deduplicates directories already on PATH", () => {
    const env = appendDirectoriesToPathEnv(
      { PATH: "/usr/bin:/opt/opencode/bin" },
      ["/opt/opencode/bin", "/opt/bun/bin"],
      { platform: "linux", pathExists: () => true },
    );
    expect(env.PATH).toBe("/usr/bin:/opt/opencode/bin:/opt/bun/bin");
  });

  it("respects the Windows Path key casing and separator", () => {
    const env = appendDirectoriesToPathEnv(
      { Path: "C:\\Windows" },
      ["C:\\tools\\opencode", "C:\\other"],
      { platform: "win32", pathExists: () => true },
    );
    expect(env.Path).toBe("C:\\Windows;C:\\tools\\opencode;C:\\other");
    expect(env.PATH).toBeUndefined();
  });

  it("returns the env unchanged when nothing exists to append", () => {
    const env = appendDirectoriesToPathEnv({ PATH: "/usr/bin" }, ["/nope/bin"], {
      platform: "darwin",
      pathExists: missingPath,
    });
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("resolveOpenCodeBinaryPath", () => {
  // A fake Windows disk: the owner's stale wrapper sits first on PATH and points at a
  // desktop install folder that has since moved.
  const LOCAL_BIN = "C:\\Users\\me\\.local\\bin";
  const NPM_BIN = "C:\\Users\\me\\AppData\\Roaming\\npm";
  const LOCALAPPDATA = "C:\\Users\\me\\AppData\\Local";
  const STALE_SHIM = [
    "@echo off",
    "rem OpenCode shim -> desktop CLI",
    '"%LOCALAPPDATA%\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe" %*',
  ].join("\r\n");
  const NPM_SHIM = [
    "@ECHO off",
    "SET dp0=%~dp0",
    'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
    '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*',
  ].join("\r\n");

  function fakeDisk(files: Record<string, string>) {
    const byLowerPath = new Map(
      Object.entries(files).map(([path, text]) => [path.toLowerCase(), text] as const),
    );
    const exists = (path: string) => byLowerPath.has(path.toLowerCase());
    return {
      platform: "win32" as const,
      env: {
        PATH: [LOCAL_BIN, NPM_BIN].join(";"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        LOCALAPPDATA,
      },
      pathExists: exists,
      isExecutable: exists,
      readText: (path: string) => byLowerPath.get(path.toLowerCase()),
    };
  }

  it("keeps the plain name when the first opencode on PATH works", async () => {
    const disk = fakeDisk({
      [`${NPM_BIN}\\opencode.cmd`]: NPM_SHIM,
      [`${NPM_BIN}\\node_modules\\opencode-ai\\bin\\opencode`]: "",
    });
    expect(await resolveOpenCodeBinaryPath(undefined, disk)).toBe("opencode");
  });

  it("skips a wrapper whose target is gone for the next opencode on PATH", async () => {
    const disk = fakeDisk({
      [`${LOCAL_BIN}\\opencode.cmd`]: STALE_SHIM,
      [`${NPM_BIN}\\opencode.cmd`]: NPM_SHIM,
      [`${NPM_BIN}\\node_modules\\opencode-ai\\bin\\opencode`]: "",
    });
    expect(await isBrokenWindowsCommandShim(`${LOCAL_BIN}\\opencode.cmd`, disk)).toBe(true);
    // npm's shim names a missing node.exe too, but its real target exists.
    expect(await isBrokenWindowsCommandShim(`${NPM_BIN}\\opencode.cmd`, disk)).toBe(false);
    expect((await resolveOpenCodeBinaryPath(undefined, disk)).toLowerCase()).toBe(
      `${NPM_BIN}\\opencode.cmd`.toLowerCase(),
    );
  });

  it("prefers OpenCode desktop's current CLI when the stale wrapper aimed at the desktop CLI", async () => {
    const desktopCli = `${LOCALAPPDATA}\\Programs\\ai.opencode.desktop\\resources\\opencode-cli.exe`;
    const disk = fakeDisk({
      [`${LOCAL_BIN}\\opencode.cmd`]: STALE_SHIM,
      [`${NPM_BIN}\\opencode.cmd`]: NPM_SHIM,
      [`${NPM_BIN}\\node_modules\\opencode-ai\\bin\\opencode`]: "",
      [desktopCli]: "",
    });
    expect(await resolveOpenCodeBinaryPath(undefined, disk)).toBe(desktopCli);
  });

  it("falls back to OpenCode desktop's bundled CLI when PATH has only the stale wrapper", async () => {
    const desktopCli = `${LOCALAPPDATA}\\Programs\\ai.opencode.desktop\\resources\\opencode-cli.exe`;
    const disk = fakeDisk({ [`${LOCAL_BIN}\\opencode.cmd`]: STALE_SHIM, [desktopCli]: "" });
    expect(await resolveOpenCodeBinaryPath(undefined, disk)).toBe(desktopCli);
  });

  it("finds OpenCode desktop's CLI when no opencode is on PATH at all", async () => {
    const desktopCli = `${LOCALAPPDATA}\\Programs\\ai.opencode.desktop\\resources\\opencode-cli.exe`;
    expect(await resolveOpenCodeBinaryPath(undefined, fakeDisk({ [desktopCli]: "" }))).toBe(
      desktopCli,
    );
    expect(await resolveOpenCodeBinaryPath(undefined, fakeDisk({}))).toBe("opencode");
  });

  it("never second-guesses a configured binary or a shim it cannot read statically", async () => {
    const disk = fakeDisk({
      [`${LOCAL_BIN}\\opencode.cmd`]: '"%MOSS_UNSET_VARIABLE%\\opencode.exe" %*',
    });
    expect(await resolveOpenCodeBinaryPath("D:\\tools\\opencode.exe", disk)).toBe(
      "D:\\tools\\opencode.exe",
    );
    expect(await resolveOpenCodeBinaryPath(undefined, disk)).toBe("opencode");
    expect(await resolveOpenCodeBinaryPath(undefined, { ...disk, platform: "linux" })).toBe(
      "opencode",
    );
  });
});
