import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectId, ThreadId } from "@moss/contracts";
import { Effect, Option } from "effect";
import { afterEach, expect, it } from "vitest";
import { ensureIsolatedScratchWorkspace } from "./scratchWorkspaces";
import { resolveThreadExecutionWorkspace } from "./threadExecutionWorkspace";
import { publishThreadOutput, readThreadOutput } from "./threadOutputFile";
import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "moss-thread-output-"));
  homes.push(homeDir);
  const chatWorkspaceRoot = path.join(homeDir, "Documents", "Moss");
  const folder = path.join(chatWorkspaceRoot, "2026-11-06", "presentation");
  await mkdir(folder, { recursive: true });
  const owner = ThreadId.makeUnsafe(randomUUID());
  const project = {
    id: ProjectId.makeUnsafe(randomUUID()),
    kind: "chat" as const,
    workspaceRoot: folder,
  };
  const thread = {
    id: owner,
    projectId: project.id,
    workingDirectory: null,
    worktreePath: null,
    envMode: "local" as const,
  };
  const config = { homeDir, chatWorkspaceRoot };
  const query = { getOriginalThreadIdByProjectId: () => Effect.succeed(Option.some(owner)) };
  return { homeDir, chatWorkspaceRoot, folder, owner, project, thread, config, query };
}

it("uses the first chat thread's real folder without making it a checkpoint workspace", async () => {
  const f = await fixture();
  expect(await Effect.runPromise(resolveThreadExecutionWorkspace(f))).toBe(f.folder);
  expect(resolveThreadWorkspaceCwd({ thread: f.thread, projects: [f.project] })).toBeUndefined();
  const sibling = ThreadId.makeUnsafe(randomUUID());
  const siblingCwd = await Effect.runPromise(
    resolveThreadExecutionWorkspace({ ...f, thread: { ...f.thread, id: sibling } }),
  );
  expect(siblingCwd).toBe(ensureIsolatedScratchWorkspace(sibling));
  homes.push(siblingCwd!);
});

it("keeps prior scratch files and refuses the shared and neighboring chat roots", async () => {
  const f = await fixture();
  const previous = ensureIsolatedScratchWorkspace(f.owner);
  homes.push(previous);
  await writeFile(path.join(previous, "prior.txt"), "retained");
  expect(await Effect.runPromise(resolveThreadExecutionWorkspace(f))).toBe(previous);
  expect(await readFile(path.join(previous, "prior.txt"), "utf8")).toBe("retained");
  for (const cwd of [
    f.config.homeDir,
    f.chatWorkspaceRoot,
    path.join(f.chatWorkspaceRoot, "2026-11-06", "neighbor"),
  ]) {
    const otherThread = {
      ...f.thread,
      id: ThreadId.makeUnsafe(randomUUID()),
      workingDirectory: cwd,
    };
    const actual = await Effect.runPromise(
      resolveThreadExecutionWorkspace({ ...f, thread: otherThread }),
    );
    expect(actual).toBe(ensureIsolatedScratchWorkspace(otherThread.id));
    homes.push(actual!);
  }
});

it("saves complete distinct downloads and rejects replacements, links and escapes", async () => {
  const f = await fixture();
  const bytes = new TextEncoder().encode("slide bytes");
  const first = await publishThreadOutput(f.folder, "slides/deck.pptx", bytes, true);
  const second = await publishThreadOutput(f.folder, "slides/deck.pptx", bytes, true);
  expect(second.relative).toBe("slides/deck (1).pptx");
  expect((await readThreadOutput(f.folder, first.relative, first.sha256)).bytes).toEqual(
    Buffer.from(bytes),
  );
  await writeFile(first.file, "changed");
  await expect(readThreadOutput(f.folder, first.relative, first.sha256)).rejects.toThrow();
  const outside = path.join(f.homeDir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.pptx"), "outside");
  await symlink(
    outside,
    path.join(f.folder, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await link(path.join(outside, "secret.pptx"), path.join(f.folder, "alias.pptx"));
  for (const candidate of ["alias/secret.pptx", "alias.pptx", "../secret.pptx", ".env"]) {
    await expect(readThreadOutput(f.folder, candidate)).rejects.toThrow();
  }
  await expect(publishThreadOutput(f.folder, "alias/new.pptx", bytes, false)).rejects.toThrow();
});
