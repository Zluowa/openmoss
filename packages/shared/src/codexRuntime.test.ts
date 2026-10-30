import { describe, expect, it } from "vitest";

import {
  BundledCodexRuntimeUnavailableError,
  formatBundledCodexExecutableVersionMismatch,
  MOSS_BUNDLED_CODEX_ERROR_ENV_KEY,
  MOSS_BUNDLED_CODEX_PATH_ENV_KEY,
  MOSS_BUNDLED_CODEX_VERSION,
  parseCodexExecutableVersion,
  resolveCodexExecutable,
  resolveCodexRuntimeTarget,
} from "./codexRuntime";

describe("codexRuntime", () => {
  it("pins the public Codex npm runtime version", () => {
    expect(MOSS_BUNDLED_CODEX_VERSION).toBe("0.163.0");
  });

  it("parses the executable version and formats the exact-bundle diagnostic", () => {
    expect(parseCodexExecutableVersion("codex-cli 0.163.0\n")).toBe(MOSS_BUNDLED_CODEX_VERSION);
    expect(parseCodexExecutableVersion("codex-cli 0.151.0-alpha.7.1\n")).toBe("0.151.0-alpha.7.1");
    expect(parseCodexExecutableVersion("Codex development build")).toBeNull();
    expect(parseCodexExecutableVersion("codex-cli 0.151.0-alpha.7.1+untrusted")).toBeNull();
    expect(formatBundledCodexExecutableVersionMismatch("0.145.0")).toBe(
      "Bundled Codex executable version mismatch: Moss expected v0.163.0 but the executable reported v0.145.0. Reinstall Moss before using this runtime.",
    );
  });

  it.each([
    [
      "darwin",
      "arm64",
      "@openai/codex-darwin-arm64",
      "npm:@openai/codex@0.163.0-darwin-arm64",
      "aarch64-apple-darwin",
      "codex",
    ],
    [
      "darwin",
      "x64",
      "@openai/codex-darwin-x64",
      "npm:@openai/codex@0.163.0-darwin-x64",
      "x86_64-apple-darwin",
      "codex",
    ],
    [
      "linux",
      "arm64",
      "@openai/codex-linux-arm64",
      "npm:@openai/codex@0.163.0-linux-arm64",
      "aarch64-unknown-linux-musl",
      "codex",
    ],
    [
      "linux",
      "x64",
      "@openai/codex-linux-x64",
      "npm:@openai/codex@0.163.0-linux-x64",
      "x86_64-unknown-linux-musl",
      "codex",
    ],
    [
      "win32",
      "arm64",
      "@openai/codex-win32-arm64",
      "npm:@openai/codex@0.163.0-win32-arm64",
      "aarch64-pc-windows-msvc",
      "codex.exe",
    ],
    [
      "win32",
      "x64",
      "@openai/codex-win32-x64",
      "npm:@openai/codex@0.163.0-win32-x64",
      "x86_64-pc-windows-msvc",
      "codex.exe",
    ],
  ] as const)(
    "maps %s/%s to its public optional package",
    (platform, arch, packageName, npmAliasSpecifier, targetTriple, executableName) => {
      expect(resolveCodexRuntimeTarget({ platform, arch })).toEqual({
        platform,
        arch,
        packageName,
        npmAliasSpecifier,
        targetTriple,
        executableName,
      });
    },
  );

  it("rejects unsupported targets without guessing another architecture", () => {
    expect(resolveCodexRuntimeTarget({ platform: "freebsd", arch: "x64" })).toBeNull();
    expect(resolveCodexRuntimeTarget({ platform: "darwin", arch: "ia32" })).toBeNull();
  });

  it("prefers an explicit user binary over the bundled runtime", () => {
    expect(
      resolveCodexExecutable({
        configuredBinaryPath: " /custom/codex ",
        env: {
          [MOSS_BUNDLED_CODEX_PATH_ENV_KEY]: "/app/bundled/codex",
        },
      }),
    ).toEqual({ binaryPath: "/custom/codex", source: "configured" });
  });

  it("keeps an explicit user binary usable when the packaged runtime is unavailable", () => {
    expect(
      resolveCodexExecutable({
        configuredBinaryPath: "/custom/codex",
        env: {
          [MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]: "Bundled Codex is missing. Reinstall Moss.",
        },
      }),
    ).toEqual({ binaryPath: "/custom/codex", source: "configured" });
  });

  it.each([undefined, "", " codex "])(
    "uses the bundled runtime for the default configured path %s",
    (configuredBinaryPath) => {
      expect(
        resolveCodexExecutable({
          configuredBinaryPath,
          env: {
            [MOSS_BUNDLED_CODEX_PATH_ENV_KEY]: " /app/bundled/codex ",
          },
        }),
      ).toEqual({ binaryPath: "/app/bundled/codex", source: "bundled" });
    },
  );

  it("classifies a legacy persisted copy of the active bundle path as bundled", () => {
    expect(
      resolveCodexExecutable({
        configuredBinaryPath: " /app/bundled/codex ",
        env: {
          [MOSS_BUNDLED_CODEX_PATH_ENV_KEY]: " /app/bundled/codex ",
        },
      }),
    ).toEqual({ binaryPath: "/app/bundled/codex", source: "bundled" });
  });

  it("keeps PATH compatibility when no bundled runtime is available", () => {
    expect(resolveCodexExecutable({ configuredBinaryPath: "codex", env: {} })).toEqual({
      binaryPath: "codex",
      source: "path",
    });
  });

  it("fails closed instead of falling back to a global Codex when the bundle is broken", () => {
    expect(() =>
      resolveCodexExecutable({
        configuredBinaryPath: "codex",
        env: {
          [MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]: "Bundled Codex is missing. Reinstall Moss.",
          PATH: "/fake/global/codex/bin:/usr/bin:/bin",
        },
      }),
    ).toThrowError(BundledCodexRuntimeUnavailableError);
    expect(() =>
      resolveCodexExecutable({
        env: {
          [MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]: "Bundled Codex is missing. Reinstall Moss.",
          PATH: "/fake/global/codex/bin:/usr/bin:/bin",
        },
      }),
    ).toThrow("Bundled Codex is missing. Reinstall Moss.");
  });
});
