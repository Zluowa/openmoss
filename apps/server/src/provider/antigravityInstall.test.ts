// FILE: antigravityInstall.test.ts
// Purpose: Proves direct one-click Antigravity CLI installation verifies SHA-512, extracts
//          POSIX archives safely, probes in isolation, and installs into Moss's managed folder.
// Layer: Provider maintenance tests (server).

import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_INSTALL_METADATA_FILE,
  antigravityManifestUrl,
  extractAntigravityBinaryFromTarGz,
  parseAntigravityManifest,
  resolveAntigravityPlatformKey,
  runAntigravityInstall,
  supportsAntigravityInstall,
} from "./antigravityInstall.ts";
import { managedAgentBinDirectory, managedAgentInstallPrefix } from "./managedAgentPaths.ts";
import type { AgentInstallCommandRunner } from "./providerInstall.ts";

const gzipAsync = promisify(gzip);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await FS.rm(root, { recursive: true, force: true });
  }
});

async function makeMossHome(): Promise<string> {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "moss-agy-install-"));
  roots.push(root);
  return root;
}

function sha512Hex(data: Buffer | Uint8Array): string {
  return createHash("sha512").update(data).digest("hex");
}

function buildTarHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function makeTarGz(
  entries: ReadonlyArray<{ name: string; content: Buffer }>,
): Promise<Buffer> {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(buildTarHeader(entry.name, entry.content.byteLength));
    blocks.push(entry.content);
    const pad = (512 - (entry.content.byteLength % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return await gzipAsync(Buffer.concat(blocks));
}

describe("antigravityInstall platform and manifest checks", () => {
  it("supports 64-bit Windows, macOS, and Linux and rejects unsupported targets", () => {
    expect(supportsAntigravityInstall("win32", "x64")).toBe(true);
    expect(supportsAntigravityInstall("win32", "arm64")).toBe(true);
    expect(supportsAntigravityInstall("darwin", "arm64")).toBe(true);
    expect(supportsAntigravityInstall("darwin", "x64")).toBe(true);
    expect(supportsAntigravityInstall("linux", "x64")).toBe(true);
    expect(supportsAntigravityInstall("linux", "arm64")).toBe(true);
    expect(supportsAntigravityInstall("win32", "ia32")).toBe(false);
    expect(supportsAntigravityInstall("freebsd", "x64")).toBe(false);
  });

  it("resolves WOW64 Windows ARM64, macOS, and Linux musl manifest keys", async () => {
    await expect(
      resolveAntigravityPlatformKey({
        platform: "win32",
        arch: "x64",
        env: { PROCESSOR_ARCHITEW6432: "ARM64" },
      }),
    ).resolves.toBe("windows_arm64");
    await expect(
      resolveAntigravityPlatformKey({
        platform: "win32",
        arch: "x64",
        env: { PROCESSOR_ARCHITECTURE: "AMD64" },
      }),
    ).resolves.toBe("windows_amd64");
    await expect(
      resolveAntigravityPlatformKey({ platform: "darwin", arch: "arm64", env: {} }),
    ).resolves.toBe("darwin_arm64");
    await expect(
      resolveAntigravityPlatformKey({
        platform: "linux",
        arch: "x64",
        env: {},
        pathExists: () => false,
      }),
    ).resolves.toBe("linux_amd64");
    await expect(
      resolveAntigravityPlatformKey({
        platform: "linux",
        arch: "x64",
        env: {},
        pathExists: (filePath) => filePath === "/lib/libc.musl-x86_64.so.1",
      }),
    ).resolves.toBe("linux_amd64_musl");
    expect(antigravityManifestUrl("windows_amd64")).toBe(
      "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json",
    );
  });

  it("rejects malformed or untrusted manifests", () => {
    const validHash = "a".repeat(128);
    expect(
      parseAntigravityManifest({
        version: "1.5.12",
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12/windows-x64/cli_windows_x64.exe",
        sha512: validHash.toUpperCase(),
      }),
    ).toEqual({
      version: "1.5.12",
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12/windows-x64/cli_windows_x64.exe",
      sha512: validHash,
    });

    expect(() =>
      parseAntigravityManifest({
        version: "1.5.12",
        url: "https://evil.example.com/antigravity-public/antigravity-cli/agy.exe",
        sha512: validHash,
      }),
    ).toThrow(/untrusted origin/u);

    expect(() =>
      parseAntigravityManifest({
        version: "1.5.12",
        url: "https://storage.googleapis.com/other-bucket/agy.exe",
        sha512: validHash,
      }),
    ).toThrow(/official bucket path/u);

    expect(() =>
      parseAntigravityManifest({
        version: "1.5.12",
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/agy.exe",
        sha512: "deadbeef",
      }),
    ).toThrow(/SHA-512/u);
  });
});

describe("runAntigravityInstall", () => {
  it("downloads, SHA-512 verifies, probes, and installs a Windows binary cleanly", async () => {
    const mossHomeDir = await makeMossHome();
    const binaryPayload = Buffer.from("MZ-fake-agy-binary-payload");
    const hash = sha512Hex(binaryPayload);
    const probeCalls: Array<{
      command: string;
      args: ReadonlyArray<string>;
      env: NodeJS.ProcessEnv;
    }> = [];
    const progress: string[] = [];

    const run: AgentInstallCommandRunner = ({ command, args, env }) =>
      Effect.sync(() => {
        probeCalls.push({ command, args, env });
        return Option.some({ exitCode: 0, stdout: "agy version 1.5.12\n", stderr: "" });
      });

    const outcome = await Effect.runPromise(
      runAntigravityInstall({
        mossHomeDir,
        env: { PROCESSOR_ARCHITECTURE: "AMD64" },
        platform: "win32",
        architecture: "x64",
        run,
        fetchManifest: async (platformKey) => {
          expect(platformKey).toBe("windows_amd64");
          return {
            version: "1.5.12",
            url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12/windows-x64/cli_windows_x64.exe",
            sha512: hash,
          };
        },
        downloadPayload: async (_url, destinationPath) => {
          await FS.writeFile(destinationPath, binaryPayload);
          return { sha512: hash, bytes: binaryPayload.byteLength };
        },
        onProgress: ({ phase, source }) => Effect.sync(() => progress.push(`${phase}:${source}`)),
      }),
    );

    const prefix = managedAgentInstallPrefix(mossHomeDir);
    const binDirectory = managedAgentBinDirectory(prefix, "win32");
    expect(outcome).toEqual({
      ok: true,
      version: "1.5.12",
      source: "official",
      binDirectory,
    });
    expect(progress).toEqual(["installing:official", "verifying:official"]);
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.args).toEqual(["--version"]);
    expect(probeCalls[0]!.env.NO_BROWSER).toBe("true");
    expect(probeCalls[0]!.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");

    const installedBytes = await FS.readFile(Path.join(binDirectory, "agy.exe"));
    expect(installedBytes.equals(binaryPayload)).toBe(true);

    const metadata = JSON.parse(
      await FS.readFile(
        Path.join(prefix, "antigravity", ANTIGRAVITY_INSTALL_METADATA_FILE),
        "utf8",
      ),
    ) as { provider: string; version: string; payloadSha512: string };
    expect(metadata).toMatchObject({
      provider: "antigravity",
      version: "1.5.12",
      payloadSha512: hash,
    });

    // Staging directory is removed once installation finishes.
    const entries = await FS.readdir(Path.join(prefix, "antigravity"));
    expect(entries).toEqual([ANTIGRAVITY_INSTALL_METADATA_FILE]);
  });

  it("streams and extracts the antigravity binary from a POSIX tar.gz archive", async () => {
    const mossHomeDir = await makeMossHome();
    const binaryPayload = Buffer.from("#!/bin/sh\necho 1.5.12\n");
    const archive = await makeTarGz([
      { name: "README.txt", content: Buffer.from("ignored") },
      { name: "./antigravity", content: binaryPayload },
    ]);
    const archiveHash = sha512Hex(archive);

    const outcome = await Effect.runPromise(
      runAntigravityInstall({
        mossHomeDir,
        env: {},
        platform: "darwin",
        architecture: "arm64",
        run: () => Effect.succeed(Option.some({ exitCode: 0, stdout: "agy 1.5.12\n", stderr: "" })),
        fetchManifest: async (platformKey) => {
          expect(platformKey).toBe("darwin_arm64");
          return {
            version: "1.5.12",
            url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12/darwin-arm/cli_mac_arm64.tar.gz",
            sha512: archiveHash,
          };
        },
        downloadPayload: async (_url, destinationPath) => {
          await FS.writeFile(destinationPath, archive);
          return { sha512: archiveHash, bytes: archive.byteLength };
        },
      }),
    );

    const binDirectory = managedAgentBinDirectory(managedAgentInstallPrefix(mossHomeDir), "darwin");
    expect(outcome).toEqual({
      ok: true,
      version: "1.5.12",
      source: "official",
      binDirectory,
    });
    const extracted = await FS.readFile(Path.join(binDirectory, "agy"));
    expect(extracted.equals(binaryPayload)).toBe(true);
  });

  it("refuses a checksum mismatch and leaves the managed bin folder clean", async () => {
    const mossHomeDir = await makeMossHome();
    const binaryPayload = Buffer.from("tampered-payload");
    const expectedHash = "b".repeat(128);
    let probed = false;

    const outcome = await Effect.runPromise(
      runAntigravityInstall({
        mossHomeDir,
        env: { PROCESSOR_ARCHITECTURE: "AMD64" },
        platform: "win32",
        architecture: "x64",
        run: () =>
          Effect.sync(() => {
            probed = true;
            return Option.some({ exitCode: 0, stdout: "1.5.12", stderr: "" });
          }),
        fetchManifest: async () => ({
          version: "1.5.12",
          url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12/windows-x64/cli_windows_x64.exe",
          sha512: expectedHash,
        }),
        downloadPayload: async (_url, destinationPath) => {
          await FS.writeFile(destinationPath, binaryPayload);
          return { sha512: sha512Hex(binaryPayload), bytes: binaryPayload.byteLength };
        },
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "download-failed" });
    expect(probed).toBe(false);
    const binDirectory = managedAgentBinDirectory(managedAgentInstallPrefix(mossHomeDir), "win32");
    await expect(FS.stat(Path.join(binDirectory, "agy.exe"))).rejects.toThrow();
  });

  it("rejects versions below the minimum supported CLI version", async () => {
    const mossHomeDir = await makeMossHome();
    const binaryPayload = Buffer.from("old-binary");
    const hash = sha512Hex(binaryPayload);

    const outcome = await Effect.runPromise(
      runAntigravityInstall({
        mossHomeDir,
        env: { PROCESSOR_ARCHITECTURE: "AMD64" },
        platform: "win32",
        architecture: "x64",
        run: () => Effect.succeed(Option.some({ exitCode: 0, stdout: "1.0.5", stderr: "" })),
        fetchManifest: async () => ({
          version: "1.0.5",
          url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.0.5/windows-x64/cli_windows_x64.exe",
          sha512: hash,
        }),
        downloadPayload: async (_url, destinationPath) => {
          await FS.writeFile(destinationPath, binaryPayload);
          return { sha512: hash, bytes: binaryPayload.byteLength };
        },
      }),
    );

    expect(outcome).toMatchObject({ ok: false, reason: "verify-failed" });
  });

  it("rejects tar.gz archives that lack the expected binary entry", async () => {
    const dir = await makeMossHome();
    const archivePath = Path.join(dir, "empty.tar.gz");
    const outPath = Path.join(dir, "agy");
    await FS.writeFile(
      archivePath,
      await makeTarGz([{ name: "../escape/antigravity", content: Buffer.from("bad") }]),
    );
    await expect(extractAntigravityBinaryFromTarGz(archivePath, outPath)).rejects.toThrow(
      /did not contain the CLI binary/u,
    );
  });
});
