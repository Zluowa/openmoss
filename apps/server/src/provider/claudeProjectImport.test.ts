import { appendFile, mkdtemp, mkdir, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverClaudeProjects, readClaudeImportMessageDates } from "./claudeProjectImport.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const SESSION_D = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = "2026-09-01T10:00:00.000Z";
const UPDATED_AT = "2026-09-02T10:00:00.000Z";
const temporaryDirectories: string[] = [];

async function fixtureHome() {
  const directory = await mkdtemp(path.join(tmpdir(), "moss-claude-project-import-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function transcript(
  home: string,
  directory: string,
  id: string,
  entries: ReadonlyArray<unknown>,
) {
  const projectDir = path.join(home, "projects", directory);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("discoverClaudeProjects", () => {
  it("uses desktop titles, origin folders, archive flags, and parent links across renamed CLI IDs", async () => {
    const configDir = await fixtureHome();
    const desktopSessionsDir = path.join(configDir, "desktop");
    const org = path.join(desktopSessionsDir, "account", "organization");
    await mkdir(org, { recursive: true });
    const root = path.join(configDir, "workspace_with-hyphens");
    const worktree = path.join(configDir, "separate-checkouts", "fix");
    await transcript(configDir, "root", SESSION_A, [{ cwd: root, timestamp: CREATED_AT }]);
    await transcript(configDir, "worktree", SESSION_B, [{ cwd: worktree }]);
    await transcript(configDir, "root", SESSION_D, [{ cwd: root }]);
    await writeFile(
      path.join(org, "local_parent.json"),
      JSON.stringify({
        cliSessionId: SESSION_A,
        cwd: root,
        title: "Workspace conversation",
        createdAt: CREATED_AT,
      }),
    );
    await writeFile(
      path.join(org, "local_child.json"),
      JSON.stringify({
        cliSessionId: SESSION_C,
        priorCliSessionIds: [SESSION_B],
        cwd: worktree,
        originCwd: root,
        worktreePath: worktree,
        title: "Review notes from Desktop",
        isArchived: true,
        spawnedFrom: { sessionId: "local_parent" },
        lastActivityAt: UPDATED_AT,
      }),
    );
    await writeFile(path.join(org, "local_broken.json"), "{incomplete");
    await writeFile(
      path.join(org, "local_fork.json"),
      JSON.stringify({
        cliSessionId: SESSION_D,
        priorCliSessionIds: [SESSION_A],
        forkedFromSessionId: SESSION_A,
        cwd: root,
        title: "Independent fork",
      }),
    );

    const catalog = await discoverClaudeProjects({ configDir, desktopSessionsDir });
    expect(catalog.sessions).toHaveLength(3);
    expect(catalog.sessions.find(({ id }) => id === SESSION_D)?.parentSessionId).toBeUndefined();
    expect(catalog.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: SESSION_A, title: "Workspace conversation" }),
        expect.objectContaining({
          id: SESSION_B,
          title: "Review notes from Desktop",
          cwd: worktree,
          projectRoot: root,
          archived: true,
          parentSessionId: SESSION_A,
          updatedAt: UPDATED_AT,
        }),
      ]),
    );
  });

  it("finds a large transcript the SDK omitted using bounded scans and continues past a bad file", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "workspace");
    const fileSize = 110 * 1024 * 1024;
    const largeFile = await transcript(configDir, "opaque-project-name", SESSION_A, []);
    const file = await open(largeFile, "r+");
    try {
      await file.truncate(fileSize);
      // An oversized head record, and a valid but misleading record beyond the scan cap.
      const head = "\n" + JSON.stringify({ cwd: root, timestamp: CREATED_AT }) + "\n";
      await file.write(head, 9 * 1024 * 1024, "utf8");
      const decoy = "\n" + JSON.stringify({ type: "relocated", relocatedCwd: configDir }) + "\n";
      await file.write(decoy, 48 * 1024 * 1024, "utf8");
    } finally {
      await file.close();
    }
    await transcript(configDir, "broken", SESSION_B, [{ cwd: "relative" }]);
    await transcript(configDir, "next", SESSION_D, [{ cwd: root, timestamp: CREATED_AT }]);
    const catalog = await discoverClaudeProjects({ configDir });
    expect(catalog.sessions.map((entry) => [entry.id, entry.cwd]).toSorted()).toEqual([
      [SESSION_A, root],
      [SESSION_D, root],
    ]);
    expect(catalog.skippedSessions).toBe(1);
  });

  it("groups visible sessions by stable cwd and preserves distinct worktree roots", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "workspace");
    const worktree = path.join(configDir, "worktrees", "feature");
    const renamed = await transcript(configDir, "lossy-workspace", SESSION_A, [
      { cwd: root, timestamp: CREATED_AT, entrypoint: "sdk-ts" },
      { type: "custom-title", customTitle: "Renamed session" },
    ]);
    await transcript(configDir, "lossy-workspace", SESSION_B, [
      { cwd: root, timestamp: CREATED_AT },
    ]);
    await transcript(configDir, "lossy-worktree", SESSION_C, [
      { cwd: worktree, timestamp: CREATED_AT },
    ]);

    await utimes(renamed, new Date(UPDATED_AT), new Date(UPDATED_AT));
    const catalog = await discoverClaudeProjects({ configDir });

    expect(catalog.sourceHome).toBe(configDir);
    expect(catalog.projects).toEqual(
      [
        { id: worktree, title: "feature", roots: [worktree] },
        { id: root, title: "workspace", roots: [root] },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    expect(catalog.sessions.find((entry) => entry.id === SESSION_A)).toEqual({
      id: SESSION_A,
      title: "Renamed session",
      cwd: root,
      projectId: root,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      archived: false,
    });
    expect(catalog.sessions).toHaveLength(3);
  });

  it("recovers metadata beyond the SDK head limit without decoding the folder name", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "real-project_with-hyphens");
    const file = await transcript(configDir, "intentionally-not-a-path", SESSION_A, []);
    await writeFile(
      file,
      "{malformed}\n" +
        JSON.stringify({
          type: "user",
          message: { content: "x".repeat(180_000) },
          cwd: root,
          timestamp: CREATED_AT,
        }),
    );

    const catalog = await discoverClaudeProjects({ configDir });

    expect(catalog.sessions[0]).toMatchObject({
      cwd: root,
      createdAt: CREATED_AT,
      title: `${"x".repeat(39)}…`,
    });
    expect(catalog.projects[0]?.roots).toEqual([root]);
  });

  it("uses the transcript relocation record instead of its older cwd", async () => {
    const configDir = await fixtureHome();
    const oldRoot = path.join(configDir, "old");
    const relocatedRoot = path.join(configDir, "relocated");
    await transcript(configDir, "old", SESSION_A, [
      { cwd: oldRoot, timestamp: CREATED_AT },
      { type: "relocated", relocatedCwd: relocatedRoot },
    ]);
    const catalog = await discoverClaudeProjects({ configDir });

    expect(catalog.sessions[0]).toMatchObject({ cwd: relocatedRoot, createdAt: CREATED_AT });
  });

  it("omits continued transcripts and does not promote subagent logs to main sessions", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "workspace");
    await transcript(configDir, "project", SESSION_A, [{ cwd: root }]);
    await transcript(configDir, "project", SESSION_B, [
      { cwd: root },
      { type: "continued-in", continuedInSessionId: SESSION_A },
    ]);
    await transcript(configDir, path.join("project", SESSION_A, "subagents"), SESSION_C, [
      { cwd: root, isSidechain: true },
    ]);

    const catalog = await discoverClaudeProjects({ configDir });

    expect(catalog.sessions.map((entry) => entry.id)).toEqual([SESSION_A]);
  });

  it("does not guess project paths for records without valid main-session metadata", async () => {
    const configDir = await fixtureHome();
    await transcript(configDir, "-a-plausible-project-path", SESSION_A, [
      { cwd: "relative-project", timestamp: CREATED_AT },
      { cwd: path.join(configDir, "child"), isSidechain: true },
    ]);

    const catalog = await discoverClaudeProjects({ configDir });

    expect(catalog.projects).toEqual([]);
    expect(catalog.sessions).toEqual([]);
  });

  it("uses the newest transcript when a native session appears in multiple directories", async () => {
    const configDir = await fixtureHome();
    const root = path.join(configDir, "new");
    const newest = await transcript(configDir, "a-new", SESSION_A, [
      { cwd: root, timestamp: CREATED_AT },
    ]);
    const oldest = await transcript(configDir, "z-old", SESSION_A, [
      { cwd: path.join(configDir, "old"), timestamp: CREATED_AT },
    ]);
    await utimes(newest, new Date(UPDATED_AT), new Date(UPDATED_AT));
    await utimes(oldest, new Date(CREATED_AT), new Date(CREATED_AT));

    const catalog = await discoverClaudeProjects({ configDir });

    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.cwd).toBe(root);
  });

  it("returns an empty catalog when no local sessions exist", async () => {
    const configDir = await fixtureHome();

    expect(await discoverClaudeProjects({ configDir })).toEqual({
      sourceHome: configDir,
      projects: [],
      sessions: [],
    });
  });
});

describe("readClaudeImportMessageDates", () => {
  it("enriches remapped native UUIDs with original dates while ignoring malformed and sidechain records", async () => {
    const configDir = await fixtureHome();
    const file = await transcript(configDir, "project", SESSION_A, [
      {
        type: "user",
        uuid: "forked-user",
        message: { content: "x".repeat(150_000) },
        timestamp: CREATED_AT,
      },
      { type: "assistant", uuid: "forked-assistant", timestamp: UPDATED_AT },
      { type: "assistant", uuid: "subagent", timestamp: CREATED_AT, isSidechain: true },
      { type: "custom-title", uuid: "title" },
      { type: "user", uuid: "bad-date", timestamp: "invalid" },
    ]);
    await appendFile(file, "{incomplete");

    const dates = await readClaudeImportMessageDates({ configDir, sessionId: SESSION_A });

    expect([...dates]).toEqual([
      ["forked-user", CREATED_AT],
      ["forked-assistant", UPDATED_AT],
    ]);
  });

  it("returns no dates for a source that no longer exists", async () => {
    const configDir = await fixtureHome();
    expect((await readClaudeImportMessageDates({ configDir, sessionId: SESSION_A })).size).toBe(0);
  });
});
