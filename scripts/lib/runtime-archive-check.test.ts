import { agentRuntimeObjectPath } from "@moss/shared/agentRuntimeStore";
import { describe, expect, it } from "vitest";

import { AGENT_RUNTIME_PINS_FEED_FILE } from "./agent-runtime-archives.ts";
import {
  checkRuntimeArchivesServed,
  formatRuntimeArchiveLine,
  parseRuntimePins,
  RUNTIME_PINS_FILE_NAME,
  runtimeArchiveObjectPath,
  runtimeArchivesMissingMessage,
  type RuntimeArchivePin,
} from "./runtime-archive-check.ts";

const SHA256 = "0123456789abcdef".repeat(4);
const pin: RuntimeArchivePin = {
  name: "codex",
  version: "1.2.3",
  platform: "win32",
  arch: "x64",
  archive: { size: 4096, sha256: SHA256 },
};
const PATH = "runtimes/v1/codex/1.2.3/codex-1.2.3-win32-x64-0123456789abcdef.tar.zst";
const COS = { label: "cos-folder", baseUrl: "https://cos.example.test/" };
const R2 = { label: "r2-folder", baseUrl: "https://r2.example.test/" };
const quick = { attempts: 3, retryDelayMs: 0, timeoutMs: 50 };

const pinsText = (runtimes: unknown[], schemaVersion: unknown = 1) =>
  JSON.stringify({ schemaVersion, appVersion: "2.0.0", runtimes });

type Answer = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A network that answers each request with the next answer for its URL, recording every call. */
function network(answers: Record<string, Answer[]>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    const queue = answers[url];
    const answer = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!answer) throw new Error(`unexpected request ${url}`);
    return answer(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const partial = (total: number | string) => () =>
  new Response(new Uint8Array(1), {
    status: 206,
    headers: { "content-range": `bytes 0-0/${total}` },
  });
const status = (code: number) => () => new Response(null, { status: code });
const hang: Answer = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

describe("runtime-pins.json", () => {
  it("names each archive exactly as the app requests it", () => {
    expect(runtimeArchiveObjectPath(pin)).toBe(PATH);
  });

  it("is the app's own path function, and names the file the build writes", () => {
    const full = { ...pin, executable: "codex.exe", files: [] };
    expect(runtimeArchiveObjectPath(pin)).toBe(agentRuntimeObjectPath(full));
    expect(RUNTIME_PINS_FILE_NAME).toBe(AGENT_RUNTIME_PINS_FEED_FILE);
  });

  it("reads schemaVersion 1, keeping only what names and sizes each archive", () => {
    expect(
      parseRuntimePins(pinsText([{ ...pin, executable: "codex.exe", files: [{ path: "x" }] }])),
    ).toEqual([pin]);
    expect(parseRuntimePins(pinsText([]))).toEqual([]);
  });

  it.each([
    ["another schemaVersion", pinsText([pin], 2), /schemaVersion 2/],
    ["no schemaVersion", JSON.stringify({ runtimes: [pin] }), /schemaVersion undefined/],
    ["no runtimes list", JSON.stringify({ schemaVersion: 1 }), /no "runtimes" list/],
    ["not JSON", "{", /not valid JSON/],
    ["a list instead of an object", JSON.stringify([pin]), /must be an object/],
    [
      "an uppercase sha256",
      pinsText([{ ...pin, archive: { size: 1, sha256: SHA256.toUpperCase() } }]),
      /invalid runtime/,
    ],
    [
      "a short sha256",
      pinsText([{ ...pin, archive: { size: 1, sha256: "abc" } }]),
      /invalid runtime/,
    ],
    [
      "a zero size",
      pinsText([{ ...pin, archive: { size: 0, sha256: SHA256 } }]),
      /invalid runtime/,
    ],
    [
      "a fractional size",
      pinsText([{ ...pin, archive: { size: 1.5, sha256: SHA256 } }]),
      /invalid runtime/,
    ],
    [
      "no archive",
      pinsText([{ name: "codex", version: "1", platform: "p", arch: "a" }]),
      /invalid runtime/,
    ],
    ["a climb in the name", pinsText([{ ...pin, name: ".." }]), /segments/],
    [
      "a climb in the version",
      pinsText([{ ...pin, version: "1.2.3/../../../desktop" }]),
      /segments/,
    ],
    [
      "a slash in the platform",
      pinsText([{ ...pin, platform: "win32/x" }]),
      /runtimes\/v1\/<name>/,
    ],
    ["an encoded climb", pinsText([{ ...pin, version: "%2e%2e" }]), /plain object path/],
    ["a backslash", pinsText([{ ...pin, name: "co\\dex" }]), /relative path/],
  ])("refuses %s", (_label, text, message) => {
    expect(() => parseRuntimePins(text)).toThrow(message);
  });
});

describe("checkRuntimeArchivesServed", () => {
  it("accepts a 206 whose total is the pinned size, asked with an anonymous one-byte GET", async () => {
    const net = network({ [`${COS.baseUrl}${PATH}`]: [partial(4096)] });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [COS],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines).toEqual([
      { store: "cos-folder", url: `${COS.baseUrl}${PATH}`, ok: true, problem: null },
    ]);
    const init = net.calls[0]?.init;
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("range")).toBe("bytes=0-0");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a 200 whose length is the pinned size and cancels the body unread", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulled += 1;
          controller.enqueue(new Uint8Array(4096));
        },
        cancel: () => {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const net = network({
      [`${R2.baseUrl}${PATH}`]: [
        () => new Response(body, { status: 200, headers: { "content-length": "4096" } }),
      ],
    });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [R2],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines[0]?.ok).toBe(true);
    expect(cancelled).toBe(true);
    expect(pulled).toBe(0);
  });

  it("fails at once on a wrong size, from either answer", async () => {
    const net = network({
      [`${COS.baseUrl}${PATH}`]: [partial(4095)],
      [`${R2.baseUrl}${PATH}`]: [
        () => new Response(null, { status: 200, headers: { "content-length": "10" } }),
      ],
    });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [COS, R2],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines.map((line) => [line.store, line.ok, line.problem])).toEqual([
      ["cos-folder", false, "served 4095 bytes, pinned 4096"],
      ["r2-folder", false, "served 10 bytes, pinned 4096"],
    ]);
    expect(net.calls).toHaveLength(2);
  });

  it("does not ask again after a 404, which the Cloudflare edge would cache", async () => {
    const net = network({ [`${R2.baseUrl}${PATH}`]: [status(404)] });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [R2],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines[0]).toMatchObject({ ok: false, problem: "not served (HTTP 404)" });
    expect(net.calls).toHaveLength(1);
  });

  it("tries again after a 408 or a 429, which do not say the object is missing", async () => {
    const net = network({ [`${R2.baseUrl}${PATH}`]: [status(429), status(408), partial(4096)] });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [R2],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines[0]).toMatchObject({ ok: true, problem: null });
    expect(net.calls).toHaveLength(3);
  });

  it("tries again after a timeout, a network error or a 5xx", async () => {
    const net = network({
      [`${COS.baseUrl}${PATH}`]: [hang, status(503), partial(4096)],
      [`${R2.baseUrl}${PATH}`]: [
        () => {
          throw new TypeError("fetch failed");
        },
        partial(4096),
      ],
    });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [COS, R2],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines.map((line) => line.ok)).toEqual([true, true]);
    expect(net.calls.map((call) => call.url)).toEqual([
      `${COS.baseUrl}${PATH}`,
      `${COS.baseUrl}${PATH}`,
      `${COS.baseUrl}${PATH}`,
      `${R2.baseUrl}${PATH}`,
      `${R2.baseUrl}${PATH}`,
    ]);
  });

  it("gives up after a few tries on answers without a usable length", async () => {
    const net = network({
      [`${R2.baseUrl}${PATH}`]: [
        () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }),
      ],
    });

    const lines = await checkRuntimeArchivesServed({
      pins: [pin],
      stores: [R2],
      fetchImpl: net.fetchImpl,
      ...quick,
    });

    expect(lines[0]).toMatchObject({
      ok: false,
      problem: "not served after 3 tries (HTTP 200 without a usable length)",
    });
    expect(net.calls).toHaveLength(3);
  });

  it("checks nothing without pins, and words the operator's next step", async () => {
    const net = network({});
    expect(
      await checkRuntimeArchivesServed({ pins: [], stores: [COS], fetchImpl: net.fetchImpl }),
    ).toEqual([]);
    expect(net.calls).toEqual([]);

    const missing = {
      store: "r2-folder",
      url: `${R2.baseUrl}${PATH}`,
      ok: false,
      problem: "not served (HTTP 404)",
    };
    expect(formatRuntimeArchiveLine(missing)).toBe(
      `FAIL r2-folder ${R2.baseUrl}${PATH}: not served (HTTP 404)`,
    );
    const message = runtimeArchivesMissingMessage([missing]);
    expect(message).toContain(`${R2.baseUrl}${PATH} (r2-folder): not served (HTTP 404)`);
    expect(message).toContain("bun run scripts/upload-moss-runtimes.ts --out");
    expect(message).toContain("then publish again");
  });
});
