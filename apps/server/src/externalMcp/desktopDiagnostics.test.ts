import { chmod, mkdir, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import {
  DESKTOP_DIAGNOSTIC_DEFAULT_LIMIT,
  DESKTOP_DIAGNOSTIC_MAX_LINE_CHARS,
  DESKTOP_DIAGNOSTIC_MAX_LIMIT,
  DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES,
  desktopDiagnosticLogFileName,
  getDesktopDiagnosticLogStatus,
  readDesktopDiagnosticLog,
} from "./desktopDiagnostics.ts";

const tempDirs: string[] = [];

async function makeLogsDir(): Promise<string> {
  const logsDir = await mkdtemp(path.join(os.tmpdir(), "moss-desktop-diagnostics-"));
  tempDirs.push(logsDir);
  await chmod(logsDir, 0o700);
  return logsDir;
}

async function writeLog(
  logsDir: string,
  source: "server" | "backend" | "desktop",
  content: string,
): Promise<string> {
  const filePath = path.join(logsDir, desktopDiagnosticLogFileName(source));
  await writeFile(filePath, content, { mode: 0o600 });
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("desktop diagnostic log status", () => {
  it("maps the fixed sources and reports bounded metadata without absolute paths", async () => {
    const logsDir = await makeLogsDir();
    await writeLog(logsDir, "server", "server ready\n");

    const status = await getDesktopDiagnosticLogStatus({ logsDir });

    expect(status.map(({ source, fileName }) => ({ source, fileName }))).toEqual([
      { source: "server", fileName: "server.log" },
      { source: "backend", fileName: "server-child.log" },
      { source: "desktop", fileName: "desktop-main.log" },
    ]);
    expect(status[0]).toEqual({
      source: "server",
      fileName: "server.log",
      sizeBytes: Buffer.byteLength("server ready\n"),
      mtime: expect.any(String),
      private: true,
      available: true,
    });
    expect(status[1]).toEqual({
      source: "backend",
      fileName: "server-child.log",
      sizeBytes: null,
      mtime: null,
      private: null,
      available: false,
    });
    expect(JSON.stringify(status)).not.toContain(logsDir);
  });

  it("represents a missing log as unavailable instead of throwing", async () => {
    const logsDir = await makeLogsDir();

    await expect(readDesktopDiagnosticLog({ logsDir, source: "desktop" })).resolves.toEqual(
      expect.objectContaining({
        source: "desktop",
        fileName: "desktop-main.log",
        available: false,
        lines: [],
        coverage: expect.objectContaining({
          highWaterSizeBytes: null,
          sourceComplete: false,
          pageHasOlder: false,
        }),
      }),
    );
  });
});

describe("desktop diagnostic log reading", () => {
  it("redacts each returned line and strictly bounds its returned length", async () => {
    const logsDir = await makeLogsDir();
    await writeLog(
      logsDir,
      "server",
      [
        "[INFO] Authorization: Bearer bearer-secret visible=first",
        "[ERROR] callback=https://user:password@example.test/?api_key=query-secret visible=second",
        `[DEBUG] ${"x".repeat(DESKTOP_DIAGNOSTIC_MAX_LINE_CHARS + 1_000)} token=tail-secret`,
      ].join("\n"),
    );

    const page = await readDesktopDiagnosticLog({ logsDir, source: "server" });

    expect(page.available).toBe(true);
    expect(page.lines).toHaveLength(3);
    expect(page.lines.map((line) => line.level)).toEqual(["info", "error", "debug"]);
    expect(page.lines.map((line) => line.text).join("\n")).not.toMatch(
      /bearer-secret|password|query-secret|tail-secret/,
    );
    expect(page.lines[0]?.text).toContain("Authorization: [redacted]");
    expect(page.lines[1]?.text).toContain("https://[redacted]@example.test/");
    expect(page.lines[2]?.text.length).toBeLessThanOrEqual(DESKTOP_DIAGNOSTIC_MAX_LINE_CHARS);
  });

  it("paginates backward without overlap and keeps the initial high-water snapshot", async () => {
    const logsDir = await makeLogsDir();
    const filePath = await writeLog(
      logsDir,
      "backend",
      Array.from({ length: 7 }, (_, index) => `[INFO] line-${index + 1}`).join("\n") + "\n",
    );

    const first = await readDesktopDiagnosticLog({ logsDir, source: "backend", limit: 2 });
    await writeFile(filePath, "[INFO] line-8\n", { flag: "a" });
    const pages = [first];
    while (true) {
      const cursor = pages[pages.length - 1]?.nextCursor;
      if (cursor === undefined) break;
      pages.push(
        await readDesktopDiagnosticLog({
          logsDir,
          source: "backend",
          limit: 2,
          cursor,
        }),
      );
    }

    expect(first.lines.map((line) => line.text)).toEqual(["[INFO] line-6", "[INFO] line-7"]);
    expect(pages.flatMap((page) => page.lines.map((line) => line.text))).toEqual([
      "[INFO] line-6",
      "[INFO] line-7",
      "[INFO] line-4",
      "[INFO] line-5",
      "[INFO] line-2",
      "[INFO] line-3",
      "[INFO] line-1",
    ]);
    const offsets = pages.flatMap((page) => page.lines.map((line) => line.byteOffset));
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(
      pages.every((page) => page.coverage.highWaterSizeBytes === first.coverage.highWaterSizeBytes),
    ).toBe(true);
    expect(pages.at(-1)?.coverage).toEqual(
      expect.objectContaining({ pageHasOlder: false, sourceComplete: true }),
    );
  });

  it("normalizes level filters, applies contains after redaction, and binds filters to cursors", async () => {
    const logsDir = await makeLogsDir();
    await writeLog(
      logsDir,
      "desktop",
      [
        "[INFO] alpha request",
        "[ERROR] alpha failed token=secret-value",
        "level=warning beta retry",
        "[DEBUG] alpha trace",
        "[ERROR] alpha failed again",
      ].join("\n"),
    );

    const first = await readDesktopDiagnosticLog({
      logsDir,
      source: "desktop",
      levels: ["error", "ERROR"],
      contains: "ALPHA",
      limit: 1,
    });
    expect(first.lines.map((line) => line.text)).toEqual(["[ERROR] alpha failed again"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    if (first.nextCursor === undefined) throw new Error("expected a second filtered page");
    const second = await readDesktopDiagnosticLog({
      logsDir,
      source: "desktop",
      levels: ["ERROR"],
      contains: "alpha",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]?.text).toContain("[ERROR] alpha failed token=[redacted]");
    await expect(
      readDesktopDiagnosticLog({
        logsDir,
        source: "desktop",
        levels: ["warn"],
        contains: "alpha",
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor.*filters/i);
  });

  it("uses the default limit and caps larger requested pages at 200", async () => {
    const logsDir = await makeLogsDir();
    await writeLog(
      logsDir,
      "server",
      Array.from({ length: DESKTOP_DIAGNOSTIC_MAX_LIMIT + 5 }, (_, index) => `line-${index}`).join(
        "\n",
      ),
    );

    const defaultPage = await readDesktopDiagnosticLog({ logsDir, source: "server" });
    const cappedPage = await readDesktopDiagnosticLog({
      logsDir,
      source: "server",
      limit: 10_000,
    });

    expect(defaultPage.lines).toHaveLength(DESKTOP_DIAGNOSTIC_DEFAULT_LIMIT);
    expect(cappedPage.lines).toHaveLength(DESKTOP_DIAGNOSTIC_MAX_LIMIT);
    expect(cappedPage.coverage.pageHasOlder).toBe(true);
  });
});

describe("desktop diagnostic log safety boundaries", () => {
  it("rejects malformed cursors and detects replacement or truncation", async () => {
    const logsDir = await makeLogsDir();
    const filePath = await writeLog(logsDir, "server", "line-1\nline-2\nline-3\n");
    const first = await readDesktopDiagnosticLog({ logsDir, source: "server", limit: 1 });
    if (first.nextCursor === undefined) throw new Error("expected a second server page");

    await expect(
      readDesktopDiagnosticLog({ logsDir, source: "server", cursor: "%%%" }),
    ).rejects.toThrow(/cursor.*malformed/i);

    await rename(filePath, `${filePath}.1`);
    await writeLog(logsDir, "server", "replacement\n");
    await expect(
      readDesktopDiagnosticLog({ logsDir, source: "server", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "log-rotated" });

    const backendPath = await writeLog(logsDir, "backend", "one\ntwo\nthree\n");
    const backendFirst = await readDesktopDiagnosticLog({
      logsDir,
      source: "backend",
      limit: 1,
    });
    if (backendFirst.nextCursor === undefined) throw new Error("expected a second backend page");
    await truncate(backendPath, 1);
    await expect(
      readDesktopDiagnosticLog({
        logsDir,
        source: "backend",
        cursor: backendFirst.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "log-truncated" });
  });

  it("rejects symbolic links and non-regular files", async () => {
    const logsDir = await makeLogsDir();
    const target = path.join(logsDir, "target.log");
    await writeFile(target, "outside\n", { mode: 0o600 });
    // A Windows junction in the log-file slot must be rejected before any read.
    createRejectedFileAlias(target, path.join(logsDir, "server.log"));
    await mkdir(path.join(logsDir, "server-child.log"));

    const status = await getDesktopDiagnosticLogStatus({ logsDir });
    expect(status.find((entry) => entry.source === "server")?.available).toBe(false);
    await expect(readDesktopDiagnosticLog({ logsDir, source: "server" })).rejects.toMatchObject({
      code: "log-symlink",
    });
    await expect(readDesktopDiagnosticLog({ logsDir, source: "backend" })).rejects.toMatchObject({
      code: "log-not-regular",
    });
  });

  it("never scans past the cumulative byte cap and fails clearly on an oversized line", async () => {
    const logsDir = await makeLogsDir();
    await writeLog(logsDir, "desktop", "x".repeat(DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES + 1));

    await expect(readDesktopDiagnosticLog({ logsDir, source: "desktop" })).rejects.toMatchObject({
      code: "log-line-too-large",
    });

    await writeLog(
      logsDir,
      "server",
      `[ERROR] older match\n${"x".repeat(DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES + 128)}\n[INFO] newest`,
    );
    const page = await readDesktopDiagnosticLog({
      logsDir,
      source: "server",
      levels: ["error"],
    });
    expect(page.lines).toEqual([]);
    expect(page.coverage).toEqual(
      expect.objectContaining({
        scannedBytes: DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES,
        scanTruncated: true,
        pageHasOlder: true,
        sourceComplete: false,
      }),
    );
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});
