import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureStaticSnapshot,
  findAsarArchivePath,
  pruneStaticSnapshotCache,
  snapshotDirectoryName,
  type StaticSnapshotProgress,
} from "./staticSnapshot";

describe("findAsarArchivePath", () => {
  it("resolves the containing archive for a path inside an asar", () => {
    expect(
      findAsarArchivePath(
        "/Applications/Moss.app/Contents/Resources/app.asar/apps/server/dist/client",
      ),
    ).toBe(path.join("/Applications/Moss.app/Contents/Resources/app.asar"));
  });

  it("returns the archive itself when the path is the asar file", () => {
    expect(findAsarArchivePath("/tmp/app.asar")).toBe(path.join("/tmp/app.asar"));
  });

  it("returns null for plain directories", () => {
    expect(findAsarArchivePath("/Users/me/dev/moss/apps/web/dist")).toBeNull();
  });
});

describe("snapshotDirectoryName", () => {
  it("keeps safe characters and replaces the rest", () => {
    expect(snapshotDirectoryName("194884627-1767900000000.123-42")).toBe(
      "194884627-1767900000000.123-42",
    );
    expect(snapshotDirectoryName("a/b\\c:d e")).toBe("a_b_c_d_e");
  });
});

describe("ensureStaticSnapshot", () => {
  let workDir: string;
  let sourceDir: string;
  let cacheRoot: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-snapshot-"));
    sourceDir = path.join(workDir, "source");
    cacheRoot = path.join(workDir, "cache");
    fs.mkdirSync(path.join(sourceDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "index.html"), "<html>v1</html>");
    fs.writeFileSync(path.join(sourceDir, "assets", "app.js"), "console.log(1)");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Background pruning and staging cleanup can still be running when a test ends.
    await fs.promises.rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  });

  function addSourceFiles(count: number): void {
    for (let index = 0; index < count; index += 1) {
      fs.writeFileSync(path.join(sourceDir, "assets", `chunk-${index}.js`), `// ${index}`);
    }
  }

  function stagingEntries(): string[] {
    return fs.existsSync(cacheRoot)
      ? fs.readdirSync(cacheRoot).filter((name) => name.startsWith(".staging-"))
      : [];
  }

  it("copies the source tree on first use", async () => {
    const result = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(result.reused).toBe(false);
    expect(fs.readFileSync(path.join(result.dir, "index.html"), "utf8")).toBe("<html>v1</html>");
    expect(fs.readFileSync(path.join(result.dir, "assets", "app.js"), "utf8")).toBe(
      "console.log(1)",
    );
  });

  it("reuses an existing snapshot for the same signature without re-reading the source", async () => {
    const first = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    fs.rmSync(sourceDir, { recursive: true, force: true });

    const second = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(second.reused).toBe(true);
    expect(second.dir).toBe(first.dir);
    expect(fs.readFileSync(path.join(second.dir, "index.html"), "utf8")).toBe("<html>v1</html>");
  });

  it("creates a fresh snapshot and prunes the old one when the signature changes", async () => {
    const first = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    fs.writeFileSync(path.join(sourceDir, "index.html"), "<html>v2</html>");

    const second = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-2" });

    expect(second.dir).not.toBe(first.dir);
    expect(fs.readFileSync(path.join(second.dir, "index.html"), "utf8")).toBe("<html>v2</html>");
    await vi.waitFor(() => expect(fs.existsSync(first.dir)).toBe(false));
  });

  it("rejects when the source is missing its sentinel so callers can fall back", async () => {
    fs.rmSync(path.join(sourceDir, "index.html"));

    await expect(
      ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" }),
    ).rejects.toThrow(/missing index\.html/);
  });

  it("does not treat a half-written staging directory as a usable snapshot", async () => {
    fs.mkdirSync(path.join(cacheRoot, ".staging-sig-1-999"), { recursive: true });

    const result = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(result.reused).toBe(false);
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(cacheRoot, ".staging-sig-1-999"))).toBe(false),
    );
  });

  it("prunes every generated snapshot when plain-directory assets make the cache obsolete", async () => {
    await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    fs.mkdirSync(path.join(cacheRoot, ".staging-orphan"), { recursive: true });

    await pruneStaticSnapshotCache(cacheRoot);

    expect(fs.readdirSync(cacheRoot)).toEqual([]);
  });

  it("keeps the event loop turning while it copies", async () => {
    addSourceFiles(200);
    let eventLoopTurns = 0;
    let isCopying = true;
    const countEventLoopTurns = (): void => {
      eventLoopTurns += 1;
      if (isCopying) setImmediate(countEventLoopTurns);
    };
    setImmediate(countEventLoopTurns);

    await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    isCopying = false;

    // A synchronous copy would allow none before it finished. With 202 files
    // copied four at a time, a healthy loop turns at least once per batch.
    expect(eventLoopTurns).toBeGreaterThanOrEqual(50);
  });

  it("never runs more than four file copies at once", async () => {
    addSourceFiles(40);
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let inFlight = 0;
    let highestInFlight = 0;
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
      inFlight += 1;
      highestInFlight = Math.max(highestInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await realWriteFile(...args);
      inFlight -= 1;
    });

    await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(highestInFlight).toBe(4);
  });

  it("reports progress for a fresh copy, starting before the first file", async () => {
    const reports: StaticSnapshotProgress[] = [];

    await ensureStaticSnapshot({
      sourceDir,
      cacheRoot,
      signature: "sig-1",
      onProgress: (progress) => reports.push(progress),
    });

    expect(reports).toEqual([
      { copiedFiles: 0, totalFiles: 2 },
      { copiedFiles: 1, totalFiles: 2 },
      { copiedFiles: 2, totalFiles: 2 },
    ]);
  });

  it("does not report progress when it reuses a snapshot", async () => {
    await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    const onProgress = vi.fn();

    await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1", onProgress });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it("never publishes a snapshot when the source changed after the last read", async () => {
    await expect(
      ensureStaticSnapshot({
        sourceDir,
        cacheRoot,
        signature: "sig-1",
        assertSourceUnchanged: () => {
          throw new Error("swapped");
        },
      }),
    ).rejects.toThrow("swapped");

    expect(fs.existsSync(path.join(cacheRoot, "sig-1"))).toBe(false);
    await vi.waitFor(() => expect(stagingEntries()).toEqual([]));
  });

  it("stops a long copy early when the source changes partway through", async () => {
    addSourceFiles(300);
    const writeFile = vi.spyOn(fs.promises, "writeFile");

    await expect(
      ensureStaticSnapshot({
        sourceDir,
        cacheRoot,
        signature: "sig-1",
        assertSourceUnchanged: () => {
          throw new Error("swapped");
        },
      }),
    ).rejects.toThrow("swapped");

    expect(writeFile.mock.calls.length).toBeLessThan(100);
    expect(fs.existsSync(path.join(cacheRoot, "sig-1"))).toBe(false);
  });

  it("removes the staging copy without publishing when a file fails to copy", async () => {
    addSourceFiles(20);
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (file, options) => {
      if (String(file).endsWith("chunk-7.js")) throw new Error("read failed");
      return realReadFile(file, options);
    });

    await expect(
      ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" }),
    ).rejects.toThrow("read failed");

    expect(fs.existsSync(path.join(cacheRoot, "sig-1"))).toBe(false);
    await vi.waitFor(() => expect(stagingEntries()).toEqual([]));
  });

  it("serves the winner's snapshot when it loses the rename race", async () => {
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (_from, to) => {
      fs.mkdirSync(String(to), { recursive: true });
      fs.writeFileSync(path.join(String(to), "index.html"), "<html>winner</html>");
      throw Object.assign(new Error("target exists"), { code: "EPERM" });
    });

    const result = await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(result).toEqual({ dir: path.join(cacheRoot, "sig-1"), reused: true });
    expect(fs.readFileSync(path.join(result.dir, "index.html"), "utf8")).toBe(
      "<html>winner</html>",
    );
    await vi.waitFor(() => expect(stagingEntries()).toEqual([]));
  });

  it("deletes a superseded snapshot one file at a time", async () => {
    addSourceFiles(30);
    await ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    const realRm = fs.promises.rm.bind(fs.promises);
    let inFlight = 0;
    let highestInFlight = 0;
    vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      inFlight += 1;
      highestInFlight = Math.max(highestInFlight, inFlight);
      await realRm(...args);
      inFlight -= 1;
    });

    await pruneStaticSnapshotCache(cacheRoot);

    expect(fs.readdirSync(cacheRoot)).toEqual([]);
    expect(highestInFlight).toBe(1);
  });
});
