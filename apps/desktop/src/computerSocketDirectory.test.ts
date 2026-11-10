import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerSocketPathFits,
  computerSocketTempRoot,
  createComputerSocketDirectory,
} from "./computerSocketDirectory";
import { CuaDriverHost } from "./cuaDriverHost";

describe("computer Unix socket directory", () => {
  it.each([
    ["darwin", 103],
    ["linux", 107],
  ] as const)(
    "uses the %s byte limit including the full generation socket filename",
    (platform, limit) => {
      const sample = "/界";
      const root =
        sample +
        "x".repeat(limit - Buffer.byteLength(sample + "/moss-cua-XXXXXX/driver-00000000.sock"));
      expect(computerSocketPathFits(root, "host", platform)).toBe(true);
      expect(computerSocketPathFits(root + "x", "host", platform)).toBe(false);
      expect(computerSocketPathFits(root + "界", "host", platform)).toBe(false);
    },
  );
});

describe.skipIf(process.platform === "win32")("native Unix computer endpoints", () => {
  const owned: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
  });
  async function fixture() {
    const root = await mkdtemp(join(await realpath("/tmp"), "mq-"));
    owned.push(root);
    return root;
  }

  it("opens the real CUA host and a driver generation socket with the installed smoke's long TMPDIR", async () => {
    const root = await fixture();
    const long = join(root, "界".repeat(24), "Moss Installed App Smoke abc123", "Temporary Files");
    await mkdir(long, { recursive: true });
    vi.stubEnv("TMPDIR", long);
    const host = new CuaDriverHost({
      binaryPath: "/unused",
      bundleId: "fixture",
      capability: "socket-test-authority",
      setup: async () => {},
    });
    let directory: string;
    try {
      const endpoint = await host.listen();
      directory = dirname(endpoint);
      expect(dirname(directory)).toBe(await realpath("/tmp"));
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(endpoint)).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(await readFile(join(directory, ".moss-cua-runtime.json"), "utf8")),
      ).toMatchObject({
        directory: basename(directory),
        ownerUid: process.getuid?.(),
        hostPid: process.pid,
      });
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(endpoint);
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
      });
      const longest = join(directory, "driver-12345678.sock");
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(longest, resolve);
        });
        expect((await lstat(longest)).isSocket()).toBe(true);
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await host.dispose();
    }
    expect(existsSync(directory!)).toBe(false);
    expect(existsSync(long)).toBe(true);
  });

  it("keeps short private roots, canonicalizes aliases, and preserves a replacement directory", async () => {
    const root = await fixture();
    vi.stubEnv("TMPDIR", root);
    expect(computerSocketTempRoot("frames")).toBe(root);
    const original = await createComputerSocketDirectory("frames");
    await rename(original.path, join(root, "moved-owned-directory"));
    await mkdir(original.path, { mode: 0o700 });
    await writeFile(join(original.path, "keep"), "different owner");
    await original.remove();
    expect(await readFile(join(original.path, "keep"), "utf8")).toBe("different owner");

    const long = join(root, "界".repeat(27));
    await mkdir(long);
    const alias = join(root, "a");
    await symlink(long, alias);
    vi.stubEnv("TMPDIR", alias);
    expect(computerSocketTempRoot("frames")).toBe(await realpath("/tmp"));
    const frames = await createComputerSocketDirectory("frames");
    try {
      const socket = join(frames.path, "tap-12345678.sock");
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socket, resolve);
        });
        expect((await lstat(socket)).isSocket()).toBe(true);
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await frames.remove();
    }
    expect(existsSync(frames.path)).toBe(false);
  });
});
