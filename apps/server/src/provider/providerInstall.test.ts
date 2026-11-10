import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentInstallRegistries,
  appendManagedAgentBinDirectoryToPath,
  managedAgentBinDirectory,
  managedAgentInstallPrefix,
  resolveProviderInstallAction,
  runOneClickAgentInstall,
  type AgentInstallCommandRunner,
} from "./providerInstall.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeMossHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-agent-install-"));
  roots.push(root);
  return root;
}

/**
 * A fake npm: never touches the network or the real npm. It "installs" by writing the
 * command shim into the prefix it was given, and fails for registries listed in `failOn`.
 */
function fakeNpm(input: {
  readonly command: string;
  readonly failOn?: ReadonlyArray<string>;
  readonly versionOutput?: string;
}) {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> = [];
  const run: AgentInstallCommandRunner = ({ command, args, env }) =>
    Effect.sync(() => {
      calls.push({ command, args, env });
      if (command === "fake-npm") {
        const registry = args.find((arg) => arg.startsWith("--registry="))?.slice(11) ?? "";
        if (input.failOn?.includes(registry)) {
          return Option.some({ exitCode: 1, stdout: "", stderr: "npm ERR! network ETIMEDOUT" });
        }
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const binDirectory = managedAgentBinDirectory(prefix);
        mkdirSync(binDirectory, { recursive: true });
        const shim = process.platform === "win32" ? `${input.command}.cmd` : input.command;
        writeFileSync(path.join(binDirectory, shim), "", { mode: 0o755 });
        return Option.some({ exitCode: 0, stdout: "added 1 package", stderr: "" });
      }
      return Option.some({
        exitCode: 0,
        stdout: input.versionOutput ?? "1.2.3",
        stderr: "",
      });
    });
  return { run, calls };
}

const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" });

describe("one-click agent install", () => {
  it("installs into the Moss-managed prefix from the mirror first in mainland China", async () => {
    const mossHomeDir = makeMossHome();
    const npm = fakeNpm({ command: "opencode", versionOutput: "opencode 0.9.1" });
    const progress: string[] = [];
    const outcome = await Effect.runPromise(
      runOneClickAgentInstall({
        provider: "opencode",
        mossHomeDir,
        channel: "cn-mirror",
        env: baseEnv(),
        npmExecutable: "fake-npm",
        run: npm.run,
        onProgress: ({ phase, source }) => Effect.sync(() => progress.push(`${phase}:${source}`)),
      }),
    );

    expect(outcome).toMatchObject({ ok: true, version: "0.9.1", source: "cn-mirror" });
    const install = npm.calls[0]!;
    expect(install.args).toEqual([
      "install",
      "--global",
      "--prefix",
      managedAgentInstallPrefix(mossHomeDir),
      "--registry=https://registry.npmmirror.com",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      "opencode-ai@latest",
    ]);
    // Never the person's own global npm prefix.
    expect(install.args.join(" ")).not.toMatch(/AppData[\\/]Roaming[\\/]npm/u);
    expect(install.env.npm_config_registry).toBe("https://registry.npmmirror.com");
    expect(progress).toEqual(["installing:cn-mirror", "verifying:cn-mirror"]);
    // The installed command itself proved it runs.
    expect(path.dirname(npm.calls[1]!.command)).toBe(
      managedAgentBinDirectory(managedAgentInstallPrefix(mossHomeDir)),
    );
  });

  it("falls back to the other registry when the first one fails", async () => {
    const npm = fakeNpm({
      command: "kimi",
      failOn: ["https://registry.npmjs.org"],
      versionOutput: "kimi 1.4.0",
    });
    const outcome = await Effect.runPromise(
      runOneClickAgentInstall({
        provider: "kimi",
        mossHomeDir: makeMossHome(),
        channel: "official",
        env: baseEnv(),
        npmExecutable: "fake-npm",
        run: npm.run,
      }),
    );
    expect(outcome).toMatchObject({ ok: true, source: "cn-mirror", version: "1.4.0" });
    expect(npm.calls.map((call) => call.args.find((arg) => arg.startsWith("--registry=")))).toEqual(
      [
        "--registry=https://registry.npmjs.org",
        "--registry=https://registry.npmmirror.com",
        undefined,
      ],
    );
    expect(npm.calls[0]!.env.npm_config_registry).toBeUndefined();
  });

  it("reports a download failure when both registries fail", async () => {
    const npm = fakeNpm({
      command: "zcode-acp-server",
      failOn: ["https://registry.npmjs.org", "https://registry.npmmirror.com"],
    });
    const outcome = await Effect.runPromise(
      runOneClickAgentInstall({
        provider: "zcode",
        mossHomeDir: makeMossHome(),
        channel: "official",
        env: baseEnv(),
        npmExecutable: "fake-npm",
        run: npm.run,
      }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "download-failed" });
  });

  it("does not report success unless the installed command reports a version", async () => {
    const npm = fakeNpm({ command: "gemini", versionOutput: "" });
    const outcome = await Effect.runPromise(
      runOneClickAgentInstall({
        provider: "gemini",
        mossHomeDir: makeMossHome(),
        channel: "official",
        env: baseEnv(),
        npmExecutable: "fake-npm",
        run: npm.run,
      }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: "verify-failed" });
  });

  it("needs npm for npm agents and keeps Cursor external on unsupported platforms", async () => {
    const npm = fakeNpm({ command: "opencode" });
    await expect(
      Effect.runPromise(
        runOneClickAgentInstall({
          provider: "opencode",
          mossHomeDir: makeMossHome(),
          channel: "official",
          env: baseEnv(),
          npmExecutable: null,
          run: npm.run,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "npm-unavailable" });
    await expect(
      Effect.runPromise(
        runOneClickAgentInstall({
          provider: "cursor",
          platform: "linux",
          mossHomeDir: makeMossHome(),
          channel: "official",
          env: baseEnv(),
          npmExecutable: "fake-npm",
          run: npm.run,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "not-installable" });
    expect(npm.calls).toHaveLength(0);
  });

  it("installs the latest Pi CLI, mirror first on the mainland lane", async () => {
    const mossHomeDir = makeMossHome();
    const npm = fakeNpm({ command: "pi", versionOutput: "1.5.0" });
    const outcome = await Effect.runPromise(
      runOneClickAgentInstall({
        provider: "pi",
        mossHomeDir,
        channel: "cn-mirror",
        env: baseEnv(),
        npmExecutable: "fake-npm",
        run: npm.run,
      }),
    );
    expect(outcome).toMatchObject({ ok: true, version: "1.5.0", source: "cn-mirror" });
    expect(npm.calls[0]!.args).toContain("--registry=https://registry.npmmirror.com");
    expect(npm.calls[0]!.args.at(-1)).toBe("@earendil-works/pi-coding-agent@latest");
    expect(npm.calls[0]!.args).toContain(managedAgentInstallPrefix(mossHomeDir));
    expect(resolveProviderInstallAction("pi", { npmAvailable: true })).toEqual({
      install: "oneClick",
    });
  });

  it("picks the button's action per agent", () => {
    expect(resolveProviderInstallAction("opencode", { npmAvailable: true })).toEqual({
      install: "oneClick",
    });
    expect(resolveProviderInstallAction("opencode", { npmAvailable: false })).toEqual({
      install: "externalPage",
      installUrl: "https://opencode.ai/docs/",
    });
    for (const provider of ["cursor", "antigravity", "grok", "devin", "hermes", "omp"] as const) {
      expect(
        resolveProviderInstallAction(provider, { npmAvailable: true, platform: "linux" }),
      ).toMatchObject({
        install: "externalPage",
        installUrl: expect.stringMatching(/^https:\/\//u),
      });
    }
  });

  it.each(["x64", "arm64"])("offers Cursor native Windows %s without npm", (architecture) => {
    expect(
      resolveProviderInstallAction("cursor", {
        platform: "win32",
        architecture,
        npmAvailable: false,
      }),
    ).toEqual({ install: "oneClick" });
  });

  it.each(["darwin", "linux", "freebsd"] as const)(
    "keeps Cursor's official page on %s",
    (platform) => {
      expect(
        resolveProviderInstallAction("cursor", {
          platform,
          architecture: "arm64",
          npmAvailable: false,
        }),
      ).toEqual({
        install: "externalPage",
        installUrl: "https://docs.cursor.com/en/cli/installation",
      });
    },
  );

  it("does not advertise native installation for an unsupported Windows process architecture", () => {
    expect(
      resolveProviderInstallAction("cursor", {
        platform: "win32",
        architecture: "ia32",
        npmAvailable: false,
      })?.install,
    ).toBe("externalPage");
  });

  it("orders registries by region", () => {
    expect(agentInstallRegistries("cn-mirror").map((entry) => entry.source)).toEqual([
      "cn-mirror",
      "official",
    ]);
    expect(agentInstallRegistries("official").map((entry) => entry.source)).toEqual([
      "official",
      "cn-mirror",
    ]);
  });

  it("appends the managed folder after the person's own PATH, once", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Users\\me\\bin" };
    const binDirectory = appendManagedAgentBinDirectoryToPath("C:\\moss", env, "win32");
    appendManagedAgentBinDirectoryToPath("C:\\moss", env, "win32");
    expect(binDirectory).toBe(path.join("C:\\moss", "agents"));
    expect(env.PATH).toBe(`C:\\Users\\me\\bin;${binDirectory}`);
  });
});
