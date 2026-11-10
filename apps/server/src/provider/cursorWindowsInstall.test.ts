import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { tmpdir } from "node:os";
import { execProcessFile } from "@moss/shared/processRuntime";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_WINDOWS_RELEASE,
  cursorWindowsArchiveUrl,
  parseCursorWindowsArchitecture,
  runCursorWindowsInstall,
  supportsCursorWindowsInstall,
  writeCursorManagedLaunchers,
} from "./cursorWindowsInstall.ts";
import type { AgentInstallCommandRunner } from "./providerInstall.ts";
import { syntheticAgentZip } from "./agentInstallZip.testHelpers.ts";
import * as probe from "./nativeAgentInstallProbe.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
async function home() {
  const root = await FS.mkdtemp(Path.join(tmpdir(), "moss-cursor-"));
  roots.push(root);
  return root;
}
function archive() {
  return syntheticAgentZip([
    { name: "dist-package/node.exe", content: "synthetic; never executed" },
    { name: "dist-package/index.js", content: "synthetic; never executed", deflate: true },
    {
      name: "dist-package/package.json",
      content: JSON.stringify({ name: "@anysphere/agent-cli-runtime" }),
    },
    {
      name: "dist-package/cursor-agent.ps1",
      content: "throw 'downloaded launcher must never execute'",
    },
  ]);
}
function runner(options: { architecture?: string; version?: string; timeout?: boolean } = {}) {
  const calls: Array<Parameters<AgentInstallCommandRunner>[0]> = [];
  const run: AgentInstallCommandRunner = (input) =>
    Effect.sync(() => {
      calls.push(input);
      if (input.command.endsWith("powershell.exe")) {
        return Option.some({
          exitCode: 0,
          stdout: options.architecture ?? "x64-based PC",
          stderr: "",
        });
      }
      return options.timeout
        ? Option.none()
        : Option.some({
            exitCode: 0,
            stdout: options.version ?? CURSOR_WINDOWS_RELEASE,
            stderr: "",
          });
    });
  return { run, calls };
}
const env = {
  SystemRoot: "C:\\Windows",
  Path: "C:\\private-tools",
  OPENAI_API_KEY: "test-never-forward",
  OTHER_PROVIDER_KEY: "test-never-forward",
  NODE_OPTIONS: "test-never-forward",
  HOME: "C:\\personal-profile",
  CURSOR_API_KEY: "test-never-forward",
};

describe("Cursor native Windows install", () => {
  it("recognizes native ARM64 through CIM even for an x64 app", () => {
    expect(parseCursorWindowsArchitecture("ARM64-based PC\r\n")).toBe("arm64");
    expect(parseCursorWindowsArchitecture("x64-based PC\r\n")).toBe("x64");
    expect(parseCursorWindowsArchitecture("AMD64")).toBeNull();
    expect(supportsCursorWindowsInstall("win32", "x64")).toBe(true);
    expect(supportsCursorWindowsInstall("darwin", "arm64")).toBe(false);
    expect(supportsCursorWindowsInstall("win32", "ia32")).toBe(false);
  });

  it.each(["x64", "arm64"] as const)(
    "publishes the private %s package after an isolated exact-version probe",
    async (arch) => {
      const mossHomeDir = await home();
      const fake = runner({ architecture: arch === "arm64" ? "ARM64-based PC" : "x64-based PC" });
      const fetchArchive = vi.fn(async () => archive());
      const progress: string[] = [];
      const result = await Effect.runPromise(
        runCursorWindowsInstall({
          mossHomeDir,
          env,
          run: fake.run,
          fetchArchive,
          onProgress: ({ phase }) =>
            Effect.sync(() => {
              progress.push(phase);
            }),
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        version: CURSOR_WINDOWS_RELEASE,
        source: "official",
      });
      expect(fetchArchive).toHaveBeenCalledExactlyOnceWith(cursorWindowsArchiveUrl(arch));
      expect(progress).toEqual(["installing", "verifying"]);
      const verify = fake.calls[1]!;
      expect(verify.command).toContain(".partial-");
      expect(verify.command.endsWith("node.exe")).toBe(true);
      expect(verify.args).toEqual([
        Path.join(Path.dirname(verify.command), "index.js"),
        "--version",
      ]);
      expect(verify.env.HOME).toContain(".probe-profile");
      expect(verify.env.OPENAI_API_KEY).toBeUndefined();
      expect(verify.env.OTHER_PROVIDER_KEY).toBeUndefined();
      expect(verify.env.NODE_OPTIONS).toBeUndefined();
      expect(verify.env.CURSOR_API_KEY).toBe("moss-isolated-version-probe");
      expect(env.HOME).toBe("C:\\personal-profile");
      const root = Path.join(mossHomeDir, "agents", "cursor");
      expect((await FS.readFile(Path.join(root, "active-version"), "utf8")).trim()).toBe(
        `${CURSOR_WINDOWS_RELEASE}-${arch}`,
      );
      expect(await FS.readdir(Path.join(root, "versions"))).toEqual([
        `${CURSOR_WINDOWS_RELEASE}-${arch}`,
      ]);
      const receipt = JSON.parse(
        await FS.readFile(
          Path.join(
            root,
            "versions",
            `${CURSOR_WINDOWS_RELEASE}-${arch}`,
            "moss-install-source.json",
          ),
          "utf8",
        ),
      );
      expect(receipt).toMatchObject({
        version: CURSOR_WINDOWS_RELEASE,
        architecture: arch,
        url: cursorWindowsArchiveUrl(arch),
        publisherSignature: "not-provided",
      });
      expect(receipt.archiveSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(await FS.readFile(Path.join(root, "resolve-version.ps1"), "utf8")).not.toContain(
        "downloaded launcher",
      );
      expect(await FS.readdir(Path.join(mossHomeDir, "agents"))).toEqual([
        "cursor",
        "cursor-agent.cmd",
      ]);
    },
  );

  it.each(["wrong-version", "timeout", "download", "malformed"])(
    "preserves old version and active pointer when %s fails",
    async (failure) => {
      const mossHomeDir = await home();
      const root = Path.join(mossHomeDir, "agents", "cursor");
      await FS.mkdir(Path.join(root, "versions", "old"), { recursive: true });
      await FS.writeFile(Path.join(root, "active-version"), "old\n");
      const fake = runner({
        ...(failure === "wrong-version" ? { version: "2026.11.05-wrong" } : {}),
        timeout: failure === "timeout",
      });
      const result = await Effect.runPromise(
        runCursorWindowsInstall({
          mossHomeDir,
          env,
          run: fake.run,
          fetchArchive: async () => {
            if (failure === "download") throw new Error("offline");
            return failure === "malformed"
              ? syntheticAgentZip([{ name: "dist-package/../escape" }])
              : archive();
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(await FS.readFile(Path.join(root, "active-version"), "utf8")).toBe("old\n");
      expect(await FS.readdir(Path.join(root, "versions"))).toEqual(["old"]);
      expect(await FS.readdir(Path.join(mossHomeDir, "agents"))).toEqual(["cursor"]);
    },
  );

  it("refuses an unowned existing launcher before downloading", async () => {
    const mossHomeDir = await home();
    await FS.mkdir(Path.join(mossHomeDir, "agents"));
    const file = Path.join(mossHomeDir, "agents", "cursor-agent.cmd");
    await FS.writeFile(file, "personal launcher");
    const fetchArchive = vi.fn(async () => archive());
    const result = await Effect.runPromise(
      runCursorWindowsInstall({ mossHomeDir, env, run: runner().run, fetchArchive }),
    );
    expect(result.ok).toBe(false);
    expect(fetchArchive).not.toHaveBeenCalled();
    expect(await FS.readFile(file, "utf8")).toBe("personal launcher");
  });

  it("retains its staging and reports the existing coordinator gate when process cleanup is unproven", async () => {
    const mossHomeDir = await home();
    const blocked = vi.fn();
    vi.spyOn(probe, "makeNativeAgentInstallProbe").mockImplementation(
      (onUnproven) =>
        ({ command }) =>
          Effect.gen(function* () {
            if (command.endsWith("powershell.exe"))
              return Option.some({ exitCode: 0, stdout: "x64-based PC", stderr: "" });
            yield* onUnproven;
            return Option.none();
          }),
    );
    const result = await Effect.runPromise(
      runCursorWindowsInstall({
        mossHomeDir,
        env,
        fetchArchive: async () => archive(),
        onCleanupUnproven: Effect.sync(blocked),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "cleanup-unproven" });
    expect(blocked).toHaveBeenCalledOnce();
    const entries = await FS.readdir(Path.join(mossHomeDir, "agents", "cursor", "versions"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.partial-/u);
    await expect(
      FS.stat(Path.join(mossHomeDir, "agents", "cursor", "active-version")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks an existing immutable release without downloading or rewriting its launcher", async () => {
    const mossHomeDir = await home();
    const fetchArchive = vi.fn(async () => archive());
    const first = await Effect.runPromise(
      runCursorWindowsInstall({ mossHomeDir, env, run: runner().run, fetchArchive }),
    );
    expect(first.ok).toBe(true);
    const file = Path.join(mossHomeDir, "agents", "cursor-agent.cmd");
    const before = await FS.stat(file);
    const fake = runner();
    const second = await Effect.runPromise(
      runCursorWindowsInstall({ mossHomeDir, env, run: fake.run, fetchArchive }),
    );
    expect(second.ok).toBe(true);
    expect(fetchArchive).toHaveBeenCalledTimes(1);
    expect(fake.calls[1]!.command).not.toContain(".partial-");
    expect((await FS.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it.runIf(process.platform === "win32")(
    "passes Windows cmd arguments directly to a private fake CLI after pointer validation",
    async () => {
      const mossHomeDir = await home();
      const prefix = Path.join(mossHomeDir, "Moss 空格目录", "agents");
      const root = Path.join(prefix, "cursor");
      const version = `${CURSOR_WINDOWS_RELEASE}-x64`;
      const packageDir = Path.join(root, "versions", version);
      await FS.mkdir(packageDir, { recursive: true });
      // Current test runtime only; never a downloaded executable or real Cursor.
      await FS.copyFile(process.execPath, Path.join(packageDir, "node.exe"));
      await FS.writeFile(
        Path.join(packageDir, "index.js"),
        "console.log(JSON.stringify(process.argv.slice(2)));\n",
      );
      await FS.writeFile(Path.join(root, "active-version"), version);
      await writeCursorManagedLaunchers(prefix);
      const args = [
        "simple",
        "with spaces",
        "中文参数",
        'literal"quote',
        "",
        "ends with slash\\",
        'slash\\"quote',
      ];
      const smokeEnv: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (
          /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|ProgramFiles.*)$/iu.test(
            name,
          )
        )
          smokeEnv[name] = value;
      }
      const output = await new Promise<string>((resolve, reject) => {
        execProcessFile(
          Path.join(prefix, "cursor-agent.cmd"),
          args,
          {
            env: { ...smokeEnv, NODE_COMPILE_CACHE: Path.join(mossHomeDir, "compile-cache") },
            cwd: mossHomeDir,
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 16_384,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      expect(JSON.parse(output.trim())).toEqual(args);
    },
    20_000,
  );
});
