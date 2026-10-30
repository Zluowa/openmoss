import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMossCanvasWorkspace } from "./mossCanvasWorkspace";
import { mossCanvasStorageFor } from "./mossCanvasStorage";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import type { MossMediaCredential } from "./mossMediaJobsService";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "moss-canvas-context-"));
  directories.push(root);
  const selected = join(root, "selected"),
    worktree = join(root, "worktree");
  await mkdir(selected);
  await mkdir(worktree);
  return {
    root: await realpath(root),
    selected: await realpath(selected),
    worktree: await realpath(worktree),
  };
}
function query(root: string, overrides: Record<string, unknown> = {}) {
  return {
    getThreadShellById: vi.fn(() =>
      Effect.succeed(
        Option.some({
          id: "thread-a",
          projectId: "project-a",
          title: "Thread A",
          envMode: "local",
          worktreePath: null,
          workingDirectory: null,
          ...overrides,
        }),
      ),
    ),
    getProjectShellById: vi.fn(() =>
      Effect.succeed(Option.some({ id: "project-a", workspaceRoot: root })),
    ),
  };
}
function resolve(projection: ReturnType<typeof query>, id = "thread-a") {
  return Effect.runPromise(
    resolveMossCanvasWorkspace(id).pipe(
      Effect.provideService(ProjectionSnapshotQuery, projection as never),
    ),
  );
}
describe("Canvas trusted conversation workspace", () => {
  it("uses the selected conversation folder and worktree rules from existing orchestration", async () => {
    const paths = await fixture();
    expect((await resolve(query(paths.root, { workingDirectory: paths.selected }))).cwd).toBe(
      paths.selected,
    );
    expect(
      (await resolve(query(paths.root, { envMode: "worktree", worktreePath: paths.worktree }))).cwd,
    ).toBe(paths.worktree);
    expect((await resolve(query(paths.root))).cwd).toBe(paths.root);
  });
  it("rejects a missing or mismatched thread and never accepts a filesystem path as its identity", async () => {
    const paths = await fixture();
    const projection = query(paths.root, { id: "thread-other" });
    await expect(resolve(projection)).rejects.toMatchObject({ code: "canvas_thread_not_found" });
    await expect(resolve(projection, "../../outside")).rejects.toMatchObject({
      code: "invalid_canvas_thread",
    });
  });
  it("rejects a pre-existing junction out of the selected workspace before opening storage", async () => {
    const paths = await fixture();
    await symlink(paths.selected, join(paths.root, ".moss"), "junction");
    const credential: MossMediaCredential = {
      realm: "memfire-phone",
      account: { id: "fixture", realm: "memfire-phone" },
      gatewayBaseUrl: "https://gateway.example/v1",
      accessToken: "fixture-only",
    };
    await expect(
      mossCanvasStorageFor(paths.root, credential, {
        threadId: "thread-a",
        cwd: paths.root,
        title: "A",
      }),
    ).rejects.toMatchObject({ code: "canvas_workspace_path_invalid" });
  });
});
