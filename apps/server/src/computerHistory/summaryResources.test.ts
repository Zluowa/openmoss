import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPUTER_HISTORY_TEN_MINUTE_MS, projectComputerHistory } from "./summaryProjection.ts";
import {
  COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY,
  isComputerHistorySummaryJobResourceFilename,
  syncComputerHistorySummaryJobResources,
  syncComputerHistorySummaryResources,
} from "./summaryResources.ts";

describe("Computer History summary resources", () => {
  it("writes bounded redacted YAML-flow frontmatter with private permissions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-resources-"));
    const projection = projectComputerHistory(
      [
        {
          seq: 1,
          observation: {
            capturedAtMs: 1_000,
            app: { bundleIdentifier: "com.example.editor", name: "Editor" },
            window: { title: "Deployment summary" },
            activityText: "Deploy api_key=sk-test-secret-value token=private-token-value",
          },
        },
      ],
      { nowMs: 100_000 },
    );
    const paths = await syncComputerHistorySummaryResources(rootDir, projection.resources);
    const path = paths.values().next().value as string;
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("---\n{");
    expect(contents).toContain("com.example.editor");
    expect(contents).not.toContain("sk-test-secret-value");
    expect(contents).not.toContain("private-token-value");
    expect(contents).not.toContain("api_key");
    expect(contents).not.toContain("raw event payload");
    const directoryStat = await stat(join(rootDir, COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY));
    const fileStat = await stat(path);
    expect(directoryStat.isDirectory()).toBe(true);
    expect(fileStat.isFile()).toBe(true);
    // These bits describe POSIX permissions; Windows ACL privacy is a separate gate.
    if (process.platform !== "win32") {
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it("removes only stale generated resources and preserves unrelated files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-resource-cleanup-"));
    const resourcesDir = join(rootDir, COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY);
    const unrelated = join(resourcesDir, "keep-me.txt");
    await mkdir(resourcesDir, { recursive: true, mode: 0o700 });
    await writeFile(unrelated, "keep", { mode: 0o600 });
    const first = projectComputerHistory(
      [
        {
          seq: 1,
          observation: {
            capturedAtMs: 1_000,
            app: { bundleIdentifier: "com.example.editor", name: "Editor" },
            window: {},
          },
        },
      ],
      { nowMs: 100_000 },
    );
    await syncComputerHistorySummaryResources(rootDir, first.resources);
    await syncComputerHistorySummaryResources(rootDir, []);
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    expect(
      (await readdir(resourcesDir)).filter((name) => name.endsWith("memory-summary.md")),
    ).toEqual([]);
  });

  it("keeps unchanged resource inodes and rewrites only changed generated resources", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-resource-idempotence-"));
    const makeProjection = (firstTitle: string) =>
      projectComputerHistory(
        [
          {
            seq: 1,
            observation: {
              capturedAtMs: 1_000,
              app: { bundleIdentifier: "com.example.first", name: "First" },
              window: { title: firstTitle },
            },
          },
          {
            seq: 2,
            observation: {
              capturedAtMs: COMPUTER_HISTORY_TEN_MINUTE_MS + 1,
              app: { bundleIdentifier: "com.example.second", name: "Second" },
              window: { title: "Stable title" },
            },
          },
        ],
        { nowMs: 1_000_000 },
      );
    const firstProjection = makeProjection("Initial title");
    const firstPaths = await syncComputerHistorySummaryResources(
      rootDir,
      firstProjection.resources,
    );
    const firstResource = firstProjection.resources.find(
      (resource) => resource.title === "Initial title",
    );
    const stableResource = firstProjection.resources.find(
      (resource) => resource.title === "Stable title",
    );
    expect(firstResource).toBeDefined();
    expect(stableResource).toBeDefined();
    const firstPath = firstPaths.get(firstResource!.entryId);
    const stablePath = firstPaths.get(stableResource!.entryId);
    expect(firstPath).toBeDefined();
    expect(stablePath).toBeDefined();
    const firstBefore = await lstat(firstPath!);
    const stableBefore = await lstat(stablePath!);

    await syncComputerHistorySummaryResources(rootDir, firstProjection.resources);
    const firstSame = await lstat(firstPath!);
    const stableSame = await lstat(stablePath!);
    expect(firstSame.ino).toBe(firstBefore.ino);
    expect(firstSame.mtimeMs).toBe(firstBefore.mtimeMs);
    expect(stableSame.ino).toBe(stableBefore.ino);

    const changedProjection = makeProjection("Changed title");
    await syncComputerHistorySummaryResources(rootDir, changedProjection.resources);
    const firstChanged = await lstat(firstPath!);
    const stableAfter = await lstat(stablePath!);
    expect(firstChanged.ino).not.toBe(firstBefore.ino);
    expect(await readFile(firstPath!, "utf8")).toContain("Changed title");
    expect(stableAfter.ino).toBe(stableBefore.ino);
    expect(await readFile(stablePath!, "utf8")).toContain("Stable title");
  });

  it("uses bounded Codex-compatible job names, strips unsafe text, and rejects symlinks", async () => {
    expect(
      isComputerHistorySummaryJobResourceFilename("1970-01-01T00-00-00-abcd-10min-summary.md"),
    ).toBe(true);
    expect(
      isComputerHistorySummaryJobResourceFilename("1970-01-01T00-00-00-ABCD-10min-summary.md"),
    ).toBe(false);
    expect(
      isComputerHistorySummaryJobResourceFilename("1970-01-01T00-00-00-abcd-10min-a--b.md"),
    ).toBe(false);
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-job-resource-safety-"));
    const resource = {
      logicalJobKey: "10min:0",
      kind: "10min" as const,
      startMs: 0,
      endMs: COMPUTER_HISTORY_TEN_MINUTE_MS,
      title: "https://secret.example/path",
      description: "email user@example.com",
      summaryText: "/Users/moss/private.txt",
      applications: ["com.example.editor"],
    };
    await syncComputerHistorySummaryJobResources(rootDir, [resource], {
      randomAlpha: () => "abcd",
    });
    const files = await readdir(join(rootDir, COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY));
    const generated = files.find((name) => name.endsWith(".md"));
    expect(generated).toBe("1970-01-01T00-00-00-abcd-10min-summary.md");
    const contents = await readFile(
      join(rootDir, COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY, generated!),
      "utf8",
    );
    expect(contents).not.toContain("secret.example");
    expect(contents).not.toContain("user@example.com");
    expect(contents).not.toContain("/Users/moss");

    const symlinkRoot = await mkdtemp(join(tmpdir(), "moss-history-job-resource-symlink-"));
    const symlinkDirectory = join(symlinkRoot, COMPUTER_HISTORY_SUMMARY_RESOURCES_DIRECTORY);
    await mkdir(symlinkDirectory, { mode: 0o700 });
    if (process.platform === "win32") await mkdir(join(symlinkRoot, "outside"));
    await symlink(
      join(symlinkRoot, "outside"),
      join(symlinkDirectory, "1970-01-01T00-00-00-abcd-10min-summary.md"),
      process.platform === "win32" ? "junction" : "file",
    );
    await expect(
      syncComputerHistorySummaryJobResources(symlinkRoot, [resource], {
        randomAlpha: () => "abcd",
      }),
    ).rejects.toThrow(/regular file|collision|unsafe/u);
  });
});
