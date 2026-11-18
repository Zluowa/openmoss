import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  agentRuntimeObjectPath,
  type AgentRuntimeFetchReport,
  type AgentRuntimePin,
} from "@moss/shared/agentRuntimeStore";
import { listTarEntries, writeTarArchive } from "@moss/shared/tarArchive";

import {
  type AgentRuntimeDownloadState,
  createAgentRuntimeDownloads,
  loadAgentRuntimePins,
} from "./agentRuntimeDownloads";

const folders: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(Path.join(tmpdir(), "moss 下载 runtimes-"));
  folders.push(root);
  return root;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function packRuntime(name: string, executable: string) {
  const source = folder();
  const files: Record<string, Buffer> = {
    [executable]: randomBytes(200_000),
    "notes.txt": Buffer.from(name),
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(Path.join(source, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(Path.join(source, ...path.split("/")), bytes);
  }
  const parts: Buffer[] = [];
  for await (const chunk of writeTarArchive(await listTarEntries(source))) parts.push(chunk);
  const archive = Zlib.zstdCompressSync(Buffer.concat(parts));
  const pin: AgentRuntimePin = {
    name,
    version: "1.0.0",
    platform: "win32",
    arch: "x64",
    archive: { size: archive.length, sha256: sha(archive) },
    executable,
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: sha(bytes),
      executable: path === executable,
    })),
  };
  return { pin, archive };
}

/** Serves runtime objects like the real sources, in small slow chunks so tests can interrupt. */
async function serve(objects: Map<string, Buffer>, options: { failFirst?: number } = {}) {
  let failures = options.failFirst ?? 0;
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "").slice(1));
    requested.push(path);
    const body = objects.get(path);
    if (!body || failures > 0) {
      failures -= 1;
      response.writeHead(body ? 503 : 404).end();
      return;
    }
    const start = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? 0);
    response.writeHead(start === 0 ? 200 : 206, {
      "Content-Length": String(body.length - start),
      ...(start === 0
        ? {}
        : { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` }),
    });
    let offset = start;
    const timer = setInterval(() => {
      if (offset >= body.length || response.destroyed) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(body.subarray(offset, offset + 32_768));
      offset += 32_768;
    }, 5);
    response.on("close", () => clearInterval(timer));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, requested };
}

const nodeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  fetch(url, init);

function until(check: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

describe("agent runtime pins", () => {
  it("reads the pins a download build embedded, default agent first, for this platform only", async () => {
    const codex = await packRuntime("codex", "bin/codex.exe");
    const claude = await packRuntime("claude", "claude.exe");
    const mac = { ...claude.pin, platform: "darwin" };
    const text = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.8",
      runtimes: [claude.pin, mac, codex.pin],
    });
    const pins = await loadAgentRuntimePins({
      appPath: "/app",
      platform: "win32",
      arch: "x64",
      readText: async () => text,
    });
    expect(pins?.map((pin) => `${pin.name}/${pin.platform}`)).toEqual([
      "codex/win32",
      "claude/win32",
    ]);
  });

  it("is null in a bundled build, which has no pins file", async () => {
    const pins = await loadAgentRuntimePins({
      appPath: folder(),
      platform: "win32",
      arch: "x64",
    });
    expect(pins).toBeNull();
  });
});

describe("agent runtime downloads", () => {
  it("fetches the default runtime first, then the other, and reports each to the server and diagnostics", async () => {
    const codex = await packRuntime("codex", "bin/codex.exe");
    const claude = await packRuntime("claude", "claude.exe");
    const source = await serve(
      new Map([
        [agentRuntimeObjectPath(codex.pin), codex.archive],
        [agentRuntimeObjectPath(claude.pin), claude.archive],
      ]),
    );
    const readyOrder: string[] = [];
    const reports: AgentRuntimeFetchReport[] = [];
    const seen: AgentRuntimeDownloadState[] = [];
    const downloads = createAgentRuntimeDownloads({
      pins: [codex.pin, claude.pin],
      storeRoot: folder(),
      sourceBases: () => [source.base],
      fetch: nodeFetch,
      onChange: (states) => seen.push(...states),
      onReady: (name) => readyOrder.push(name),
      onReport: (report) => reports.push(report),
    });
    downloads.start();
    await until(() => readyOrder.length === 2);
    expect(readyOrder).toEqual(["codex", "claude"]);
    expect(source.requested[0]).toBe(agentRuntimeObjectPath(codex.pin));
    expect(reports.map((report) => `${report.name}:${report.outcome}`)).toEqual([
      "codex:ready",
      "claude:ready",
    ]);
    expect(reports[0]?.download).toMatchObject({ outcome: "ok", sourceIndex: 0 });
    expect(
      seen.some(
        (state) => state.name === "codex" && state.phase === "downloading" && state.bytes > 0,
      ),
    ).toBe(true);
    expect(downloads.states().map((state) => state.phase)).toEqual(["ready", "ready"]);
    expect([...downloads.readyPaths().keys()]).toEqual(["codex", "claude"]);
    downloads.dispose();
  });

  it("reports what is already installed at once, without a request", async () => {
    const codex = await packRuntime("codex", "bin/codex.exe");
    const source = await serve(new Map([[agentRuntimeObjectPath(codex.pin), codex.archive]]));
    const store = folder();
    const first = createAgentRuntimeDownloads({
      pins: [codex.pin],
      storeRoot: store,
      sourceBases: () => [source.base],
      fetch: nodeFetch,
      onChange: () => undefined,
      onReady: () => undefined,
      onReport: () => undefined,
    });
    first.start();
    await until(() => first.readyPaths().has("codex"));
    const requests = source.requested.length;
    const reports: AgentRuntimeFetchReport[] = [];
    const second = createAgentRuntimeDownloads({
      pins: [codex.pin],
      storeRoot: store,
      sourceBases: () => [source.base],
      fetch: nodeFetch,
      onChange: () => undefined,
      onReady: () => undefined,
      onReport: (report) => reports.push(report),
    });
    second.start();
    await until(() => second.readyPaths().has("codex"));
    expect(source.requested.length).toBe(requests);
    expect(reports).toEqual([]);
  });

  it("pauses the background runtime while a chat runs and resumes where it stopped", async () => {
    const codex = await packRuntime("codex", "bin/codex.exe");
    const claude = await packRuntime("claude", "claude.exe");
    const source = await serve(
      new Map([
        [agentRuntimeObjectPath(codex.pin), codex.archive],
        [agentRuntimeObjectPath(claude.pin), claude.archive],
      ]),
    );
    const downloads = createAgentRuntimeDownloads({
      pins: [codex.pin, claude.pin],
      storeRoot: folder(),
      sourceBases: () => [source.base],
      fetch: nodeFetch,
      onChange: () => undefined,
      onReady: () => undefined,
      onReport: () => undefined,
    });
    downloads.start();
    await until(() => {
      const claudeState = downloads.states().find((state) => state.name === "claude");
      return claudeState?.phase === "downloading" && claudeState.bytes > 0;
    });
    downloads.setBusy(true);
    await until(
      () => downloads.states().find((state) => state.name === "claude")?.phase === "paused",
    );
    downloads.setBusy(false);
    await until(() => downloads.readyPaths().has("claude"));
    // The resume asked for the rest of the file, not the whole file again.
    expect(
      source.requested.filter((path) => path === agentRuntimeObjectPath(claude.pin)).length,
    ).toBe(2);
    downloads.dispose();
  });

  it("shows a failure with its reason, tries again by itself, and on 重试 at once", async () => {
    const codex = await packRuntime("codex", "bin/codex.exe");
    const source = await serve(new Map([[agentRuntimeObjectPath(codex.pin), codex.archive]]), {
      failFirst: 1,
    });
    const timers: Array<() => void> = [];
    const reports: AgentRuntimeFetchReport[] = [];
    const downloads = createAgentRuntimeDownloads({
      pins: [codex.pin],
      storeRoot: folder(),
      sourceBases: () => [source.base],
      fetch: nodeFetch,
      retryDelaysMs: [],
      setTimer: (callback) => {
        timers.push(callback);
        return { cancel: () => undefined };
      },
      onChange: () => undefined,
      onReady: () => undefined,
      onReport: (report) => reports.push(report),
    });
    downloads.start();
    await until(() => downloads.states()[0]?.phase === "failed");
    expect(downloads.states()[0]).toMatchObject({ failure: "http", retryInMs: 60_000 });
    expect(reports[0]).toMatchObject({ name: "codex", outcome: "http" });
    expect(timers).toHaveLength(1);
    downloads.retry();
    await until(() => downloads.readyPaths().has("codex"));
    downloads.dispose();
  });
});
