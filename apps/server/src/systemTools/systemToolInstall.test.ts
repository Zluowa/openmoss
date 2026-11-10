import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "../processRunner.ts";
import {
  appendManagedToolBinDirectoryToPath,
  createSystemToolInstallHost,
  findReleaseChecksum,
  managedToolBinDirectory,
  parseLatestReleaseVersion,
  runSystemToolInstall,
  SYSTEM_TOOL_INSTALLS,
  type SystemToolCommandResult,
  type SystemToolInstallHost,
  type SystemToolInstallPhase,
} from "./systemToolInstall";

const gh = SYSTEM_TOOL_INSTALLS["github-cli"];
const ZIP = new TextEncoder().encode("official zip bytes");
const PKG = new TextEncoder().encode("official pkg bytes");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exit = (exitCode: number, stdout = "", stderr = ""): SystemToolCommandResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});
const VERSION_TEXT =
  "gh version 2.83.1 (2025-11-13)\nhttps://github.com/cli/cli/releases/tag/v2.83.1\n";

const TOOLS = "C:\\Users\\p\\.moss\\tools";
const GH_MOSS = "C:\\Users\\p\\.moss\\tools\\github-cli\\bin\\gh.exe";
const GH_PROGRAM_FILES = "C:\\Program Files\\GitHub CLI\\gh.exe";

/**
 * A fake computer. Nothing real runs: commands, downloads and files are recorded, a command
 * "installs" by adding to the fake disk, and unpacking the zip adds `bin\gh.exe`.
 */
function computer(options: {
  platform: NodeJS.Platform;
  architecture?: string;
  toolsDirectory?: string | null;
  files?: string[];
  onPath?: Record<string, string>;
  installs?: Record<string, { exitCode: number; installsTo?: string }>;
  release?: { status: number; tag?: string };
  checksums?: string;
  archive?: Uint8Array;
  unpack?: "ok" | "fails" | "empty";
}) {
  const files = new Set(options.files ?? []);
  const onPath = { ...options.onPath };
  const commands: { command: string; args: ReadonlyArray<string> }[] = [];
  const downloads: string[] = [];
  const pathAdditions: string[] = [];
  const saved: string[] = [];
  const removed: string[] = [];
  const unpacked: { name: string; destination: string }[] = [];
  const env: NodeJS.ProcessEnv =
    options.platform === "win32"
      ? {
          LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
          SystemRoot: "C:\\Windows",
        }
      : {};
  const host: SystemToolInstallHost = {
    platform: options.platform,
    architecture: options.architecture ?? "x64",
    env,
    toolsDirectory:
      options.toolsDirectory === undefined
        ? options.platform === "win32"
          ? TOOLS
          : "/Users/p/.moss/tools"
        : options.toolsDirectory,
    run: async ({ command, args }) => {
      commands.push({ command, args });
      if (args[0] === "--version") {
        return files.has(command) || Object.values(onPath).includes(command)
          ? exit(0, VERSION_TEXT)
          : exit(1);
      }
      const key = Object.keys(options.installs ?? {}).find((name) => command.endsWith(name));
      const install = key ? options.installs![key]! : { exitCode: 1 };
      if (install.installsTo) files.add(install.installsTo);
      return exit(install.exitCode, "", install.exitCode === 0 ? "" : "Installer failed");
    },
    download: async (url, { onBytes }) => {
      downloads.push(url);
      if (url.endsWith("/releases/latest")) {
        const release = options.release ?? { status: 200, tag: "v2.83.1" };
        return {
          status: release.status,
          body: new TextEncoder().encode(JSON.stringify({ tag_name: release.tag })),
        };
      }
      if (url.endsWith("_checksums.txt"))
        return {
          status: 200,
          body: new TextEncoder().encode(
            options.checksums ??
              [
                `${sha(ZIP)}  gh_2.83.1_windows_amd64.zip`,
                `${sha(PKG)}  gh_2.83.1_macOS_universal.pkg`,
                `${"0".repeat(64)}  gh_2.83.1_windows_amd64.msi`,
              ].join("\n"),
          ),
        };
      if (url.endsWith(".zip")) {
        const body = options.archive ?? ZIP;
        onBytes?.(Math.floor(body.byteLength / 2), body.byteLength);
        onBytes?.(body.byteLength, body.byteLength);
        return { status: 200, body };
      }
      if (url.endsWith(".pkg")) return { status: 200, body: PKG };
      return { status: 404, body: new Uint8Array() };
    },
    which: (command) => onPath[command] ?? null,
    fileExists: async (path) => files.has(path),
    saveInstaller: async (name) => {
      const path = `TEMP/${name}`;
      saved.push(path);
      return { path, remove: async () => void removed.push(path) };
    },
    unpackArchive: async ({ name, destination }) => {
      unpacked.push({ name, destination });
      if (options.unpack === "fails") throw new Error("tar.exe exit 1: Damaged archive");
      if (options.unpack !== "empty") files.add(Path.win32.join(destination, "bin", "gh.exe"));
    },
    addToPath: (directory) => void pathAdditions.push(directory),
  };
  return { host, commands, downloads, pathAdditions, saved, removed, unpacked };
}

async function install(machine: ReturnType<typeof computer>) {
  const phases: SystemToolInstallPhase[] = [];
  const percents: number[] = [];
  const outcome = await runSystemToolInstall({
    tool: gh,
    host: machine.host,
    onProgress: (phase, percent) => {
      if (percent === undefined) phases.push(phase);
      else percents.push(percent);
    },
  });
  return { outcome, phases, percents };
}

describe("GitHub CLI one-click install on Windows", () => {
  it("unpacks the official zip into Moss's own folder, with no installer, winget or admin rights", async () => {
    const machine = computer({
      platform: "win32",
      // winget being there changes nothing: its GitHub CLI package is the per-machine MSI.
      onPath: { winget: "C:\\Users\\p\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe" },
    });
    const { outcome, phases, percents } = await install(machine);
    expect(outcome).toEqual({
      ok: true,
      version: "2.83.1",
      binDirectory: "C:\\Users\\p\\.moss\\tools\\github-cli\\bin",
      method: "zip",
    });
    expect(machine.downloads).toEqual([
      "https://api.github.com/repos/cli/cli/releases/latest",
      "https://github.com/cli/cli/releases/download/v2.83.1/gh_2.83.1_checksums.txt",
      "https://github.com/cli/cli/releases/download/v2.83.1/gh_2.83.1_windows_amd64.zip",
    ]);
    expect(machine.unpacked).toEqual([
      {
        name: "gh_2.83.1_windows_amd64.zip",
        destination: "C:\\Users\\p\\.moss\\tools\\github-cli",
      },
    ]);
    // Only gh itself runs: no msiexec, no winget, nothing that could ask for elevation.
    expect(machine.commands).toEqual([{ command: GH_MOSS, args: ["--version"] }]);
    expect(machine.saved).toEqual([]);
    expect(machine.pathAdditions).toEqual(["C:\\Users\\p\\.moss\\tools\\github-cli\\bin"]);
    expect(phases).toEqual(["downloading", "installing", "verifying"]);
    expect(percents).toEqual([50, 99]);
  });

  it("picks the ARM build on ARM", async () => {
    const machine = computer({
      platform: "win32",
      architecture: "arm64",
      checksums: `${sha(ZIP)}  gh_2.83.1_windows_arm64.zip`,
    });
    expect((await install(machine)).outcome).toMatchObject({ ok: true, method: "zip" });
    expect(machine.downloads.at(-1)).toMatch(/gh_2\.83\.1_windows_arm64\.zip$/);
  });

  it("never unpacks a zip that does not match its published checksum", async () => {
    const machine = computer({ platform: "win32", archive: new TextEncoder().encode("tampered") });
    expect((await install(machine)).outcome).toMatchObject({
      ok: false,
      reason: "download-failed",
    });
    expect(machine.unpacked).toEqual([]);
  });

  it("never unpacks when the checksum list does not name the zip", async () => {
    const machine = computer({ platform: "win32", checksums: `${sha(ZIP)}  other.zip` });
    expect((await install(machine)).outcome).toMatchObject({ reason: "download-failed" });
    expect(machine.unpacked).toEqual([]);
  });

  it("reports a download failure when GitHub cannot be reached", async () => {
    const machine = computer({ platform: "win32", release: { status: 503 } });
    expect((await install(machine)).outcome).toMatchObject({
      ok: false,
      reason: "download-failed",
    });
  });

  it("reports an unpack failure, and a zip that leaves no working gh behind", async () => {
    const broken = computer({ platform: "win32", unpack: "fails" });
    expect((await install(broken)).outcome).toMatchObject({ ok: false, reason: "install-failed" });
    const empty = computer({ platform: "win32", unpack: "empty" });
    expect((await install(empty)).outcome).toMatchObject({ ok: false, reason: "verify-failed" });
  });

  it("says it cannot install when the server has no Moss home to unpack into", async () => {
    const machine = computer({ platform: "win32", toolsDirectory: null });
    expect((await install(machine)).outcome).toMatchObject({ ok: false, reason: "unsupported" });
    expect(machine.downloads).toEqual([]);
  });

  it("counts gh installed elsewhere, or by Moss earlier, as done without downloading", async () => {
    for (const existing of [GH_PROGRAM_FILES, GH_MOSS]) {
      const machine = computer({ platform: "win32", files: [existing] });
      const { outcome } = await install(machine);
      expect(outcome).toMatchObject({ ok: true, method: "present" });
      expect(machine.commands).toEqual([{ command: existing, args: ["--version"] }]);
      expect(machine.downloads).toEqual([]);
    }
  });
});

describe("GitHub CLI one-click install on macOS", () => {
  it("uses Homebrew when it is there", async () => {
    const machine = computer({
      platform: "darwin",
      files: ["/opt/homebrew/bin/brew"],
      installs: { "/brew": { exitCode: 0, installsTo: "/opt/homebrew/bin/gh" } },
    });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({
      ok: true,
      method: "homebrew",
      binDirectory: "/opt/homebrew/bin",
    });
    expect(machine.commands[0]).toEqual({
      command: "/opt/homebrew/bin/brew",
      args: ["install", "gh"],
    });
  });

  it("opens the official package in the system Installer when there is no Homebrew", async () => {
    const machine = computer({
      platform: "darwin",
      installs: { "/usr/bin/open": { exitCode: 0, installsTo: "/usr/local/bin/gh" } },
    });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({ ok: true, method: "pkg", binDirectory: "/usr/local/bin" });
    expect(machine.commands.find(({ command }) => command === "/usr/bin/open")?.args).toEqual([
      "-W",
      "TEMP/gh_2.83.1_macOS_universal.pkg",
    ]);
    expect(machine.removed).toEqual(machine.saved);
    expect(machine.unpacked).toEqual([]);
  });
});

describe("GitHub CLI one-click install elsewhere", () => {
  it("says Linux is not supported instead of guessing a package manager", async () => {
    const machine = computer({ platform: "linux" });
    expect((await install(machine)).outcome).toMatchObject({ ok: false, reason: "unsupported" });
    expect(machine.downloads).toEqual([]);
  });
});

describe("Moss's GitHub CLI folder on PATH", () => {
  it("is appended after the person's own entries, once", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32;C:\\mine" };
    appendManagedToolBinDirectoryToPath(gh, TOOLS, env, "win32");
    appendManagedToolBinDirectoryToPath(gh, TOOLS, env, "win32");
    expect(env.Path).toBe(
      "C:\\Windows\\System32;C:\\mine;C:\\Users\\p\\.moss\\tools\\github-cli\\bin",
    );
    expect(managedToolBinDirectory(gh, "/Users/p/.moss/tools", "darwin")).toBe(
      "/Users/p/.moss/tools/github-cli/bin",
    );
  });
});

describe("release metadata", () => {
  it("reads the latest version and an asset's checksum", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(parseLatestReleaseVersion(encode({ tag_name: "v2.83.1" }))).toBe("2.83.1");
    expect(parseLatestReleaseVersion(encode({ tag_name: "nightly" }))).toBeNull();
    expect(parseLatestReleaseVersion(new TextEncoder().encode("<html>"))).toBeNull();
    const list = `${"a".repeat(64)}  gh_1_windows_amd64.zip\n${"B".repeat(64)} *gh_1.pkg\n`;
    expect(findReleaseChecksum(list, "gh_1_windows_amd64.zip")).toBe("a".repeat(64));
    expect(findReleaseChecksum(list, "gh_1.pkg")).toBe("b".repeat(64));
    expect(findReleaseChecksum(list, "gh_1_windows_amd64.zip.sig")).toBeNull();
  });
});

// The real host against a local stub of GitHub's release API and download host.
describe("the real install host against a local release server", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function scratch(): Promise<string> {
    const folder = await FS.mkdtemp(Path.join(OS.tmpdir(), "moss-gh-install-test-"));
    cleanups.push(() => FS.rm(folder, { recursive: true, force: true }));
    return folder;
  }

  /** Serves `routes` on 127.0.0.1 in 64 KiB chunks with a Content-Length, like GitHub does. */
  async function releaseServer(routes: Record<string, Uint8Array>) {
    const requests: string[] = [];
    const server = Http.createServer((request, response) => {
      requests.push(request.url ?? "");
      const body = routes[request.url ?? ""];
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": String(body.byteLength) });
      for (let offset = 0; offset < body.byteLength; offset += 64 * 1024)
        response.write(body.subarray(offset, offset + 64 * 1024));
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, requests };
  }

  it("downloads through the outbound policy and reports bytes as they arrive", async () => {
    const big = new Uint8Array(300 * 1024).fill(7);
    const { origin } = await releaseServer({ "/big.zip": big });
    const host = createSystemToolInstallHost({}, { testOrigins: [origin] });
    const seen: Array<[number, number | null]> = [];
    const response = await host.download(`${origin}/big.zip`, {
      maxBytes: 1024 * 1024,
      onBytes: (received, total) => seen.push([received, total]),
    });
    expect(response.status).toBe(200);
    expect(sha(response.body)).toBe(sha(big));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toEqual([big.byteLength, big.byteLength]);
    // Without the test origin the same host refuses a server that is not GitHub.
    await expect(
      createSystemToolInstallHost({}).download(`${origin}/big.zip`, { maxBytes: 1024 * 1024 }),
    ).rejects.toThrow();
  });

  /** A zip shaped like the official one (`bin\gh.exe`), made with Windows' own tar.exe. */
  async function officialShapedZip(folder: string, marker: string): Promise<Uint8Array> {
    const source = Path.join(folder, `zip-source-${marker}`);
    await FS.mkdir(Path.join(source, "bin"), { recursive: true });
    await FS.writeFile(Path.join(source, "bin", "gh.exe"), `fake gh ${marker}`);
    await FS.writeFile(Path.join(source, "LICENSE"), "MIT");
    const zip = Path.join(folder, `gh-${marker}.zip`);
    const tar = Path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const made = await runProcess(tar, ["-a", "-cf", zip, "-C", source, "bin", "LICENSE"], {
      allowNonZeroExit: true,
    });
    expect(made.code).toBe(0);
    return new Uint8Array(await FS.readFile(zip));
  }

  /** The real host, except that "running gh" reads the fake gh.exe instead of executing it. */
  function realHost(origin: string, toolsDirectory: string, env: NodeJS.ProcessEnv) {
    const real = createSystemToolInstallHost(env, { toolsDirectory, testOrigins: [origin] });
    const ran: string[] = [];
    const host: SystemToolInstallHost = {
      ...real,
      platform: "win32",
      architecture: "x64",
      which: () => null,
      run: async ({ command }) => {
        ran.push(command);
        const text = await FS.readFile(command, "utf8").catch(() => "");
        return text.startsWith("fake gh") ? exit(0, VERSION_TEXT) : exit(1);
      },
    };
    return { host, ran };
  }

  async function serveRelease(zip: Uint8Array, checksumOf: Uint8Array = zip) {
    const asset = "gh_2.83.1_windows_amd64.zip";
    return releaseServer({
      "/api/repos/cli/cli/releases/latest": new TextEncoder().encode(
        JSON.stringify({ tag_name: "v2.83.1" }),
      ),
      "/dl/cli/cli/releases/download/v2.83.1/gh_2.83.1_checksums.txt": new TextEncoder().encode(
        `${sha(checksumOf)}  ${asset}\n${"0".repeat(64)}  gh_2.83.1_windows_amd64.msi\n`,
      ),
      [`/dl/cli/cli/releases/download/v2.83.1/${asset}`]: zip,
    });
  }

  it.runIf(process.platform === "win32")(
    "downloads, checks, unpacks with tar.exe into the Moss home and finds gh there",
    async () => {
      const folder = await scratch();
      const zip = await officialShapedZip(folder, "new");
      const { origin, requests } = await serveRelease(zip);
      const toolsDirectory = Path.join(folder, "moss-home", "tools");
      // No LOCALAPPDATA or ProgramFiles: a gh installed on this computer must not count.
      const env: NodeJS.ProcessEnv = {
        SystemRoot: process.env.SystemRoot,
        Path: "C:\\Windows\\System32",
      };
      const { host, ran } = realHost(origin, toolsDirectory, env);
      const percents: number[] = [];
      const outcome = await runSystemToolInstall({
        tool: gh,
        host,
        sources: { api: `${origin}/api`, downloads: `${origin}/dl` },
        onProgress: (phase, percent) => {
          if (phase === "downloading" && percent !== undefined) percents.push(percent);
        },
      });
      const bin = Path.join(toolsDirectory, "github-cli", "bin");
      expect(outcome).toEqual({ ok: true, version: "2.83.1", binDirectory: bin, method: "zip" });
      expect(requests).toHaveLength(3);
      expect(await FS.readFile(Path.join(bin, "gh.exe"), "utf8")).toBe("fake gh new");
      expect(ran).toEqual([Path.join(bin, "gh.exe")]);
      expect(env.Path?.split(";")).toContain(bin);
      expect(percents.length).toBeGreaterThan(0);
      // Nothing is left behind next to the install: no zip, no staging folder.
      expect(await FS.readdir(toolsDirectory)).toEqual(["github-cli"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps the earlier copy when a new zip fails its checksum or cannot be unpacked",
    async () => {
      const folder = await scratch();
      const toolsDirectory = Path.join(folder, "moss-home", "tools");
      const bin = Path.join(toolsDirectory, "github-cli", "bin");
      await FS.mkdir(bin, { recursive: true });
      await FS.writeFile(Path.join(bin, "gh.exe"), "old copy");

      const good = await officialShapedZip(folder, "tampered");
      const tampered = await serveRelease(good, new TextEncoder().encode("something else"));
      const first = realHost(tampered.origin, toolsDirectory, {
        SystemRoot: process.env.SystemRoot,
      });
      expect(
        await runSystemToolInstall({
          tool: gh,
          host: first.host,
          sources: { api: `${tampered.origin}/api`, downloads: `${tampered.origin}/dl` },
        }),
      ).toMatchObject({ ok: false, reason: "download-failed" });

      const notAZip = new TextEncoder().encode("this is not a zip archive");
      const broken = await serveRelease(notAZip);
      const second = realHost(broken.origin, toolsDirectory, {
        SystemRoot: process.env.SystemRoot,
      });
      expect(
        await runSystemToolInstall({
          tool: gh,
          host: second.host,
          sources: { api: `${broken.origin}/api`, downloads: `${broken.origin}/dl` },
        }),
      ).toMatchObject({ ok: false, reason: "install-failed" });

      expect(await FS.readFile(Path.join(bin, "gh.exe"), "utf8")).toBe("old copy");
      expect(await FS.readdir(toolsDirectory)).toEqual(["github-cli"]);
    },
  );
});
