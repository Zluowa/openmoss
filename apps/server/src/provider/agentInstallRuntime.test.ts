import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as NodePath from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureMossNpm,
  extractTarGz,
  findMossNpmCli,
  matchesIntegrity,
  refreshNodeShim,
  resolveMossNodeRuntime,
  writeNodeShim,
} from "./agentInstallRuntime.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = FS.mkdtempSync(NodePath.join(OS.tmpdir(), "moss-agent-runtime-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

function tarHeader(name: string, size: number, type: string, prefix = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tarFile(name: string, content: string, options: { prefix?: string } = {}): Buffer {
  const data = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length, "0", options.prefix), padded]);
}

function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  const record = `${String(body.length + String(body.length).length)}${body}`;
  const data = Buffer.from(record, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader("PaxHeader", data.length, "x"), padded]);
}

function tgz(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

describe("extractTarGz", () => {
  it("unpacks regular files, ustar prefixes and pax paths, and nothing outside", async () => {
    const destination = tempDir();
    const longPath = `package/node_modules/${"deep/".repeat(30)}index.js`;
    const archive = tgz(
      tarFile("package/bin/npm-cli.js", "console.log('npm')"),
      tarFile("index.js", "prefixed", { prefix: "package/lib" }),
      paxPath(longPath),
      tarFile("ignored-short-name", "long"),
      tarFile("../escape.txt", "nope"),
    );
    await extractTarGz(archive, destination);
    expect(FS.readFileSync(NodePath.join(destination, "package/bin/npm-cli.js"), "utf8")).toBe(
      "console.log('npm')",
    );
    expect(FS.readFileSync(NodePath.join(destination, "package/lib/index.js"), "utf8")).toBe(
      "prefixed",
    );
    expect(FS.readFileSync(NodePath.join(destination, longPath), "utf8")).toBe("long");
    expect(FS.existsSync(NodePath.join(destination, "..", "escape.txt"))).toBe(false);
  });
});

describe("ensureMossNpm", () => {
  it("fetches npm once from the first registry that answers and checks its sha512", async () => {
    const mossHome = tempDir();
    const archive = tgz(tarFile("package/bin/npm-cli.js", "// npm"));
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const requested: string[] = [];
    const fetchBytes = async (url: string) => {
      requested.push(url);
      if (url.startsWith("https://mirror.example")) throw new Error("offline");
      if (url.endsWith("/npm/latest")) {
        return Buffer.from(
          JSON.stringify({
            version: "11.6.2",
            dist: { tarball: "https://official.example/npm/-/npm-11.6.2.tgz", integrity },
          }),
        );
      }
      return archive;
    };
    const cli = await ensureMossNpm({
      mossHomeDir: mossHome,
      registries: ["https://mirror.example", "https://official.example"],
      fetchBytes,
    });
    expect(cli).toBe(
      NodePath.join(mossHome, "runtime", "npm", "11.6.2", "package", "bin", "npm-cli.js"),
    );
    expect(FS.readFileSync(cli, "utf8")).toBe("// npm");
    expect(await findMossNpmCli(mossHome)).toBe(cli);

    // The second install reuses it without asking any registry.
    requested.length = 0;
    await ensureMossNpm({
      mossHomeDir: mossHome,
      registries: ["https://official.example"],
      fetchBytes,
    });
    expect(requested).toEqual([]);
  });

  it("refuses a tarball that does not match the registry's checksum", async () => {
    const mossHome = tempDir();
    const archive = tgz(tarFile("package/bin/npm-cli.js", "// npm"));
    await expect(
      ensureMossNpm({
        mossHomeDir: mossHome,
        registries: ["https://official.example"],
        fetchBytes: async (url) =>
          url.endsWith("/npm/latest")
            ? Buffer.from(
                JSON.stringify({
                  version: "11.6.2",
                  dist: { tarball: "https://official.example/npm.tgz", integrity: "sha512-AAAA" },
                }),
              )
            : archive,
      }),
    ).rejects.toThrow(/integrity/u);
    expect(await findMossNpmCli(mossHome)).toBeNull();
    expect(matchesIntegrity(archive, "sha1-abc")).toBe(false);
  });
});

describe("Moss's own Node runtime", () => {
  it("runs Electron in Node mode, plain Node as is, and not Bun", () => {
    expect(
      resolveMossNodeRuntime({
        execPath: "C:\\Moss\\Moss.exe",
        versions: { node: "22.0.0", electron: "38.0.0" },
      }),
    ).toEqual({ command: "C:\\Moss\\Moss.exe", env: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(
      resolveMossNodeRuntime({ execPath: "/usr/bin/node", versions: { node: "24.0.0" } }),
    ).toEqual({
      command: "/usr/bin/node",
      env: {},
    });
    expect(
      resolveMossNodeRuntime({ execPath: "bun", versions: { node: "24.0.0", bun: "1.4.4" } }),
    ).toBeNull();
  });

  it("writes a node shim the agents' launchers find, and keeps it pointing at this Moss", async () => {
    const bin = tempDir();
    const runtime = {
      command: "C:\\Program Files\\Moss\\Moss.exe",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    expect(await refreshNodeShim(bin, runtime, "win32")).toBe(false);
    const shim = await writeNodeShim({ binDirectory: bin, runtime, platform: "win32" });
    expect(NodePath.basename(shim)).toBe("node.cmd");
    expect(FS.readFileSync(shim, "utf8")).toBe(
      '@ECHO off\r\nSETLOCAL\r\nSET "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\Program Files\\Moss\\Moss.exe" %*\r\n',
    );
    expect(await refreshNodeShim(bin, { ...runtime, command: "D:\\Moss\\Moss.exe" }, "win32")).toBe(
      true,
    );
    expect(FS.readFileSync(shim, "utf8")).toContain('"D:\\Moss\\Moss.exe" %*');
  });
});
