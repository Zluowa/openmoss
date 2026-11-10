// FILE: agentInstallRuntime.ts
// Purpose: Installs agent CLIs on a computer without Node.js. Moss itself runs on a Node
//          runtime (Electron in Node mode in the desktop app), so the 安装 button can fetch
//          npm from the registry once, run it on that runtime, and leave a `node` shim next to
//          the agents it installed so their launchers start.
// Layer: Provider maintenance (server).
//
// Only used when the person has no npm of their own. npm comes from the same registry the
// agent does (the mirror first on the mainland lane) and is checked against the registry's
// sha512 before it is unpacked into `<Moss home>/runtime/npm/<version>`.

import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as NodePath from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { outboundHttp, resolveOutboundProxyUrl } from "@moss/shared/outboundHttp";

/** A Node runtime Moss can run npm on, and the environment that puts it in Node mode. */
export interface MossNodeRuntime {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The runtime this server runs on, when it can run npm: Electron in Node mode (packaged
 * Moss) or plain Node. Bun is not a drop-in Node for npm, so dev servers under Bun answer
 * null and fall back to the person's own npm.
 */
export function resolveMossNodeRuntime(
  runtime: {
    readonly execPath: string;
    readonly versions: Readonly<Record<string, string | undefined>>;
  } = process,
): MossNodeRuntime | null {
  if (runtime.versions.electron) {
    return { command: runtime.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  if (runtime.versions.bun) return null;
  return runtime.versions.node ? { command: runtime.execPath, env: {} } : null;
}

export function mossNpmRoot(mossHomeDir: string): string {
  return NodePath.join(mossHomeDir, "runtime", "npm");
}

/** The npm Moss fetched earlier, if any (newest folder first). */
export async function findMossNpmCli(mossHomeDir: string): Promise<string | null> {
  const root = mossNpmRoot(mossHomeDir);
  let versions: string[];
  try {
    versions = await FS.readdir(root);
  } catch {
    return null;
  }
  for (const version of versions.toSorted().toReversed()) {
    const cli = NodePath.join(root, version, "package", "bin", "npm-cli.js");
    if (await fileExists(cli)) return cli;
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await FS.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

const gunzipAsync = promisify(gunzip);

/** `sha512-<base64>` as npm publishes it. */
export function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/u.exec(integrity.trim());
  if (!match?.[1]) return false;
  return createHash("sha512").update(bytes).digest("base64") === match[1];
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end >= 0 ? slice.subarray(0, end) : slice).toString("utf8");
}

function parsePaxPath(data: Uint8Array): string | undefined {
  // Records are "<length> <key>=<value>\n".
  const text = Buffer.from(data).toString("utf8");
  for (const record of text.split("\n")) {
    const match = /^\d+ path=(.*)$/u.exec(record);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Unpacks a gzipped tar (an npm package) into `destination`. Regular files and folders
 * only; entries that would land outside `destination` are skipped.
 */
export async function extractTarGz(archive: Uint8Array, destination: string): Promise<number> {
  const tar = await gunzipAsync(archive);
  const root = NodePath.resolve(destination);
  let offset = 0;
  let pendingPath: string | undefined;
  let written = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = readTarString(header, 257, 6).startsWith("ustar")
      ? readTarString(header, 345, 155)
      : "";
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x") {
      pendingPath = parsePaxPath(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      pendingPath = readTarString(data, 0, data.length);
      continue;
    }
    const entryPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    const target = NodePath.resolve(root, ...entryPath.split("/").filter(Boolean));
    if (target !== root && !target.startsWith(`${root}${NodePath.sep}`)) continue;
    if (type === "5") {
      await FS.mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0" || type === "7") {
      await FS.mkdir(NodePath.dirname(target), { recursive: true });
      await FS.writeFile(target, data);
      written += 1;
    }
    // Links and devices are not part of npm packages Moss installs; skip them.
  }
  return written;
}

const REGISTRY_ORIGINS = [
  "https://registry.npmjs.org",
  "https://registry.npmmirror.com",
  "https://cdn.npmmirror.com",
];

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const proxyUrl = resolveOutboundProxyUrl(url, process.env);
  const response = await outboundHttp.request({
    url,
    policy: {
      service: "moss-agent-install-npm",
      allowedOrigins: REGISTRY_ORIGINS,
      timeoutMs: 120_000,
      maxRequestBytes: 0,
      maxResponseBytes: maxBytes,
      maxRedirects: 3,
      maxConcurrent: 2,
      maxQueued: 4,
      // Fake-IP proxies (Clash, Surge) hand out 198.18.0.0/15 for the hosts they carry.
      allowBenchmarkAddressRange: true,
      ...(proxyUrl ? { proxyUrl } : {}),
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.body;
}

/**
 * The npm Moss runs agents' installs with when the person has none: the one fetched
 * earlier, else the latest from the first registry that answers.
 */
export async function ensureMossNpm(input: {
  readonly mossHomeDir: string;
  readonly registries: ReadonlyArray<string>;
  /** Test seam. */
  readonly fetchBytes?: (url: string, maxBytes: number) => Promise<Uint8Array>;
}): Promise<string> {
  const existing = await findMossNpmCli(input.mossHomeDir);
  if (existing) return existing;
  const fetchImpl = input.fetchBytes ?? fetchBytes;
  let lastError: unknown = new Error("No registry was tried.");
  for (const registry of input.registries) {
    try {
      const metadata = JSON.parse(
        Buffer.from(
          await fetchImpl(`${registry.replace(/\/+$/u, "")}/npm/latest`, 2_000_000),
        ).toString("utf8"),
      ) as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } };
      const version = typeof metadata.version === "string" ? metadata.version : null;
      const tarball = typeof metadata.dist?.tarball === "string" ? metadata.dist.tarball : null;
      const integrity =
        typeof metadata.dist?.integrity === "string" ? metadata.dist.integrity : null;
      if (!version || !/^[0-9][0-9A-Za-z.+-]*$/u.test(version) || !tarball || !integrity) {
        throw new Error(`${registry} gave no usable npm release.`);
      }
      const archive = await fetchImpl(tarball, 40_000_000);
      if (!matchesIntegrity(archive, integrity)) {
        throw new Error(`npm ${version} from ${registry} failed its integrity check.`);
      }
      const finalDir = NodePath.join(mossNpmRoot(input.mossHomeDir), version);
      const stagingDir = `${finalDir}.partial-${process.pid}`;
      await FS.rm(stagingDir, { recursive: true, force: true });
      await extractTarGz(archive, stagingDir);
      const cli = NodePath.join(stagingDir, "package", "bin", "npm-cli.js");
      if (!(await fileExists(cli))) throw new Error(`npm ${version} has no npm-cli.js.`);
      await FS.rm(finalDir, { recursive: true, force: true });
      await FS.rename(stagingDir, finalDir);
      return NodePath.join(finalDir, "package", "bin", "npm-cli.js");
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * A `node` command next to the agents Moss installed, running Moss's own runtime, so
 * their npm launchers (`opencode.cmd` → `node …`) start on a computer without Node. It
 * sits at the end of PATH: a real Node the person installs later wins.
 */
export async function writeNodeShim(input: {
  readonly binDirectory: string;
  readonly runtime: MossNodeRuntime;
  readonly platform?: NodeJS.Platform;
}): Promise<string> {
  const platform = input.platform ?? process.platform;
  await FS.mkdir(input.binDirectory, { recursive: true });
  const assignments = Object.entries(input.runtime.env);
  if (platform === "win32") {
    const shimPath = NodePath.join(input.binDirectory, "node.cmd");
    const lines = [
      "@ECHO off",
      "SETLOCAL",
      ...assignments.map(([key, value]) => `SET "${key}=${value}"`),
      `"${input.runtime.command}" %*`,
    ];
    await FS.writeFile(shimPath, `${lines.join("\r\n")}\r\n`);
    return shimPath;
  }
  const shimPath = NodePath.join(input.binDirectory, "node");
  const exports = assignments.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  await FS.writeFile(
    shimPath,
    `#!/bin/sh\nexec ${exports ? `env ${exports} ` : ""}${shellQuote(input.runtime.command)} "$@"\n`,
  );
  await FS.chmod(shimPath, 0o755);
  return shimPath;
}

/**
 * Keeps an existing `node` shim pointing at this Moss: an update can move the app, and the
 * agents Moss installed earlier still need their `node`. Does nothing when there is none.
 */
export async function refreshNodeShim(
  binDirectory: string,
  runtime: MossNodeRuntime | null = resolveMossNodeRuntime(),
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const shimPath = NodePath.join(binDirectory, platform === "win32" ? "node.cmd" : "node");
  if (!runtime || !(await fileExists(shimPath))) return false;
  await writeNodeShim({ binDirectory, runtime, platform });
  return true;
}
