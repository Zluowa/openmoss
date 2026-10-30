import * as Path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  bundledClaudeRelativePath,
  MOSS_BUNDLED_CLAUDE_CODE_VERSION,
  parseBundledClaudeCodeVersion,
  prepareBundledClaudeStartupVersion,
  resolveBundledClaudeBinary,
} from "./bundledClaude";

const exactVersionProbe = () => `${MOSS_BUNDLED_CLAUDE_CODE_VERSION} (Claude Code)`;

describe("bundledClaude", () => {
  it("awaits a cold asynchronous preflight and reuses only its verified version", async () => {
    const input = {
      isPackaged: true,
      resourcesPath: "/fixture/cold-claude",
      platform: "win32" as const,
      arch: "x64",
      existsSync: () => true,
    };
    let finish!: (value: string) => void;
    const probe = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    let ready = false;
    const pending = prepareBundledClaudeStartupVersion({ ...input, probeVersionAsync: probe }).then(
      () => {
        ready = true;
      },
    );
    await Promise.resolve();
    expect(ready).toBe(false);
    finish(exactVersionProbe());
    await pending;
    await prepareBundledClaudeStartupVersion({ ...input, probeVersionAsync: probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(resolveBundledClaudeBinary(input)).toBe(
      Path.join(input.resourcesPath, bundledClaudeRelativePath(input)),
    );
  });

  it("keeps failed preflights unverified and still rejects pinned version drift", async () => {
    const input = {
      isPackaged: true,
      resourcesPath: "/fixture/failed-claude",
      platform: "win32" as const,
      arch: "x64",
      existsSync: () => true,
    };
    await expect(
      prepareBundledClaudeStartupVersion({
        ...input,
        probeVersionAsync: async () => {
          throw new Error("fixture timeout");
        },
      }),
    ).rejects.toThrow("fixture timeout");
    await expect(
      prepareBundledClaudeStartupVersion({
        ...input,
        probeVersionAsync: async () => "2.1.230 (Claude Code)",
      }),
    ).rejects.toThrow(/expected 2\.1\.285/);
    expect(() =>
      resolveBundledClaudeBinary({ ...input, probeVersion: () => "2.1.230 (Claude Code)" }),
    ).toThrow(/expected 2\.1\.285/);
  });
  it.each([
    ["darwin", "arm64", "darwin-arm64", "claude"],
    ["darwin", "x64", "darwin-x64", "claude"],
    ["win32", "x64", "win32-x64", "claude.exe"],
  ] as const)(
    "resolves %s/%s from stable packaged resources",
    (platform, arch, folder, executable) => {
      const resourcesPath =
        platform === "win32"
          ? "C:\\Program Files\\Moss\\resources"
          : Path.join(Path.sep, "Applications", "Moss.app", "Contents", "Resources");
      const relativePath = bundledClaudeRelativePath({ platform, arch });
      const expected = Path.join(resourcesPath, relativePath);

      expect(relativePath).toBe(Path.join("claude-runtime", folder, executable));
      expect(
        resolveBundledClaudeBinary({
          isPackaged: true,
          resourcesPath,
          platform,
          arch,
          existsSync: (candidate) => candidate === expected,
          probeVersion: exactVersionProbe,
        }),
      ).toBe(expected);
    },
  );

  it("parses the CLI version output without inspecting binary contents", () => {
    expect(parseBundledClaudeCodeVersion("Claude Code 2.1.285\n")).toBe(
      MOSS_BUNDLED_CLAUDE_CODE_VERSION,
    );
    expect(parseBundledClaudeCodeVersion("Claude Code 2.1.230\n")).toBe("2.1.230");
    expect(parseBundledClaudeCodeVersion("not a version")).toBeNull();
  });

  it("does not require the resource runtime during development", () => {
    expect(
      resolveBundledClaudeBinary({
        isPackaged: false,
        resourcesPath: "/unused",
        existsSync: () => false,
      }),
    ).toBeNull();
  });

  it("fails closed when a packaged runtime is missing or unsupported", () => {
    expect(() =>
      resolveBundledClaudeBinary({
        isPackaged: true,
        resourcesPath: "/resources",
        platform: "darwin",
        arch: "arm64",
        existsSync: () => false,
      }),
    ).toThrow(/missing its Claude runtime/);
    expect(() =>
      resolveBundledClaudeBinary({
        isPackaged: true,
        resourcesPath: "/resources",
        platform: "freebsd",
        arch: "x64",
      }),
    ).toThrow(/unavailable/);
  });

  it("executes the packaged runtime version check during startup and rejects drift", () => {
    const resourcesPath = Path.join(Path.sep, "Applications", "Moss.app", "Contents", "Resources");
    const expected = Path.join(
      resourcesPath,
      bundledClaudeRelativePath({ platform: "darwin", arch: "arm64" }),
    );
    const probes: string[] = [];

    expect(
      resolveBundledClaudeBinary({
        isPackaged: true,
        resourcesPath,
        platform: "darwin",
        arch: "arm64",
        existsSync: (candidate) => candidate === expected,
        probeVersion: ({ sourcePath, platform, arch }) => {
          probes.push(`${sourcePath}|${platform}/${arch}`);
          return exactVersionProbe();
        },
      }),
    ).toBe(expected);
    expect(probes).toEqual([`${expected}|darwin/arm64`]);

    expect(() =>
      resolveBundledClaudeBinary({
        isPackaged: true,
        resourcesPath,
        platform: "darwin",
        arch: "arm64",
        existsSync: (candidate) => candidate === expected,
        probeVersion: () => "2.1.230 (Claude Code)",
      }),
    ).toThrow(/reported 2\.1\.230.*expected 2\.1\.285/);
  });
});
