import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCodexNativeLaunch } from "./codexNativeLaunch";

// npm's Windows shim for @openai/codex, as `npm install -g @openai/codex` writes it.
const NPM_CODEX_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function npmPrefix(options: { readonly vendor: "nested" | "sibling" | "package" | "none" }) {
  const prefix = mkdtempSync(join(tmpdir(), "moss-codex-native-"));
  roots.push(prefix);
  const packageRoot = join(prefix, "node_modules", "@openai", "codex");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(packageRoot, "bin", "codex.js"), "// launcher");
  writeFileSync(join(prefix, "codex.cmd"), NPM_CODEX_SHIM);
  const vendorRoot =
    options.vendor === "nested"
      ? join(packageRoot, "node_modules", "@openai", "codex-win32-x64")
      : options.vendor === "sibling"
        ? join(prefix, "node_modules", "@openai", "codex-win32-x64")
        : packageRoot;
  const binary = join(vendorRoot, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  if (options.vendor !== "none") {
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "");
  }
  const env = {
    PATH: prefix,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    CODEX_MANAGED_BY_BUN: "1",
    CODEX_HOME: "C:\\codex-home",
  };
  return { prefix, packageRoot, binary, env };
}

describe("resolveCodexNativeLaunch", () => {
  it("leaves every other platform alone", () => {
    expect(
      resolveCodexNativeLaunch({
        binaryPath: "codex",
        env: { PATH: "/usr/bin" },
        platform: "linux",
      }),
    ).toBeNull();
  });

  describe.runIf(process.platform === "win32")("on Windows", () => {
    for (const vendor of ["nested", "sibling", "package"] as const) {
      it(`starts the native binary an npm shim would start (${vendor} platform package)`, () => {
        const install = npmPrefix({ vendor });
        for (const binaryPath of ["codex", join(install.prefix, "codex.cmd")]) {
          const launch = resolveCodexNativeLaunch({
            binaryPath,
            env: install.env,
            arch: "x64",
          });
          expect(launch?.command.toLowerCase()).toBe(install.binary.toLowerCase());
          expect(launch?.packageRoot.toLowerCase()).toBe(install.packageRoot.toLowerCase());
          // The two variables codex.js sets; another package manager's marker is cleared.
          expect(launch?.env.CODEX_MANAGED_BY_NPM).toBe("1");
          expect(launch?.env.CODEX_MANAGED_BY_BUN).toBeUndefined();
          expect(launch?.env.CODEX_MANAGED_PACKAGE_ROOT?.toLowerCase()).toBe(
            install.packageRoot.toLowerCase(),
          );
          expect(launch?.env.CODEX_HOME).toBe("C:\\codex-home");
        }
      });
    }

    it("falls back to the shim when the platform package is missing", () => {
      const install = npmPrefix({ vendor: "none" });
      expect(resolveCodexNativeLaunch({ binaryPath: "codex", env: install.env })).toBeNull();
    });

    it("never rewrites a native binary or a shim that runs something else", () => {
      const install = npmPrefix({ vendor: "nested" });
      expect(resolveCodexNativeLaunch({ binaryPath: install.binary, env: install.env })).toBeNull();
      writeFileSync(join(install.prefix, "codex.cmd"), '@echo off\r\n"C:\\tools\\codex.exe" %*');
      expect(resolveCodexNativeLaunch({ binaryPath: "codex", env: install.env })).toBeNull();
    });
  });
});
