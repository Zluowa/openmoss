import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syntheticAgentZip } from "./agentInstallZip.testHelpers.ts";
import {
  DEVIN_FULL_ARCHIVE_TIMEOUT_MS,
  DEVIN_RANGE_CHUNK_BYTES,
  DEVIN_STATIC_ORIGIN,
  downloadDevinArchiveBytes,
  manifestUrlForDevinDistribution,
  resolveDevinWindowsTargetTriple,
  updateDevinWindowsNative,
} from "./devinWindowsUpdate.ts";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "moss-devin-win-update-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await FS.rm(dir, { recursive: true, force: true });
  }
});

describe("devinWindowsUpdate", () => {
  it("selects target triples and distribution manifest URLs accurately", () => {
    expect(resolveDevinWindowsTargetTriple("x64")).toBe("x86_64-pc-windows");
    expect(resolveDevinWindowsTargetTriple("arm64")).toBe("aarch64-pc-windows");
    expect(manifestUrlForDevinDistribution(null)).toBe(
      `${DEVIN_STATIC_ORIGIN}/cli/current/manifest.json`,
    );
    expect(manifestUrlForDevinDistribution("irm-iex")).toBe(
      `${DEVIN_STATIC_ORIGIN}/cli/current/manifest.json`,
    );
    expect(manifestUrlForDevinDistribution("irm-iex-enterprise")).toBe(
      `${DEVIN_STATIC_ORIGIN}/cli/current/manifest-enterprise.json`,
    );
    expect(() => manifestUrlForDevinDistribution("enterprise-portal")).toThrow(
      /enterprise portal/i,
    );
  });

  it("downloads verified zip, swaps binary safely, updates _versions and cached_version, and preserves distribution", async () => {
    const root = await makeTempDir();
    const installRoot = Path.join(root, "devin", "cli");
    const binDir = Path.join(installRoot, "bin");
    const versionsDir = Path.join(installRoot, "_versions");
    const exePath = Path.join(binDir, "devin.exe");
    await FS.mkdir(binDir, { recursive: true });
    await FS.mkdir(versionsDir, { recursive: true });
    await FS.writeFile(exePath, "old-devin-3000.11.3");
    await FS.writeFile(Path.join(installRoot, "distribution"), "irm-iex\n");
    await FS.writeFile(
      Path.join(installRoot, "cached_version.json"),
      JSON.stringify({ version: "3000.11.3", distribution: "irm-iex" }),
    );

    const newBinaryContent = "new-devin-3000.14.30821";
    const zipBuffer = syntheticAgentZip([
      { name: "bin/", content: "" },
      { name: "bin/devin.exe", content: newBinaryContent, deflate: true },
    ]);
    const zipSha = createHash("sha256").update(zipBuffer).digest("hex");
    const bundleUrl = `${DEVIN_STATIC_ORIGIN}/cli/3000.14.30821/devin-3000.14.30821-x86_64-pc-windows.zip`;
    const manifestJson = JSON.stringify({
      version: "3000.14.30821",
      platforms: {
        "x86_64-pc-windows": { url: bundleUrl, sha256: zipSha },
      },
    });

    const result = await updateDevinWindowsNative({
      binaryPath: exePath,
      arch: "x64",
      fetchBytes: async (url) => {
        if (url === `${DEVIN_STATIC_ORIGIN}/cli/current/manifest.json`) {
          return Buffer.from(manifestJson, "utf8");
        }
        if (url === bundleUrl) {
          return zipBuffer;
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    expect(result.version).toBe("3000.14.30821");
    expect(result.targetPath).toBe(exePath);
    expect(result.triple).toBe("x86_64-pc-windows");
    expect(await FS.readFile(exePath, "utf8")).toBe(newBinaryContent);
    expect(
      await FS.readFile(Path.join(versionsDir, "3000.14.30821", "bin", "devin.exe"), "utf8"),
    ).toBe(newBinaryContent);
    expect(await FS.readFile(Path.join(installRoot, "distribution"), "utf8")).toBe("irm-iex\n");
    const cached = JSON.parse(
      await FS.readFile(Path.join(installRoot, "cached_version.json"), "utf8"),
    ) as { version: string; distribution: string };
    expect(cached).toEqual({ version: "3000.14.30821", distribution: "irm-iex" });
  });

  it("rejects SHA-256 mismatch without touching the installed binary", async () => {
    const root = await makeTempDir();
    const exePath = Path.join(root, "devin", "cli", "bin", "devin.exe");
    await FS.mkdir(Path.dirname(exePath), { recursive: true });
    await FS.writeFile(exePath, "original-binary");

    const zipBuffer = syntheticAgentZip([{ name: "bin/devin.exe", content: "tampered" }]);
    const wrongSha = "0".repeat(64);
    const bundleUrl = `${DEVIN_STATIC_ORIGIN}/cli/3000.14.30821/devin.zip`;

    await expect(
      updateDevinWindowsNative({
        binaryPath: exePath,
        arch: "x64",
        fetchBytes: async (url) =>
          url.endsWith("manifest.json")
            ? Buffer.from(
                JSON.stringify({
                  version: "3000.14.30821",
                  platforms: { "x86_64-pc-windows": { url: bundleUrl, sha256: wrongSha } },
                }),
              )
            : zipBuffer,
      }),
    ).rejects.toThrow(/SHA-256/i);

    expect(await FS.readFile(exePath, "utf8")).toBe("original-binary");
  });

  it("rejects bundle URLs outside static.devin.ai", async () => {
    const root = await makeTempDir();
    const exePath = Path.join(root, "bin", "devin.exe");
    await FS.mkdir(Path.dirname(exePath), { recursive: true });
    await FS.writeFile(exePath, "original-binary");

    await expect(
      updateDevinWindowsNative({
        binaryPath: exePath,
        arch: "x64",
        fetchBytes: async () =>
          Buffer.from(
            JSON.stringify({
              version: "3000.14.30821",
              platforms: {
                "x86_64-pc-windows": {
                  url: "https://evil.example.com/devin.zip",
                  sha256: "a".repeat(64),
                },
              },
            }),
          ),
      }),
    ).rejects.toThrow(/static\.devin\.ai/i);
  });

  it("rolls back the original binary if renaming the staged executable fails", async () => {
    const root = await makeTempDir();
    const exePath = Path.join(root, "devin", "cli", "bin", "devin.exe");
    await FS.mkdir(Path.dirname(exePath), { recursive: true });
    await FS.writeFile(exePath, "original-binary");

    const zipBuffer = syntheticAgentZip([{ name: "bin/devin.exe", content: "updated-binary" }]);
    const zipSha = createHash("sha256").update(zipBuffer).digest("hex");
    const bundleUrl = `${DEVIN_STATIC_ORIGIN}/cli/3000.14.30821/devin.zip`;

    await expect(
      updateDevinWindowsNative({
        binaryPath: exePath,
        arch: "x64",
        fetchBytes: async (url) =>
          url.endsWith("manifest.json")
            ? Buffer.from(
                JSON.stringify({
                  version: "3000.14.30821",
                  platforms: { "x86_64-pc-windows": { url: bundleUrl, sha256: zipSha } },
                }),
              )
            : zipBuffer,
        renameFile: async (from, to) => {
          if (from.includes(".new-") && to === exePath) {
            throw new Error("simulated rename failure");
          }
          await FS.rename(from, to);
        },
      }),
    ).rejects.toThrow(/simulated rename failure/);

    expect(await FS.readFile(exePath, "utf8")).toBe("original-binary");
  });

  it("updates the latest field in cached_version.json alongside version metadata", async () => {
    const root = await makeTempDir();
    const installRoot = Path.join(root, "devin", "cli");
    const binDir = Path.join(installRoot, "bin");
    const exePath = Path.join(binDir, "devin.exe");
    await FS.mkdir(binDir, { recursive: true });
    await FS.writeFile(exePath, "old-devin");
    await FS.writeFile(
      Path.join(installRoot, "cached_version.json"),
      JSON.stringify({ latest: "3000.11.234" }),
    );

    const zipBuffer = syntheticAgentZip([{ name: "bin/devin.exe", content: "new-devin-binary" }]);
    const zipSha = createHash("sha256").update(zipBuffer).digest("hex");
    const bundleUrl = `${DEVIN_STATIC_ORIGIN}/cli/3000.14.30821/devin.zip`;

    await updateDevinWindowsNative({
      binaryPath: exePath,
      arch: "x64",
      fetchBytes: async (url) =>
        url.endsWith("manifest.json")
          ? Buffer.from(
              JSON.stringify({
                version: "3000.14.30821",
                platforms: { "x86_64-pc-windows": { url: bundleUrl, sha256: zipSha } },
              }),
            )
          : zipBuffer,
    });

    const cached = JSON.parse(
      await FS.readFile(Path.join(installRoot, "cached_version.json"), "utf8"),
    ) as { latest: string };
    expect(cached).toEqual({ latest: "3000.14.30821" });
  });

  it("downloads archive via concurrent HTTP 206 chunks and retries transient chunk failures", async () => {
    const payload = Buffer.alloc(DEVIN_RANGE_CHUNK_BYTES * 2 + 1_234);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 31) & 0xff;
    }
    const bundleUrl = `${DEVIN_STATIC_ORIGIN}/cli/3000.14.30821/devin.zip`;
    const rangeRequests: string[] = [];
    let thirdChunkAttempts = 0;

    const downloaded = await downloadDevinArchiveBytes(
      bundleUrl,
      350 * 1024 * 1024,
      {},
      async (request) => {
        if (request.method === "HEAD") {
          return {
            status: 200,
            url: bundleUrl,
            headers: new Headers({
              "content-length": String(payload.length),
              "accept-ranges": "bytes",
            }),
            body: new Uint8Array(0),
          };
        }
        const rangeHeader = new Headers(request.headers).get("range") ?? "";
        rangeRequests.push(rangeHeader);
        const match = /^bytes=(\d+)-(\d+)$/u.exec(rangeHeader);
        if (!match) {
          throw new Error(`Expected Range header, received: ${rangeHeader}`);
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (start === DEVIN_RANGE_CHUNK_BYTES * 2 && thirdChunkAttempts === 0) {
          thirdChunkAttempts += 1;
          return {
            status: 503,
            url: bundleUrl,
            headers: new Headers(),
            body: new Uint8Array(0),
          };
        }
        return {
          status: 206,
          url: bundleUrl,
          headers: new Headers(),
          body: new Uint8Array(payload.subarray(start, end + 1)),
        };
      },
      { delayMs: async () => undefined },
    );

    expect(Buffer.from(downloaded).equals(payload)).toBe(true);
    expect(rangeRequests).toContain(`bytes=0-${DEVIN_RANGE_CHUNK_BYTES - 1}`);
    expect(rangeRequests).toContain(
      `bytes=${DEVIN_RANGE_CHUNK_BYTES}-${DEVIN_RANGE_CHUNK_BYTES * 2 - 1}`,
    );
    expect(rangeRequests).toContain(`bytes=${DEVIN_RANGE_CHUNK_BYTES * 2}-${payload.length - 1}`);
    expect(thirdChunkAttempts).toBe(1);
  });

  it("falls back to single full GET when HEAD omits Accept-Ranges or chunk 0 answers 200", async () => {
    const payload = Buffer.alloc(DEVIN_RANGE_CHUNK_BYTES + 2_048, 0x42);
    const bundleUrl = `${DEVIN_STATIC_ORIGIN}/cli/3000.14.30821/devin.zip`;

    // Case 1: HEAD omits Accept-Ranges: bytes -> falls straight back to single GET with 15-min timeout.
    const noRangesMethods: Array<{ method: string | undefined; timeoutMs: number }> = [];
    const fromHeadFallback = await downloadDevinArchiveBytes(
      bundleUrl,
      350 * 1024 * 1024,
      {},
      async (request) => {
        noRangesMethods.push({ method: request.method, timeoutMs: request.policy.timeoutMs });
        if (request.method === "HEAD") {
          return {
            status: 200,
            url: bundleUrl,
            headers: new Headers({ "content-length": String(payload.length) }),
            body: new Uint8Array(0),
          };
        }
        return {
          status: 200,
          url: bundleUrl,
          headers: new Headers(),
          body: new Uint8Array(payload),
        };
      },
      { delayMs: async () => undefined },
    );

    expect(Buffer.from(fromHeadFallback).equals(payload)).toBe(true);
    expect(noRangesMethods).toEqual([
      { method: "HEAD", timeoutMs: 30_000 },
      { method: "GET", timeoutMs: DEVIN_FULL_ARCHIVE_TIMEOUT_MS },
    ]);

    // Case 2: HEAD advertises bytes, but initial range probe answers 200 -> falls back to full GET.
    const rangeIgnoredCalls: string[] = [];
    const fromChunk0Fallback = await downloadDevinArchiveBytes(
      bundleUrl,
      350 * 1024 * 1024,
      {},
      async (request) => {
        const range = new Headers(request.headers).get("range") ?? "none";
        rangeIgnoredCalls.push(`${request.method ?? "GET"}:${range}`);
        if (request.method === "HEAD") {
          return {
            status: 200,
            url: bundleUrl,
            headers: new Headers({
              "content-length": String(payload.length),
              "accept-ranges": "bytes",
            }),
            body: new Uint8Array(0),
          };
        }
        return {
          status: 200,
          url: bundleUrl,
          headers: new Headers(),
          body: new Uint8Array(payload),
        };
      },
      { delayMs: async () => undefined },
    );

    expect(Buffer.from(fromChunk0Fallback).equals(payload)).toBe(true);
    expect(rangeIgnoredCalls).toEqual([
      "HEAD:none",
      `GET:bytes=0-${DEVIN_RANGE_CHUNK_BYTES - 1}`,
      "GET:none",
    ]);
  });
});
