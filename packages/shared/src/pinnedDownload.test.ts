import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyPinnedDownloadError,
  downloadPinnedFile,
  PinnedDownloadError,
  type PinnedDownloadInput,
} from "./pinnedDownload";

const FILE = randomBytes(256 * 1024 + 123);
const SHA = createHash("sha256").update(FILE).digest("hex");

type Handler = (request: IncomingMessage, response: ServerResponse, hit: number) => void;

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function rangeStart(request: IncomingMessage): number {
  return Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? 0);
}

/** Serves FILE (or `body`) with single-range support, as COS and R2 do. */
function sendRange(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer = FILE,
  limit?: number,
) {
  const start = rangeStart(request);
  if (start >= body.length) {
    response.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
    return;
  }
  const slice = body.subarray(
    start,
    limit === undefined ? body.length : Math.min(body.length, start + limit),
  );
  response.writeHead(206, {
    "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
    "Content-Length": String(body.length - start),
  });
  if (limit === undefined) response.end(slice);
  else response.write(slice); // then hangs: a stalled source
}

async function serve(
  handler: Handler,
): Promise<{ url: string; hits: () => number; ranges: string[] }> {
  let hits = 0;
  const ranges: string[] = [];
  const server = createServer((request, response) => {
    hits += 1;
    ranges.push(request.headers.range ?? "");
    handler(request, response, hits);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/runtimes/v1/codex/1.0.0/codex-1.0.0-win32-x64.tar.zst`,
    hits: () => hits,
    ranges,
  };
}

function folder(): string {
  // A profile path with spaces and non-ASCII characters, as real Windows user names have.
  const root = mkdtempSync(join(tmpdir(), "moss pinned 下载 é-"));
  folders.push(root);
  return root;
}

function input(
  sources: string[],
  destinationPath: string,
  extra: Partial<PinnedDownloadInput> = {},
) {
  return {
    sources,
    size: FILE.length,
    sha256: SHA,
    destinationPath,
    fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
      fetch(url, init),
    connectTimeoutMs: 1_000,
    stallTimeoutMs: 300,
    retryDelaysMs: [],
    sleep: async () => undefined,
    ...extra,
  } satisfies PinnedDownloadInput;
}

describe("downloadPinnedFile", () => {
  it("downloads and verifies a pinned file, with one progress figure ending at the total", async () => {
    const source = await serve((request, response) => sendRange(request, response));
    const destination = join(folder(), "codex.tar.zst");
    const progress: number[] = [];
    const report = await downloadPinnedFile(
      input([source.url], destination, { onProgress: ({ bytes }) => progress.push(bytes) }),
    );
    expect(readFileSync(destination).equals(FILE)).toBe(true);
    expect(existsSync(`${destination}.partial`)).toBe(false);
    expect(progress.at(-1)).toBe(FILE.length);
    expect(report).toMatchObject({
      outcome: "ok",
      sourceIndex: 0,
      switches: 0,
      retries: 0,
      bytesTransferred: FILE.length,
    });
    expect(source.ranges).toEqual(["bytes=0-"]);
  });

  it("moves to the next source at the same offset when one stalls mid-file", async () => {
    const stalling = await serve((request, response) =>
      sendRange(request, response, FILE, 100_000),
    );
    const healthy = await serve((request, response) => sendRange(request, response));
    const destination = join(folder(), "codex.tar.zst");
    const report = await downloadPinnedFile(input([stalling.url, healthy.url], destination));
    expect(readFileSync(destination).equals(FILE)).toBe(true);
    expect(healthy.ranges).toEqual(["bytes=100000-"]);
    expect(report).toMatchObject({
      outcome: "ok",
      sourceIndex: 1,
      switches: 1,
      bytesTransferred: FILE.length,
    });
  });

  it("moves on when a source never answers (connect timeout) or answers 500", async () => {
    const silent = await serve(() => undefined);
    const broken = await serve((_request, response) => response.writeHead(500).end());
    const healthy = await serve((request, response) => sendRange(request, response));
    const destination = join(folder(), "codex.tar.zst");
    const report = await downloadPinnedFile(
      input([silent.url, broken.url, healthy.url], destination, { connectTimeoutMs: 200 }),
    );
    expect(readFileSync(destination).equals(FILE)).toBe(true);
    expect(report).toMatchObject({
      outcome: "ok",
      sourceIndex: 2,
      switches: 2,
      lastHttpStatus: 500,
    });
  });

  it("resumes from the partial file a previous run left behind", async () => {
    const source = await serve((request, response) => sendRange(request, response));
    const destination = join(folder(), "codex.tar.zst");
    writeFileSync(`${destination}.partial`, FILE.subarray(0, 70_000));
    const report = await downloadPinnedFile(input([source.url], destination));
    expect(readFileSync(destination).equals(FILE)).toBe(true);
    expect(source.ranges).toEqual(["bytes=70000-"]);
    expect(report).toMatchObject({
      resumedFromBytes: 70_000,
      bytesTransferred: FILE.length - 70_000,
    });
  });

  it("keeps the bytes it has when every source fails, so the next run resumes", async () => {
    const stalling = await serve((request, response) => sendRange(request, response, FILE, 50_000));
    const destination = join(folder(), "codex.tar.zst");
    const failure = await downloadPinnedFile(input([stalling.url], destination)).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(PinnedDownloadError);
    expect(failure.failure).toBe("stalled");
    expect(statSync(`${destination}.partial`).size).toBe(50_000);
  });

  it("never appends a 200 answer to a ranged request; the next source continues instead", async () => {
    // The R2 host answers about one ranged request in ten with 200 and the whole file.
    const ignoring = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": String(FILE.length) });
      response.end(FILE);
    });
    const healthy = await serve((request, response) => sendRange(request, response));
    const destination = join(folder(), "codex.tar.zst");
    writeFileSync(`${destination}.partial`, FILE.subarray(0, 4_096));
    const report = await downloadPinnedFile(input([ignoring.url, healthy.url], destination));
    expect(readFileSync(destination).equals(FILE)).toBe(true);
    expect(healthy.ranges).toEqual(["bytes=4096-"]);
    expect(report).toMatchObject({
      sourceIndex: 1,
      switches: 1,
      lastHttpStatus: 200,
      mismatchRestarts: 0,
    });
  });

  it("accepts a 200 when the download starts at byte 0", async () => {
    const plain = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": String(FILE.length) });
      response.end(FILE);
    });
    const destination = join(folder(), "codex.tar.zst");
    const report = await downloadPinnedFile(input([plain.url], destination));
    expect(readFileSync(destination).equals(FILE)).toBe(true);
    expect(report.switches).toBe(0);
  });

  it("refuses a range answer that starts elsewhere or describes another file", async () => {
    const wrong = await serve((_request, response) => {
      response.writeHead(206, { "Content-Range": `bytes 0-9/${FILE.length + 1}` });
      response.end(FILE.subarray(0, 10));
    });
    const destination = join(folder(), "codex.tar.zst");
    const failure = await downloadPinnedFile(input([wrong.url], destination)).catch(
      (error) => error,
    );
    expect(failure.failure).toBe("http");
    expect(existsSync(destination)).toBe(false);
  });

  it("restarts once on a sha256 mismatch, then fails and deletes the bytes", async () => {
    const corrupt = Buffer.from(FILE);
    corrupt[1234] = corrupt[1234]! ^ 0xff;
    const source = await serve((request, response) => sendRange(request, response, corrupt));
    const destination = join(folder(), "codex.tar.zst");
    const failure = await downloadPinnedFile(input([source.url], destination)).catch(
      (error) => error,
    );
    expect(failure.failure).toBe("mismatch");
    expect(failure.report.mismatchRestarts).toBe(1);
    expect(source.ranges).toEqual(["bytes=0-", "bytes=0-"]);
    expect(existsSync(`${destination}.partial`)).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it("succeeds after a mismatch when the second download is right", async () => {
    const corrupt = Buffer.from(FILE);
    corrupt[0] = corrupt[0]! ^ 0xff;
    const source = await serve((request, response, hit) =>
      sendRange(request, response, hit === 1 ? corrupt : FILE),
    );
    const destination = join(folder(), "codex.tar.zst");
    const report = await downloadPinnedFile(input([source.url], destination));
    expect(report.mismatchRestarts).toBe(1);
    expect(readFileSync(destination).equals(FILE)).toBe(true);
  });

  it("waits between rounds with the reason, then carries on from the same offset", async () => {
    const source = await serve((request, response, hit) =>
      hit === 1 ? sendRange(request, response, FILE, 30_000) : sendRange(request, response),
    );
    const destination = join(folder(), "codex.tar.zst");
    const waits: string[] = [];
    const report = await downloadPinnedFile(
      input([source.url], destination, {
        retryDelaysMs: [5],
        onWaiting: ({ failure, retryInMs, bytes }) =>
          waits.push(`${failure}:${retryInMs}:${bytes}`),
      }),
    );
    expect(waits).toEqual(["stalled:5:30000"]);
    expect(source.ranges).toEqual(["bytes=0-", "bytes=30000-"]);
    expect(report).toMatchObject({ outcome: "ok", retries: 1 });
  });

  it("reports offline when every source fails to resolve, and proxy when a proxy is in the way", async () => {
    const offline = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND update.example"), {
        code: "ENOTFOUND",
      }),
    });
    const destination = join(folder(), "codex.tar.zst");
    const failure = await downloadPinnedFile(
      input(["https://a.invalid/x", "https://b.invalid/x"], destination, {
        fetch: async () => {
          throw offline;
        },
      }),
    ).catch((error) => error);
    expect(failure.failure).toBe("offline");
    expect(failure.report.switches).toBe(1);
    expect(classifyPinnedDownloadError(new Error("net::ERR_PROXY_CONNECTION_FAILED"))).toBe(
      "proxy",
    );
    expect(classifyPinnedDownloadError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(
      "offline",
    );
    expect(
      classifyPinnedDownloadError(Object.assign(new Error("no space"), { code: "ENOSPC" })),
    ).toBe("disk");
  });

  it("stops at once when cancelled", async () => {
    const stalling = await serve((request, response) => sendRange(request, response, FILE, 10_000));
    const destination = join(folder(), "codex.tar.zst");
    const controller = new AbortController();
    const pending = downloadPinnedFile(
      input([stalling.url], destination, { stallTimeoutMs: 10_000, signal: controller.signal }),
    ).catch((error) => error);
    setTimeout(() => controller.abort(), 100);
    expect((await pending).failure).toBe("aborted");
  });

  it("reuses a destination an earlier run already verified, without a request", async () => {
    const source = await serve((request, response) => sendRange(request, response));
    const destination = join(folder(), "codex.tar.zst");
    writeFileSync(destination, FILE);
    await downloadPinnedFile(input([source.url], destination));
    expect(source.hits()).toBe(0);
  });
});
