import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  canvasBoardScopeFromUrl,
  freezeLegacyBoardSource,
  initializeCanvasBoard,
  mossCanvasBoardDirectory,
  registerLegacyCanvasBoards,
} from "./mossCanvasBoardStorage";
import { mediaAccountScope } from "./mossMediaJobsService";

const identity = {
  realm: "memfire-phone" as const,
  account: { id: "synthetic-owner", realm: "memfire-phone" as const },
  gatewayBaseUrl: "https://models.example/v1",
};
const oldA = {
  pageId: "old-a",
  canvasProjectKey: "space-board-old-a",
  scopeSpaceId: null,
  version: 1 as const,
};
const oldB = {
  pageId: "old-b",
  canvasProjectKey: "space-board-old-b",
  scopeSpaceId: null,
  version: 1 as const,
};
// Retain test directories as diagnosis evidence; no owner profile is read or changed.
const roots: string[] = [];
afterEach(() => {
  roots.length = 0;
});
async function fixture() {
  const state = await mkdtemp(
    join(process.env.MOSS_BOARD_TEST_ROOT ?? tmpdir(), "board-isolation-"),
  );
  roots.push(state);
  const bundle = join(state, "bundle"),
    native = join(bundle, "apps/codex-canvas/electron");
  await mkdir(native, { recursive: true });
  // This unit fixture models only the native lease boundary. The production hosted factory
  // and native process-identity lease are separately exercised by the real-bundle gate.
  await writeFile(
    join(native, "workspace-persistence.mjs"),
    `import {openSync,closeSync,unlinkSync} from 'node:fs';import {join,resolve} from 'node:path';
  export const resolveProjectIdentity=projectDir=>({projectDir:resolve(projectDir),projectId:'fixture'});
  export const createProjectPaths=i=>({canvasRoot:join(i.projectDir,'.hoola/canvas'),projectWriterLeasePath:join(i.projectDir,'.hoola/canvas/writer.lease.json')});
  export function acquireProjectWriterLease({paths}){try{const f=openSync(paths.projectWriterLeasePath,'wx');return {ok:true,lease:{release(){closeSync(f);unlinkSync(paths.projectWriterLeasePath);}}};}catch{return {ok:false};}}`,
  );
  const source = join(state, "moss-canvas", mediaAccountScope(identity));
  const canvas = join(source, "workspace/.hoola/canvas"),
    projects = join(source, "workspace/.hoola/projects");
  await mkdir(projects, { recursive: true });
  await mkdir(canvas, { recursive: true });
  await mkdir(join(source, "workspace/.hoola/knowledge/files"), { recursive: true });
  await mkdir(join(source, "assets"));
  const active = JSON.stringify({ version: 1, relativePath: "old.tldr" });
  await writeFile(join(canvas, "active-project.json"), active);
  const drawing = JSON.stringify({
    kind: "hoola-tldraw-project",
    projectId: "independent-project-uuid",
    snapshot: {
      document: {
        store: {
          "shape:old": {
            id: "shape:old",
            typeName: "shape",
            type: "geo",
            props: { geo: "rectangle" },
          },
          "asset:old": {
            id: "asset:old",
            typeName: "asset",
            props: { src: "moss-canvas-asset:original.png" },
          },
        },
      },
    },
  });
  await writeFile(join(projects, "old.tldr"), drawing);
  await writeFile(join(source, "assets/original.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(
    join(source, "workspace/.hoola/knowledge/files/writer.lease.json"),
    "user-knowledge-with-native-lease-name",
  );
  await mkdir(join(source, "workspace/.hoola/knowledge/files/empty-folder"));
  await writeFile(
    join(canvas, "recent-tldr-files.json"),
    JSON.stringify([{ filePath: join(projects, "old.tldr"), fileName: "old.tldr" }]),
  );
  const db = new DatabaseSync(join(source, "hoola-canvas.sqlite3"));
  db.exec("CREATE TABLE assets_meta(asset_id TEXT,local_path TEXT,preview_path TEXT)");
  db.prepare("INSERT INTO assets_meta VALUES (?,?,?)").run(
    "asset",
    join(source, "assets/original.png"),
    join(source, "assets/original.png"),
  );
  db.close();
  await registerLegacyCanvasBoards(state, [oldA, oldB], bundle);
  return { state, bundle, source, canvas, projects, drawing, active };
}
describe("independent board storage migration", () => {
  it("keeps one immutable legacy snapshot, preserves source bytes and independently seeds two old boards including images and knowledge", async () => {
    const f = await fixture(),
      archive = await freezeLegacyBoardSource(f.state, identity, f.bundle);
    expect(await readFile(join(archive, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(
      f.drawing,
    );
    // An account-canvas edit after the freeze cannot change what another legacy board seeds.
    await writeFile(join(f.projects, "old.tldr"), "later-account-edit");
    const [a, b] = await Promise.all([
      initializeCanvasBoard(f.state, identity, oldA, f.bundle),
      initializeCanvasBoard(f.state, identity, oldB, f.bundle),
    ]);
    expect(a).not.toBe(b);
    for (const target of [a, b]) {
      expect(await readFile(join(target, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(
        f.drawing,
      );
      expect(
        await readFile(join(target, "workspace/.hoola/knowledge/files/writer.lease.json"), "utf8"),
      ).toBe("user-knowledge-with-native-lease-name");
      expect(await readdir(join(target, "workspace/.hoola/knowledge/files/empty-folder"))).toEqual(
        [],
      );
      expect(await readFile(join(target, "assets/original.png"))).toEqual(
        Buffer.from([137, 80, 78, 71]),
      );
      const recent = JSON.parse(
        await readFile(join(target, "workspace/.hoola/canvas/recent-tldr-files.json"), "utf8"),
      );
      expect(recent[0].filePath).toBe(join(target, "workspace/.hoola/projects/old.tldr"));
      const db = new DatabaseSync(toNamespacedPath(join(target, "hoola-canvas.sqlite3")));
      try {
        expect(db.prepare("SELECT local_path,preview_path FROM assets_meta").get()).toEqual({
          local_path: join(target, "assets/original.png"),
          preview_path: join(target, "assets/original.png"),
        });
      } finally {
        db.close();
      }
    }
    await writeFile(join(a, "workspace/.hoola/projects/old.tldr"), "board-A-edit");
    expect(await initializeCanvasBoard(f.state, identity, oldA, f.bundle)).toBe(a);
    expect(await readFile(join(a, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(
      "board-A-edit",
    );
    expect(await readFile(join(b, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(f.drawing);
    expect(await readFile(join(f.projects, "old.tldr"), "utf8")).toBe("later-account-edit");
    expect(await readFile(join(f.canvas, "active-project.json"), "utf8")).toBe(f.active);
    expect(await readFile(join(archive, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(
      f.drawing,
    );
    const originalDb = new DatabaseSync(join(f.source, "hoola-canvas.sqlite3"));
    try {
      expect(originalDb.prepare("SELECT local_path FROM assets_meta").get()).toEqual({
        local_path: join(f.source, "assets/original.png"),
      });
    } finally {
      originalDb.close();
    }
  });
  it("makes two new boards empty, isolates accounts, and never expands an existing legacy registry", async () => {
    const f = await fixture();
    await registerLegacyCanvasBoards(
      f.state,
      [oldA, oldB, { ...oldA, pageId: "forged" }],
      f.bundle,
    );
    await expect(
      initializeCanvasBoard(f.state, identity, { ...oldA, pageId: "forged" }, f.bundle),
    ).rejects.toThrow("canvas_board_not_legacy");
    const a = await initializeCanvasBoard(f.state, identity, { ...oldA, version: 2 }, f.bundle),
      b = await initializeCanvasBoard(f.state, identity, { ...oldB, version: 2 }, f.bundle);
    expect(await readdir(a)).toEqual(["board-initialization.json"]);
    expect(await readdir(b)).toEqual(["board-initialization.json"]);
    expect(
      mossCanvasBoardDirectory(
        f.state,
        { ...identity, account: { ...identity.account, id: "other-owner" } },
        oldA,
      ),
    ).not.toBe(a);
  });
  it("is idempotent under concurrent first opens and refuses linked or incomplete targets without overwriting them", async () => {
    const f = await fixture(),
      board = { ...oldA, version: 2 as const };
    expect(
      (
        await Promise.all([
          initializeCanvasBoard(f.state, identity, board, f.bundle),
          initializeCanvasBoard(f.state, identity, board, f.bundle),
        ])
      )[0],
    ).toBe(mossCanvasBoardDirectory(f.state, identity, board));
    const bad = { ...oldB, version: 2 as const },
      target = mossCanvasBoardDirectory(f.state, identity, bad),
      outside = join(f.state, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "untouched");
    await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    await expect(initializeCanvasBoard(f.state, identity, bad, f.bundle)).rejects.toThrow(
      "canvas_board_path_invalid",
    );
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("untouched");
    const incomplete = { ...bad, pageId: "incomplete" },
      path = mossCanvasBoardDirectory(f.state, identity, incomplete);
    await mkdir(path);
    await writeFile(join(path, "keep"), "preserved");
    await expect(initializeCanvasBoard(f.state, identity, incomplete, f.bundle)).rejects.toThrow();
    expect(await readFile(join(path, "keep"), "utf8")).toBe("preserved");
  });
  it("accepts Unicode contract IDs while rejecting mixed scopes and duplicate query fields", () => {
    const url = new URL("http://localhost/api/moss/media/canvas/storage");
    url.searchParams.set("canvasBoard", "board \u4e00");
    url.searchParams.set("canvasBoardKey", "space-board-one");
    url.searchParams.set("canvasBoardSpace", "");
    expect(canvasBoardScopeFromUrl(url)?.pageId).toBe("board \u4e00");
    url.searchParams.set("canvasThread", "thread");
    expect(() => canvasBoardScopeFromUrl(url)).toThrow();
    url.searchParams.delete("canvasThread");
    url.searchParams.append("canvasBoard", "second");
    expect(() => canvasBoardScopeFromUrl(url)).toThrow();
  });
  it("recovers an interrupted registry staging write, commits concurrent registration once, and retains old-board eligibility after a scope move", async () => {
    const f = await fixture();
    const path = join(f.state, "moss-canvas-board-legacy-registry.json");
    const { rename } = await import("node:fs/promises");
    await rename(path, `${path}.previous-preserved`);
    await writeFile(`${path}.pending-crash`, '{"version":1,');
    await Promise.all([
      registerLegacyCanvasBoards(f.state, [oldA, oldB], f.bundle),
      registerLegacyCanvasBoards(f.state, [oldA, oldB], f.bundle),
    ]);
    await registerLegacyCanvasBoards(
      f.state,
      [oldA, oldB, { ...oldA, pageId: "late-forged" }],
      f.bundle,
    );
    expect(JSON.parse(await readFile(path, "utf8")).boards).toHaveLength(2);
    expect(await readFile(`${path}.pending-crash`, "utf8")).toBe('{"version":1,');
    const moved = { ...oldA, scopeSpaceId: "new-allowed-space" };
    const target = await initializeCanvasBoard(f.state, identity, moved, f.bundle);
    expect(await readFile(join(target, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(
      f.drawing,
    );
  });
  it("fails without seeding when source has a live writer, and retains every source byte", async () => {
    const f = await fixture();
    await writeFile(join(f.canvas, "writer.lease.json"), "live-writer");
    await expect(initializeCanvasBoard(f.state, identity, oldA, f.bundle)).rejects.toThrow(
      "canvas_writer_busy",
    );
    expect(await readFile(join(f.projects, "old.tldr"), "utf8")).toBe(f.drawing);
    expect(await readFile(join(f.canvas, "active-project.json"), "utf8")).toBe(f.active);
    expect(await readFile(join(f.canvas, "writer.lease.json"), "utf8")).toBe("live-writer");
  });
  it("blocks legacy initialization when the startup registry is unavailable instead of showing a blank successful board", async () => {
    const f = await fixture();
    const { rename } = await import("node:fs/promises");
    const registry = join(f.state, "moss-canvas-board-legacy-registry.json");
    await rename(registry, `${registry}.preserved`);
    await mkdir(registry);
    await expect(initializeCanvasBoard(f.state, identity, oldA, f.bundle)).rejects.toThrow(
      "canvas_board_manifest_invalid",
    );
    expect(await readFile(join(f.projects, "old.tldr"), "utf8")).toBe(f.drawing);
  });
  it("opens an old board whose stored paths predate a moved profile: re-anchors what the copy holds and drops the rest", async () => {
    const f = await fixture();
    // The store was copied here from another folder; its metadata still names the old place.
    const elsewhere = join(f.state, "profile-before-move", "moss-canvas", "scope");
    await writeFile(
      join(f.canvas, "recent-tldr-files.json"),
      JSON.stringify([
        { filePath: join(elsewhere, "workspace/.hoola/projects/old.tldr"), fileName: "old.tldr" },
        { filePath: join(elsewhere, "workspace/.hoola/projects/gone.tldr"), fileName: "gone.tldr" },
      ]),
    );
    const source = new DatabaseSync(join(f.source, "hoola-canvas.sqlite3"));
    source
      .prepare("UPDATE assets_meta SET local_path=?,preview_path=?")
      .run(join(elsewhere, "assets/original.png"), join(elsewhere, "assets/never-copied.png"));
    source.close();
    const a = await initializeCanvasBoard(f.state, identity, oldA, f.bundle);
    expect(
      JSON.parse(await readFile(join(a, "workspace/.hoola/canvas/recent-tldr-files.json"), "utf8")),
    ).toEqual([{ filePath: join(a, "workspace/.hoola/projects/old.tldr"), fileName: "old.tldr" }]);
    const copy = new DatabaseSync(toNamespacedPath(join(a, "hoola-canvas.sqlite3")));
    try {
      expect(copy.prepare("SELECT local_path,preview_path FROM assets_meta").get()).toEqual({
        local_path: join(a, "assets/original.png"),
        preview_path: join(elsewhere, "assets/never-copied.png"),
      });
    } finally {
      copy.close();
    }
    expect(await readFile(join(a, "workspace/.hoola/projects/old.tldr"), "utf8")).toBe(f.drawing);
    expect((await readdir(join(a, ".."))).filter((name) => name.includes(".pending-"))).toEqual([]);
  });
  it("leaves no staging copy behind when an old board cannot be seeded", async () => {
    const f = await fixture();
    await writeFile(join(f.canvas, "recent-tldr-files.json"), "{}");
    await expect(initializeCanvasBoard(f.state, identity, oldA, f.bundle)).rejects.toThrow(
      "canvas_legacy_recent_invalid",
    );
    const parent = join(mossCanvasBoardDirectory(f.state, identity, oldA), "..");
    expect(await readdir(parent)).toEqual([]);
  });
});
