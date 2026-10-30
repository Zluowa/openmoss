// FILE: providerUsageSnapshot.test.ts
// Purpose: Regression coverage for HEL-19's bounded local usage archive reader.
// The fixtures are synthetic and prove byte/work/concurrency limits without touching user archives.
// Layer: Server provider usage tests

import { mkdir, mkdtemp, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "./config";
import {
  __getProviderUsageSnapshotTestState,
  __getCachedProviderUsageSnapshotForTests,
  __resetProviderUsageSnapshotStateForTests,
  __scanProviderUsageSnapshotForTests,
  getProviderUsageSnapshot,
  readClaudeUsageSamples,
  readCodexSessionSummary,
  type ProviderUsageArchiveScanLimits,
} from "./providerUsageSnapshot";
import { ServerSettingsService } from "./serverSettings";

const NOW_MS = Date.parse("2026-08-12T08:00:00.000Z");
const MIB = 1024 * 1024;

const TEST_LIMITS: ProviderUsageArchiveScanLimits = {
  maxDirectoryEntries: 256,
  maxCandidateFiles: 128,
  maxFiles: 128,
  maxBytesPerFile: 64 * 1024,
  maxTotalBytes: 512 * 1024,
  maxRecords: 10_000,
  maxElapsedMs: 5_000,
  yieldEveryRecords: 32,
  concurrency: 2,
  readChunkBytes: 257,
};

const temporaryRoots: string[] = [];
let previousClaudeConfigDir: string | undefined;

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "moss-hel19-"));
  temporaryRoots.push(root);
  return root;
}

async function linkDirectory(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await fs.realpath(link)).toBe(await fs.realpath(target));
}

async function makeCodexHome(
  dayTimestampMs = NOW_MS,
): Promise<{ root: string; codexHome: string; dayDir: string }> {
  const root = await makeTemporaryRoot();
  const codexHome = path.join(root, ".codex-test");
  const day = new Date(dayTimestampMs);
  const dayPath = [
    `${day.getFullYear()}`,
    `${String(day.getMonth() + 1).padStart(2, "0")}`,
    `${String(day.getDate()).padStart(2, "0")}`,
  ];
  const dayDir = path.join(codexHome, "sessions", ...dayPath);
  await mkdir(dayDir, { recursive: true });
  return { root, codexHome, dayDir };
}

function tokenCountLine(input: {
  timestamp?: string;
  totalTokens: number;
  paddingBytes?: number;
}): string {
  return JSON.stringify({
    timestamp: input.timestamp ?? new Date(NOW_MS - 60_000).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: input.totalTokens,
        },
      },
      rate_limits: {
        primary: {
          used_percent: 25,
          window_minutes: 300,
        },
      },
      padding: "x".repeat(input.paddingBytes ?? 0),
    },
  });
}

function claudeUsageLine(input: {
  totalTokens: number;
  suffix: string;
  timestamp?: string;
}): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp ?? new Date(NOW_MS - 1_000).toISOString(),
    sessionId: `session-${input.suffix}`,
    requestId: `request-${input.suffix}`,
    message: { usage: { total_tokens: input.totalTokens } },
  })}\n`;
}

async function writeCodexSession(input: {
  dayDir: string;
  name: string;
  contents: string | Uint8Array;
  mtimeOffsetMs?: number;
  mtimeMs?: number;
}): Promise<string> {
  const filePath = path.join(input.dayDir, `${input.name}.jsonl`);
  await writeFile(filePath, input.contents);
  const timestamp = new Date(input.mtimeMs ?? NOW_MS + (input.mtimeOffsetMs ?? 0));
  await utimes(filePath, timestamp, timestamp);
  return filePath;
}

beforeEach(() => {
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  __resetProviderUsageSnapshotStateForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("HEL-19 bounded provider usage archive scanning", () => {
  it("keeps Devin local usage archive scanning disabled until a provider-owned source exists", async () => {
    const root = await makeTemporaryRoot();
    const result = await __scanProviderUsageSnapshotForTests({
      provider: "devin",
      homeDir: root,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });

    expect(result.snapshot).toBeNull();
    expect(result.diagnostics.filesOpened).toBe(0);
  });

  it("finds the newest Codex token_count across read-chunk boundaries without whole-reading a large JSONL", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    const event = `${tokenCountLine({ totalTokens: 321, paddingBytes: 2_048 })}\n`;
    const fixture = Buffer.concat([Buffer.alloc(8 * MIB, 0x78), Buffer.from(`\n${event}`)]);
    const filePath = await writeCodexSession({
      dayDir,
      name: "large-session",
      contents: fixture,
    });
    const fileSize = (await stat(filePath)).size;
    const limits = {
      ...TEST_LIMITS,
      maxBytesPerFile: 64 * 1024,
      maxTotalBytes: 64 * 1024,
      readChunkBytes: 257,
    };

    const startedAt = performance.now();
    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.snapshot?.usageLines[0]).toMatchObject({ label: "24h", value: "321 tokens" });
    expect(result.snapshot?.archiveScan?.complete).toBe(true);
    expect(result.diagnostics.bytesRead).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(result.diagnostics.bytesRead).toBeLessThan(fileSize / 100);
    expect(result.diagnostics.maxBytesReadForSingleFile).toBeLessThanOrEqual(
      limits.maxBytesPerFile,
    );
    expect(result.diagnostics.maxSingleReadBytes).toBeLessThanOrEqual(limits.readChunkBytes);
    expect(result.diagnostics.readOperations).toBeGreaterThan(1);

    console.info(
      "HEL-19 synthetic large-archive benchmark",
      JSON.stringify({
        fixtureBytes: fileSize,
        bytesRead: result.diagnostics.bytesRead,
        readOperations: result.diagnostics.readOperations,
        recordsInspected: result.diagnostics.recordsInspected,
        elapsedMs: Number(elapsedMs.toFixed(1)),
      }),
    );
  });

  it("enforces aggregate and per-file byte budgets plus bounded file-read concurrency", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    const sessionPaths = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        writeCodexSession({
          dayDir,
          name: `bounded-${index}`,
          contents: `${"x".repeat(128 * 1024)}\n${tokenCountLine({ totalTokens: index + 1 })}\n`,
          mtimeOffsetMs: index,
        }),
      ),
    );
    const limits = {
      ...TEST_LIMITS,
      maxBytesPerFile: 4 * 1024,
      maxTotalBytes: 18 * 1024,
      concurrency: 2,
      readChunkBytes: 257,
    };

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits,
    });

    expect(result.snapshot?.archiveScan?.complete).toBe(true);
    expect(result.diagnostics.bytesRead).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(result.diagnostics.peakFileReadConcurrency).toBeLessThanOrEqual(limits.concurrency);
    expect(result.diagnostics.filesOpened).toBe(sessionPaths.length);
    expect(result.diagnostics.maxBytesReadForSingleFile).toBeLessThanOrEqual(
      limits.maxBytesPerFile,
    );
    expect(Object.values(result.diagnostics.bytesReadByFile)).toHaveLength(sessionPaths.length);
    expect(
      Object.values(result.diagnostics.bytesReadByFile).every(
        (bytesRead) => bytesRead <= limits.maxBytesPerFile,
      ),
    ).toBe(true);

    console.info(
      "HEL-19 synthetic aggregate-budget benchmark",
      JSON.stringify({
        files: sessionPaths.length,
        aggregateByteBudget: limits.maxTotalBytes,
        bytesRead: result.diagnostics.bytesRead,
        maxBytesReadForSingleFile: result.diagnostics.maxBytesReadForSingleFile,
        peakFileReadConcurrency: result.diagnostics.peakFileReadConcurrency,
      }),
    );
  });

  it("stops JSON parsing at the explicit aggregate record-work budget", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    const trailingRecords = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({ type: "event_msg", payload: { type: `ignored-${index}` } }),
    );
    await writeCodexSession({
      dayDir,
      name: "record-budget",
      contents: [tokenCountLine({ totalTokens: 999 }), ...trailingRecords, ""].join("\n"),
    });
    const limits = { ...TEST_LIMITS, maxRecords: 3 };

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits,
    });

    expect(result.diagnostics.recordsInspected).toBe(limits.maxRecords);
    expect(result.snapshot?.archiveScan?.complete).toBe(false);
    expect(result.snapshot?.usageLines).toEqual([]);
    expect(result.snapshot?.detail).toMatch(/partial|bounded|budget/iu);
  });

  it("cooperatively yields during parse-heavy tails instead of monopolizing the event loop", async () => {
    const NativeNumberFormat = Intl.NumberFormat;
    vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locales, options) {
      return new NativeNumberFormat(locales ?? "en-US", options);
    });
    const { root, codexHome, dayDir } = await makeCodexHome();
    const ignoredRecords = Array.from({ length: 320 }, (_, index) =>
      JSON.stringify({ type: "event_msg", payload: { type: `ignored-${index}` } }),
    );
    await writeCodexSession({
      dayDir,
      name: "cooperative-yield",
      contents: [tokenCountLine({ totalTokens: 1_234 }), ...ignoredRecords, ""].join("\n"),
    });
    const limits = { ...TEST_LIMITS, yieldEveryRecords: 16 };
    let heartbeatObserved = false;
    setImmediate(() => {
      heartbeatObserved = true;
    });

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits,
    });

    expect(result.snapshot?.usageLines[0]?.value).toBe("1.2K tokens");
    expect(result.diagnostics.recordsInspected).toBe(ignoredRecords.length + 1);
    expect(result.diagnostics.cooperativeYields).toBeGreaterThanOrEqual(10);
    expect(heartbeatObserved).toBe(true);
  });

  it("fails closed as incomplete when the explicit monotonic deadline is exhausted", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "deadline",
      contents: `${tokenCountLine({ totalTokens: 50 })}\n`,
    });

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits: { ...TEST_LIMITS, maxElapsedMs: 0 },
    });

    expect(result.diagnostics.deadlineExceeded).toBe(true);
    expect(result.diagnostics.bytesRead).toBe(0);
    expect(result.diagnostics.recordsInspected).toBe(0);
    expect(result.snapshot?.archiveScan?.complete).toBe(false);
    expect(result.snapshot?.detail).toMatch(/lower bounds|bounded/iu);
  });

  it("bounds directory enumeration work and reports discovery truncation as incomplete", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        writeCodexSession({
          dayDir,
          name: `entry-${index}`,
          contents: `${tokenCountLine({ totalTokens: 10 })}\n`,
        }),
      ),
    );
    const limits = { ...TEST_LIMITS, maxDirectoryEntries: 3 };

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits,
    });

    expect(result.diagnostics.directoryEntriesInspected).toBeLessThanOrEqual(
      limits.maxDirectoryEntries,
    );
    expect(result.snapshot?.archiveScan?.complete).toBe(false);
    expect(result.snapshot?.archiveScan?.filesDiscovered).toBeLessThanOrEqual(3);
    expect(result.snapshot?.detail).toContain("could not inspect every eligible archive entry");
    expect(result.snapshot?.detail).toContain("lower bounds");
    expect(result.snapshot?.detail).not.toContain("byte or work budget");
  });

  it.skipIf(process.platform === "win32")(
    "fails closed without opening a symlinked JSONL candidate",
    async () => {
      const { root, codexHome, dayDir } = await makeCodexHome();
      const outsidePath = path.join(root, "outside.jsonl");
      await writeFile(outsidePath, `${tokenCountLine({ totalTokens: 9_999 })}\n`);
      await symlink(outsidePath, path.join(dayDir, "linked-session.jsonl"));

      const result = await __scanProviderUsageSnapshotForTests({
        provider: "codex",
        homeDir: root,
        homePath: codexHome,
        nowMs: NOW_MS,
        limits: TEST_LIMITS,
      });

      expect(result.snapshot).toBeNull();
      expect(result.diagnostics.filesOpened).toBe(0);
      expect(result.diagnostics.bytesRead).toBe(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed without opening a JSONL-named native directory junction",
    async () => {
      const { root, codexHome, dayDir } = await makeCodexHome();
      const outsideDirectory = path.join(root, "outside-jsonl-target");
      await mkdir(outsideDirectory);
      await writeFile(
        path.join(outsideDirectory, "outside.jsonl"),
        `${tokenCountLine({ totalTokens: 9_999 })}\n`,
      );
      await linkDirectory(outsideDirectory, path.join(dayDir, "linked-session.jsonl"));
      const result = await __scanProviderUsageSnapshotForTests({
        provider: "codex",
        homeDir: root,
        homePath: codexHome,
        nowMs: NOW_MS,
        limits: TEST_LIMITS,
      });
      expect(result.snapshot).toBeNull();
      expect(result.diagnostics.filesOpened).toBe(0);
      expect(result.diagnostics.bytesRead).toBe(0);
    },
  );

  it.each(["year", "month", "day"] as const)(
    "fails closed when a Codex %s directory symlinks outside the approved archive root",
    async (level) => {
      const { root, codexHome } = await makeCodexHome();
      const outsideRoot = path.join(root, `outside-codex-${level}`);
      const outsideDayDir =
        level === "year"
          ? path.join(outsideRoot, "08", "12")
          : level === "month"
            ? path.join(outsideRoot, "12")
            : outsideRoot;
      await mkdir(outsideDayDir, { recursive: true });
      await writeCodexSession({
        dayDir: outsideDayDir,
        name: "outside-session",
        contents: `${tokenCountLine({ totalTokens: 777 })}\n`,
      });
      const sessionsRoot = path.join(codexHome, "sessions");
      const linkPath =
        level === "year"
          ? path.join(sessionsRoot, "2026")
          : level === "month"
            ? path.join(sessionsRoot, "2026", "08")
            : path.join(sessionsRoot, "2026", "08", "12");
      await rm(linkPath, { recursive: true });
      await linkDirectory(outsideRoot, linkPath);

      const result = await __scanProviderUsageSnapshotForTests({
        provider: "codex",
        homeDir: root,
        homePath: codexHome,
        nowMs: NOW_MS,
        limits: TEST_LIMITS,
      });

      expect(result.snapshot?.usageLines ?? []).not.toContainEqual(
        expect.objectContaining({ value: expect.stringContaining("777") }),
      );
      expect(result.diagnostics.filesOpened).toBe(0);
      expect(result.diagnostics.bytesRead).toBe(0);
      expect(JSON.stringify(result.diagnostics)).not.toContain(`outside-codex-${level}`);
    },
  );

  it("fails closed when a Claude project directory symlinks outside the approved archive root", async () => {
    const root = await makeTemporaryRoot();
    const projectsRoot = path.join(root, ".claude", "projects");
    const outsideProjectDir = path.join(root, "outside-claude-project");
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(outsideProjectDir, { recursive: true });
    await writeFile(
      path.join(outsideProjectDir, "outside.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        timestamp: new Date(NOW_MS - 1_000).toISOString(),
        sessionId: "outside-session",
        requestId: "outside-request",
        message: { usage: { total_tokens: 888 } },
      })}\n`,
    );
    await linkDirectory(outsideProjectDir, path.join(projectsRoot, "linked-project"));

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "claudeAgent",
      homeDir: root,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });

    expect(result.snapshot?.usageLines ?? []).not.toContainEqual(
      expect.objectContaining({ value: expect.stringContaining("888") }),
    );
    expect(result.diagnostics.filesOpened).toBe(0);
    expect(result.diagnostics.bytesRead).toBe(0);
    expect(JSON.stringify(result.diagnostics)).not.toContain("outside-claude-project");
  });

  it("uses the server-owned Codex home instead of a client-requested archive path", async () => {
    const currentNowMs = Date.now();
    const currentTimestamp = new Date(currentNowMs - 60_000).toISOString();
    const configured = await makeCodexHome(currentNowMs);
    const untrusted = await makeCodexHome(currentNowMs);
    await writeCodexSession({
      dayDir: configured.dayDir,
      name: "configured",
      contents: `${tokenCountLine({ timestamp: currentTimestamp, totalTokens: 123 })}\n`,
      mtimeMs: currentNowMs,
    });
    await writeCodexSession({
      dayDir: untrusted.dayDir,
      name: "untrusted",
      contents: `${tokenCountLine({ timestamp: currentTimestamp, totalTokens: 9_999 })}\n`,
      mtimeMs: currentNowMs,
    });

    const result = await getProviderUsageSnapshot({
      provider: "codex",
      homePath: untrusted.codexHome,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(configured.root, { prefix: "moss-hel19-config-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          ServerSettingsService.layerTest({
            providers: { codex: { homePath: configured.codexHome } },
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(result?.usageLines[0]?.value).toBe("123 tokens");
    expect(result?.usageLines[0]?.value).not.toContain("10K");
  });

  it("uses the server-owned Claude home instead of the default or a client-requested path", async () => {
    const currentTimestamp = new Date(Date.now() - 1_000).toISOString();
    const serverHome = await makeTemporaryRoot();
    const configuredClaudeHome = path.join(serverHome, "configured-claude-home");
    const untrustedClaudeHome = path.join(serverHome, "untrusted-claude-home");
    const defaultProject = path.join(serverHome, ".claude", "projects", "default-project");
    const configuredProject = path.join(
      configuredClaudeHome,
      ".claude",
      "projects",
      "configured-project",
    );
    const untrustedProject = path.join(
      untrustedClaudeHome,
      ".claude",
      "projects",
      "untrusted-project",
    );
    await Promise.all([
      mkdir(defaultProject, { recursive: true }),
      mkdir(configuredProject, { recursive: true }),
      mkdir(untrustedProject, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(defaultProject, "default.jsonl"),
        claudeUsageLine({ totalTokens: 123, suffix: "default", timestamp: currentTimestamp }),
      ),
      writeFile(
        path.join(configuredProject, "configured.jsonl"),
        claudeUsageLine({ totalTokens: 456, suffix: "configured", timestamp: currentTimestamp }),
      ),
      writeFile(
        path.join(untrustedProject, "untrusted.jsonl"),
        claudeUsageLine({ totalTokens: 9_999, suffix: "untrusted", timestamp: currentTimestamp }),
      ),
    ]);

    const result = await getProviderUsageSnapshot({
      provider: "claudeAgent",
      homePath: untrustedClaudeHome,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(serverHome, { prefix: "moss-hel19-claude-config-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          ServerSettingsService.layerTest({
            providers: { claudeAgent: { homePath: configuredClaudeHome } },
          }),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(result?.usageLines[0]?.value).toBe("456 tokens");
    expect(result?.usageLines[0]?.value).not.toBe("123 tokens");
    expect(result?.usageLines[0]?.value).not.toContain("10K");
  });

  it("allows the configured archive root itself to be a symlink by canonicalizing it once", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "canonical-root",
      contents: `${tokenCountLine({ totalTokens: 456 })}\n`,
    });
    const configuredRootLink = path.join(root, "configured-codex-home");
    await linkDirectory(codexHome, configuredRootLink);

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: configuredRootLink,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });

    expect(result.snapshot?.usageLines[0]?.value).toBe("456 tokens");
    expect(result.snapshot?.archiveScan?.complete).toBe(true);
  });

  it("fails closed on a missing approved root without enumerating its parent", async () => {
    const root = await makeTemporaryRoot();
    const missingRoot = path.join(root, "missing-codex-home");

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: missingRoot,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });

    expect(result.snapshot).toBeNull();
    expect(result.diagnostics.directoryEntriesInspected).toBe(0);
    expect(result.diagnostics.filesOpened).toBe(0);
    expect(result.diagnostics.bytesRead).toBe(0);
  });

  it("marks totals as lower bounds when any selected Codex file remains unresolved", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "resolved",
      contents: `${"x".repeat(32 * 1024)}\n${tokenCountLine({ totalTokens: 42 })}\n`,
      mtimeOffsetMs: 2,
    });
    await writeCodexSession({
      dayDir,
      name: "unresolved",
      contents: `${tokenCountLine({ totalTokens: 500 })}\n${"x".repeat(32 * 1024)}\n`,
      mtimeOffsetMs: 1,
    });
    const limits = {
      ...TEST_LIMITS,
      maxBytesPerFile: 2 * 1024,
      maxTotalBytes: 4 * 1024,
    };

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits,
    });

    expect(result.snapshot?.archiveScan?.complete).toBe(false);
    expect(result.snapshot?.usageLines[0]?.value).toBe("≥42 tokens");
    expect(result.snapshot?.usageLines[0]?.subtitle).toMatch(/^≥1 recent session found$/u);
    expect(result.snapshot?.detail).toMatch(/lower bounds/iu);
  });

  it("treats bounded Claude transcript tails as partial instead of exact totals", async () => {
    const root = await makeTemporaryRoot();
    const projectDir = path.join(root, ".claude", "projects", "synthetic-project");
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, "transcript.jsonl");
    const assistantRecord = JSON.stringify({
      type: "assistant",
      timestamp: new Date(NOW_MS - 1_000).toISOString(),
      sessionId: "synthetic-session",
      requestId: "synthetic-request",
      message: {
        model: "claude-test",
        usage: { input_tokens: 20, output_tokens: 30 },
      },
    });
    await writeFile(transcriptPath, `${"x".repeat(2 * MIB)}\n${assistantRecord}\n`);
    const timestamp = new Date(NOW_MS);
    await utimes(transcriptPath, timestamp, timestamp);
    const limits = {
      ...TEST_LIMITS,
      maxBytesPerFile: 32 * 1024,
      maxTotalBytes: 32 * 1024,
    };

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "claudeAgent",
      homeDir: root,
      nowMs: NOW_MS,
      limits,
    });

    expect(result.diagnostics.bytesRead).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(result.snapshot?.archiveScan?.complete).toBe(false);
    expect(result.snapshot?.usageLines[0]?.value).toBe("≥50 tokens");
    expect(result.snapshot?.detail).toMatch(/lower bounds/iu);
  });

  it("reads the default Claude archive under the server home when no custom home is set", async () => {
    const root = await makeTemporaryRoot();
    const projectDir = path.join(root, ".claude", "projects", "default-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "default.jsonl"),
      claudeUsageLine({ totalTokens: 321, suffix: "default-home" }),
    );

    const result = await __scanProviderUsageSnapshotForTests({
      provider: "claudeAgent",
      homeDir: root,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });

    expect(result.snapshot?.usageLines[0]?.value).toBe("321 tokens");
    expect(result.snapshot?.archiveScan?.complete).toBe(true);
  });

  it("coalesces concurrent cached callers into one archive scan", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "single-flight",
      contents: `${"x".repeat(2 * MIB)}\n${tokenCountLine({ totalTokens: 77 })}\n`,
    });

    const snapshots = await Promise.all(
      Array.from({ length: 8 }, () =>
        __getCachedProviderUsageSnapshotForTests({
          provider: "codex",
          homeDir: root,
          homePath: codexHome,
          nowMs: NOW_MS,
        }),
      ),
    );

    expect(snapshots.every((snapshot) => snapshot?.usageLines[0]?.value === "77 tokens")).toBe(
      true,
    );
    expect(__getProviderUsageSnapshotTestState().scanRuns).toBe(1);
  });

  it("keeps the local archive cache hot across a 60-second live batch poll", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "batch-cache",
      contents: `${tokenCountLine({ totalTokens: 91 })}\n`,
    });

    const first = await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
    });
    const afterBatchPoll = await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS + 60_000,
    });

    expect(afterBatchPoll).toEqual(first);
    expect(__getProviderUsageSnapshotTestState().scanRuns).toBe(1);
  });

  it("invalidates cache and single-flight identity when a configured-root symlink retargets", async () => {
    const firstHome = await makeCodexHome();
    const secondHome = await makeCodexHome();
    await writeCodexSession({
      dayDir: firstHome.dayDir,
      name: "first-target",
      contents: `${tokenCountLine({ totalTokens: 111 })}\n`,
    });
    await writeCodexSession({
      dayDir: secondHome.dayDir,
      name: "second-target",
      contents: `${tokenCountLine({ totalTokens: 222 })}\n`,
    });
    const configuredRootLink = path.join(firstHome.root, "selected-codex-home");
    await linkDirectory(firstHome.codexHome, configuredRootLink);

    const first = await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: firstHome.root,
      homePath: configuredRootLink,
      nowMs: NOW_MS,
    });
    await unlink(configuredRootLink);
    await linkDirectory(secondHome.codexHome, configuredRootLink);
    const second = await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: firstHome.root,
      homePath: configuredRootLink,
      nowMs: NOW_MS + 60_000,
    });

    expect(first?.usageLines[0]?.value).toBe("111 tokens");
    expect(second?.usageLines[0]?.value).toBe("222 tokens");
    expect(__getProviderUsageSnapshotTestState().scanRuns).toBe(2);
  });

  it("pins the approved root used by an in-flight scan to the identity owning its cache entry", async () => {
    const firstHome = await makeCodexHome();
    const secondHome = await makeCodexHome();
    await writeCodexSession({
      dayDir: firstHome.dayDir,
      name: "first-in-flight-target",
      contents: `${tokenCountLine({ totalTokens: 111 })}\n`,
    });
    await writeCodexSession({
      dayDir: secondHome.dayDir,
      name: "second-in-flight-target",
      contents: `${tokenCountLine({ totalTokens: 222 })}\n`,
    });
    const configuredRootLink = path.join(firstHome.root, "in-flight-codex-home");
    await linkDirectory(firstHome.codexHome, configuredRootLink);

    let signalIdentityResolved!: () => void;
    const identityResolved = new Promise<void>((resolve) => {
      signalIdentityResolved = resolve;
    });
    let releaseFirstScan!: () => void;
    const firstScanMayStart = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    const firstPending = __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: firstHome.root,
      homePath: configuredRootLink,
      nowMs: NOW_MS,
      afterArchiveRootResolvedForTests: async () => {
        signalIdentityResolved();
        await firstScanMayStart;
      },
    });

    await identityResolved;
    await unlink(configuredRootLink);
    await linkDirectory(secondHome.codexHome, configuredRootLink);
    let signalSecondIdentityResolved!: () => void;
    const secondIdentityResolved = new Promise<void>((resolve) => {
      signalSecondIdentityResolved = resolve;
    });
    const secondPending = __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: firstHome.root,
      homePath: configuredRootLink,
      nowMs: NOW_MS + 60_000,
      afterArchiveRootResolvedForTests: signalSecondIdentityResolved,
    });
    await secondIdentityResolved;
    releaseFirstScan();

    const [first, second] = await Promise.all([firstPending, secondPending]);
    await unlink(configuredRootLink);
    await linkDirectory(firstHome.codexHome, configuredRootLink);
    const cachedFirst = await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: firstHome.root,
      homePath: configuredRootLink,
      nowMs: NOW_MS + 120_000,
    });

    expect(first?.usageLines[0]?.value).toBe("111 tokens");
    expect(second?.usageLines[0]?.value).toBe("222 tokens");
    expect(cachedFirst?.usageLines[0]?.value).toBe("111 tokens");
    expect(__getProviderUsageSnapshotTestState().scanRuns).toBe(2);
  });

  it("pins an in-flight configured Claude home to the identity owning its cache entry", async () => {
    const homeRoot = await makeTemporaryRoot();
    const firstClaudeHome = path.join(homeRoot, "first-claude-home");
    const secondClaudeHome = path.join(homeRoot, "second-claude-home");
    const firstProjects = path.join(firstClaudeHome, ".claude", "projects");
    const secondProjects = path.join(secondClaudeHome, ".claude", "projects");
    const firstProject = path.join(firstProjects, "project-a");
    const secondProject = path.join(secondProjects, "project-b");
    await mkdir(firstProject, { recursive: true });
    await mkdir(secondProject, { recursive: true });
    await writeFile(
      path.join(firstProject, "first.jsonl"),
      claudeUsageLine({ totalTokens: 111, suffix: "first" }),
    );
    await writeFile(
      path.join(secondProject, "second.jsonl"),
      claudeUsageLine({ totalTokens: 222, suffix: "second" }),
    );
    const configuredHomeLink = path.join(homeRoot, "configured-claude-home");
    await linkDirectory(firstClaudeHome, configuredHomeLink);

    let signalIdentityResolved!: () => void;
    const identityResolved = new Promise<void>((resolve) => {
      signalIdentityResolved = resolve;
    });
    let releaseFirstScan!: () => void;
    const firstScanMayStart = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    const firstPending = __getCachedProviderUsageSnapshotForTests({
      provider: "claudeAgent",
      homeDir: homeRoot,
      homePath: configuredHomeLink,
      nowMs: NOW_MS,
      afterArchiveRootResolvedForTests: async () => {
        signalIdentityResolved();
        await firstScanMayStart;
      },
    });

    await identityResolved;
    await unlink(configuredHomeLink);
    await linkDirectory(secondClaudeHome, configuredHomeLink);
    let signalSecondIdentityResolved!: () => void;
    const secondIdentityResolved = new Promise<void>((resolve) => {
      signalSecondIdentityResolved = resolve;
    });
    const secondPending = __getCachedProviderUsageSnapshotForTests({
      provider: "claudeAgent",
      homeDir: homeRoot,
      homePath: configuredHomeLink,
      nowMs: NOW_MS + 60_000,
      afterArchiveRootResolvedForTests: signalSecondIdentityResolved,
    });
    await secondIdentityResolved;
    releaseFirstScan();

    const [first, second] = await Promise.all([firstPending, secondPending]);
    await unlink(configuredHomeLink);
    await linkDirectory(firstClaudeHome, configuredHomeLink);
    const cachedFirst = await __getCachedProviderUsageSnapshotForTests({
      provider: "claudeAgent",
      homeDir: homeRoot,
      homePath: configuredHomeLink,
      nowMs: NOW_MS + 120_000,
    });

    expect(first?.usageLines[0]?.value).toBe("111 tokens");
    expect(second?.usageLines[0]?.value).toBe("222 tokens");
    expect(cachedFirst?.usageLines[0]?.value).toBe("111 tokens");
    expect(__getProviderUsageSnapshotTestState().scanRuns).toBe(2);
  });

  it("lets an explicit refresh bypass the local archive TTL", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "manual-refresh",
      contents: `${tokenCountLine({ totalTokens: 92 })}\n`,
    });

    await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
    });
    await __getCachedProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS + 60_000,
      forceRefresh: true,
    });

    expect(__getProviderUsageSnapshotTestState().scanRuns).toBe(2);
  });

  it("reuses an unchanged per-file summary index on a later uncached scan", async () => {
    const { root, codexHome, dayDir } = await makeCodexHome();
    await writeCodexSession({
      dayDir,
      name: "indexed",
      contents: `${"x".repeat(2 * MIB)}\n${tokenCountLine({ totalTokens: 88 })}\n`,
    });

    const first = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });
    const second = await __scanProviderUsageSnapshotForTests({
      provider: "codex",
      homeDir: root,
      homePath: codexHome,
      nowMs: NOW_MS,
      limits: TEST_LIMITS,
    });

    expect(first.diagnostics.bytesRead).toBeGreaterThan(0);
    expect(second.snapshot?.provider).toBe(first.snapshot?.provider);
    expect(second.snapshot?.updatedAt).toBe(first.snapshot?.updatedAt);
    expect(second.snapshot?.usageLines).toEqual(first.snapshot?.usageLines);
    expect(second.snapshot?.archiveScan).toMatchObject({
      complete: true,
      bytesRead: 0,
      recordsInspected: 0,
    });
    expect(second.diagnostics.bytesRead).toBe(0);
    expect(second.diagnostics.fileIndexHits).toBe(1);
  });

  it("reads the latest token count from the bounded exported tail reader", async () => {
    const root = await makeTemporaryRoot();
    const filePath = path.join(root, "rollout.jsonl");
    const tokenLine = JSON.stringify({
      timestamp: "2026-08-14T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 250 } },
        rate_limits: { primary: { used_percent: 25, window_minutes: 300 } },
      },
    });
    await writeFile(filePath, `${tokenLine}\nnot-json`);
    await expect(readCodexSessionSummary(filePath)).resolves.toMatchObject({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
      limits: [{ window: "5h", usedPercent: 25, windowDurationMins: 300 }],
    });
  });
});

function assistantLine(input: {
  timestamp: string;
  totalTokens: number;
  sessionId?: string;
  messageId?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    message: {
      ...(input.messageId ? { id: input.messageId } : {}),
      model: "claude-opus-4-5",
      usage: { input_tokens: input.totalTokens, output_tokens: 0 },
    },
  });
}

async function makeSessionFile(contents: string, name = "rollout.jsonl"): Promise<string> {
  const directory = await makeTemporaryRoot();
  const file = path.join(directory, name);
  await writeFile(file, contents);
  return file;
}

describe("readClaudeUsageSamples", () => {
  it("reads samples from the transcript stream without readFile", async () => {
    // A record carrying no session or message id falls back to its line number, so the
    // blank line has to keep its place in the count for that key to stay stable.
    const file = await makeSessionFile(
      [
        JSON.stringify({ type: "user", timestamp: "2026-08-14T09:00:00.000Z" }),
        "",
        assistantLine({ timestamp: "2026-08-14T10:00:00.000Z", totalTokens: 40 }),
        assistantLine({
          timestamp: "2026-08-14T11:00:00.000Z",
          totalTokens: 60,
          sessionId: "session-a",
          messageId: "message-a",
        }),
        "not-json",
      ].join("\n"),
      "transcript.jsonl",
    );
    const readFile = vi.spyOn(fs, "readFile");

    await expect(readClaudeUsageSamples(file)).resolves.toEqual([
      {
        sessionId: `${file}:2`,
        timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
        totalTokens: 40,
        model: "claude-opus-4-5",
      },
      {
        sessionId: "session-a",
        timestampMs: Date.parse("2026-08-14T11:00:00.000Z"),
        totalTokens: 60,
        model: "claude-opus-4-5",
      },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("returns no samples for a missing transcript", async () => {
    const file = await makeSessionFile("", "transcript.jsonl");

    await expect(readClaudeUsageSamples(`${file}.absent`)).resolves.toEqual([]);
  });

  it("skips an oversized record and resumes at the next line", async () => {
    const oversizedAssistantLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-14T10:30:00.000Z",
      message: {
        model: "claude-opus-4-5",
        content: "x".repeat(2 * 1024 * 1024),
        usage: { input_tokens: 50, output_tokens: 0 },
      },
    });
    const file = await makeSessionFile(
      [
        assistantLine({ timestamp: "2026-08-14T10:00:00.000Z", totalTokens: 40 }),
        oversizedAssistantLine,
        assistantLine({ timestamp: "2026-08-14T11:00:00.000Z", totalTokens: 60 }),
      ].join("\n"),
      "transcript.jsonl",
    );

    await expect(readClaudeUsageSamples(file)).resolves.toEqual([
      {
        sessionId: `${file}:0`,
        timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
        totalTokens: 40,
        model: "claude-opus-4-5",
      },
      {
        sessionId: `${file}:2`,
        timestampMs: Date.parse("2026-08-14T11:00:00.000Z"),
        totalTokens: 60,
        model: "claude-opus-4-5",
      },
    ]);
  });
});
