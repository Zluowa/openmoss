// FILE: bundledCodex.live.test.ts
// Purpose: Proves the pinned public Codex runtime works without a global Codex installation.
// Layer: Desktop packaged-runtime integration test

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MOSS_BUNDLED_CODEX_VERSION, resolveCodexRuntimeTarget } from "@synara/shared/codexRuntime";

const temporaryDirectories = new Set<string>();
const children = new Set<ChildProcess>();
const resolveFromTest = createRequire(import.meta.url).resolve;

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill();
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const directory of temporaryDirectories) {
    FS.rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

function makeTemporaryDirectory(prefix: string): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function readPackageRoot(packageName: string): string {
  const packageJsonPath = resolveFromTest(`${packageName}/package.json`);
  return Path.dirname(packageJsonPath);
}

function resolveInstalledCodexRuntime() {
  const target = resolveCodexRuntimeTarget({ platform: process.platform, arch: process.arch });
  if (!target) {
    throw new Error(`The test host ${process.platform}/${process.arch} is not a supported target.`);
  }

  const codexPackageRoot = readPackageRoot("@openai/codex");
  const packageLeaf = target.packageName.slice("@openai/".length);
  const candidateRoots = [
    Path.join(Path.dirname(codexPackageRoot), packageLeaf),
    Path.join(codexPackageRoot, "node_modules", "@openai", packageLeaf),
  ];
  const runtimeRoot = candidateRoots.find((candidate) =>
    FS.existsSync(Path.join(candidate, "vendor", target.targetTriple, "codex-package.json")),
  );
  if (!runtimeRoot) {
    throw new Error(
      `The pinned optional runtime ${target.packageName}@${MOSS_BUNDLED_CODEX_VERSION} was not installed.`,
    );
  }

  const vendorRoot = Path.join(runtimeRoot, "vendor", target.targetTriple);
  return {
    binaryPath: Path.join(vendorRoot, "bin", target.executableName),
    manifestPath: Path.join(vendorRoot, "codex-package.json"),
    target,
  };
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const home = Path.join(root, "home");
  const codexHome = Path.join(home, ".codex");
  FS.mkdirSync(codexHome, { recursive: true });
  const systemPath =
    process.platform === "win32"
      ? [
          Path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
          process.env.SystemRoot ?? "C:\\Windows",
        ].join(Path.delimiter)
      : "/usr/bin:/bin:/usr/sbin:/sbin";
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: home,
    // Keep only OS utilities needed by Codex itself. User/global package-manager
    // bins are deliberately absent, so this cannot discover a global `codex`.
    PATH: systemPath,
    USERPROFILE: home,
  };
}

async function runToExit(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out launching the pinned Codex runtime. ${stderr}`));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  children.delete(child);
  return { code, stderr, stdout };
}

interface AppServerProbeResult {
  readonly initialize: Record<string, unknown>;
  readonly pluginList: Record<string, unknown>;
}

async function probeAppServer(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<AppServerProbeResult> {
  const child = spawn(input.binaryPath, ["app-server"], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const response = await new Promise<AppServerProbeResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out initializing the bundled Codex app-server. ${stderr}`));
      }, 30_000);
      const finish = (callback: () => void) => {
        clearTimeout(timeout);
        callback();
      };
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) => {
        finish(() =>
          reject(
            new Error(
              `Bundled Codex app-server exited before initialize (code=${String(code)}, signal=${String(signal)}). ${stderr}`,
            ),
          ),
        );
      });
      let initializeResult: Record<string, unknown> | null = null;
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let message: {
            readonly id?: unknown;
            readonly error?: unknown;
            readonly result?: unknown;
          };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            continue;
          }
          if (message.id === 1) {
            if (message.error !== undefined) {
              finish(() =>
                reject(
                  new Error(`Codex initialize returned an error: ${JSON.stringify(message.error)}`),
                ),
              );
              return;
            }
            initializeResult = message.result as Record<string, unknown>;
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
            child.stdin.write(
              `${JSON.stringify({
                id: 2,
                method: "plugin/list",
                params: {
                  cwds: [input.cwd],
                  // Local-only keeps this fresh-profile artifact smoke
                  // deterministic and proves plugin RPC without network/auth.
                  marketplaceKinds: ["local"],
                },
              })}\n`,
            );
            continue;
          }
          if (message.id !== 2) continue;
          finish(() => {
            if (message.error !== undefined) {
              reject(
                new Error(`Codex plugin/list returned an error: ${JSON.stringify(message.error)}`),
              );
              return;
            }
            if (!initializeResult) {
              reject(new Error("Codex plugin/list returned before initialize completed."));
              return;
            }
            resolve({
              initialize: initializeResult,
              pluginList: message.result as Record<string, unknown>,
            });
          });
          return;
        }
      });

      child.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "moss-runtime-test", title: "Moss Runtime Test", version: "1" },
            capabilities: { experimentalApi: true },
          },
        })}\n`,
      );
    });
    return response;
  } finally {
    await stopChild(child);
    children.delete(child);
  }
}

describe("pinned public Codex runtime", () => {
  it("is pinned in the desktop production dependencies", () => {
    const packageJson = JSON.parse(
      FS.readFileSync(Path.join(__dirname, "..", "package.json"), "utf8"),
    ) as { readonly dependencies?: Record<string, string> };
    expect(packageJson.dependencies?.["@openai/codex"]).toBe(MOSS_BUNDLED_CODEX_VERSION);

    const installedPackageJson = JSON.parse(
      FS.readFileSync(Path.join(readPackageRoot("@openai/codex"), "package.json"), "utf8"),
    ) as { readonly version?: string };
    expect(installedPackageJson.version).toBe(MOSS_BUNDLED_CODEX_VERSION);
  });

  it("starts app-server without Codex on PATH and with a fresh profile", async () => {
    const root = makeTemporaryDirectory("moss-bundled-codex-live-");
    const runtime = resolveInstalledCodexRuntime();
    const env = isolatedEnvironment(root);

    const manifest = JSON.parse(FS.readFileSync(runtime.manifestPath, "utf8")) as {
      readonly target?: string;
      readonly version?: string;
    };
    expect(manifest).toMatchObject({
      target: runtime.target.targetTriple,
      version: MOSS_BUNDLED_CODEX_VERSION,
    });

    const version = await runToExit(runtime.binaryPath, ["--version"], { cwd: root, env });
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout).toContain(MOSS_BUNDLED_CODEX_VERSION);

    const result = await probeAppServer({ binaryPath: runtime.binaryPath, cwd: root, env });
    expect(result.initialize).toMatchObject({
      userAgent: expect.stringContaining(`/${MOSS_BUNDLED_CODEX_VERSION}`),
    });
    expect(FS.realpathSync(String(result.initialize.codexHome))).toBe(
      FS.realpathSync(env.CODEX_HOME!),
    );
    expect(result.pluginList).toMatchObject({
      featuredPluginIds: expect.any(Array),
      marketplaceLoadErrors: expect.any(Array),
      marketplaces: expect.any(Array),
    });
    expect(env.PATH).not.toContain(".local");
    expect(env.PATH).not.toContain("node_modules");
    expect(FS.realpathSync(env.CODEX_HOME!)).toContain(FS.realpathSync(root));
  }, 75_000);
});
