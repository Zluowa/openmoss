import { copyFile, link, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServerConfig } from "../../../config";
import { ServerEnvironmentLive } from "../../../environment/Layers/ServerEnvironment";
import { ServerEnvironment } from "../../../environment/Services/ServerEnvironment";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient";
import { layerConfig, makeSqlitePersistenceLive } from "../../../persistence/Layers/Sqlite";
import { commitRoomCheckpoint } from "../pageRoomPublication";
import { readPageDoc, seedPageDoc } from "../pageYjsContent";
import { makeRoomProfileStorage } from "./roomProfileStorage";

const location = {
  pageId: "fixture-page",
  scopeKey: "local-default",
  generation: "fixture-generation",
};
const cleanups: Array<() => Promise<void>> = [];
let root: string, baseline: string, expectedState: Uint8Array<ArrayBuffer>;
function openProfile(base: string, options: { foreignDatabase?: string; memory?: boolean } = {}) {
  const config = ServerConfig.layerTest(process.cwd(), base);
  const persistence = options.memory
    ? NodeSqliteClient.layerMemory()
    : options.foreignDatabase
      ? makeSqlitePersistenceLive(options.foreignDatabase)
      : layerConfig;
  const services = Layer.mergeAll(ServerEnvironmentLive, persistence).pipe(
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(services);
  cleanups.push(() => runtime.dispose());
  return runtime;
}
async function profile(copyEnvironment = false) {
  const base = await mkdtemp(join(root, "profile-"));
  await mkdir(join(base, "userdata"), { recursive: true });
  // The template runtime is already closed. Never copy a live DB or its WAL.
  await copyFile(join(baseline, "userdata/state.sqlite"), join(base, "userdata/state.sqlite"));
  if (copyEnvironment)
    await copyFile(
      join(baseline, "userdata/environment-id"),
      join(base, "userdata/environment-id"),
    );
  return base;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-room-profile-boundary-"));
  baseline = join(root, "template");
  const runtime = openProfile(baseline);
  const doc = new Y.Doc();
  try {
    seedPageDoc(doc, [{ type: "p", children: [{ text: "isolated profile" }] }]);
    expectedState = new Uint8Array(Y.encodeStateAsUpdate(doc));
    const rich = JSON.stringify(readPageDoc(doc));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO main.pages_documents(page_id,scope_key,root_page_id,title,revision,created_at,updated_at)
        VALUES(${location.pageId},${location.scopeKey},${location.pageId},'fixture',1,'fixture','fixture')`;
          yield* sql`INSERT INTO main.pages_versions(page_id,revision,page_json,content,rich_content,operation,author,created_at)
        VALUES(${location.pageId},1,'{}','isolated profile',${rich},'create','local-user','fixture')`;
          yield* commitRoomCheckpoint(sql, location.pageId, {
            generation: location.generation,
            revision: 1,
            throughSequence: 0,
            key: rich,
            state: expectedState,
          });
        }),
      ),
    );
  } finally {
    doc.destroy();
    await runtime.dispose();
  }
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("actual isolated profile storage boundary", () => {
  it("reads the committed source through the live profile layer and reopens the same namespace", async () => {
    const base = await profile(),
      first = openProfile(base);
    const source = await first.runPromise(makeRoomProfileStorage);
    expect(source.durability).toBe("wal-normal");
    expect(source.profileRef).toMatch(/^moss-room-profile-[0-9a-f]{64}$/);
    expect(Object.keys(source).sort()).toEqual(["durability", "profileRef", "readCommittedCut"]);
    expect(await first.runPromise(source.readCommittedCut(source.profileRef, location))).toEqual({
      kind: "ready",
      cut: {
        generation: location.generation,
        revision: 1,
        throughSequence: 0,
        state: expectedState,
      },
    });
    expect(
      await first.runPromise(Effect.result(source.readCommittedCut("foreign", location))),
    ).toMatchObject({ _tag: "Failure", failure: { code: "profile-mismatch" } });
    await first.dispose();
    const second = openProfile(base);
    expect((await second.runPromise(makeRoomProfileStorage)).profileRef).toBe(source.profileRef);
  });

  it("shows copied environment-id reuses the public namespace while a fresh profile gets another", async () => {
    const original = openProfile(baseline),
      copied = openProfile(await profile(true)),
      fresh = openProfile(await profile());
    const a = await original.runPromise(makeRoomProfileStorage),
      b = await copied.runPromise(makeRoomProfileStorage),
      c = await fresh.runPromise(makeRoomProfileStorage);
    expect(a.profileRef).toBe(b.profileRef);
    expect(a.profileRef).not.toBe(c.profileRef);
    expect((await copied.runPromise(b.readCommittedCut(b.profileRef, location))).kind).toBe(
      "ready",
    );
  });

  it("holds the actual runtime lifecycle lock until the first profile closes", async () => {
    const base = await profile(),
      first = openProfile(base);
    await first.runPromise(makeRoomProfileStorage);
    const second = openProfile(base);
    await expect(second.runPromise(makeRoomProfileStorage)).rejects.toThrow(/lifecycle is locked/u);
    await second.dispose();
    await first.dispose();
    const reopened = openProfile(base);
    expect((await reopened.runPromise(makeRoomProfileStorage)).durability).toBe("wal-normal");
  });

  it("does not bind a configured profile to another file or an in-memory connection", async () => {
    const configured = await profile(),
      foreign = await profile();
    for (const runtime of [
      openProfile(configured, { foreignDatabase: join(foreign, "userdata/state.sqlite") }),
      openProfile(configured, { memory: true }),
    ]) {
      const result = await runtime.runPromise(Effect.result(makeRoomProfileStorage));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "profile-mismatch", message: "Room profile storage: profile-mismatch" },
      });
    }
  });

  it("rejects an intentionally hard-linked isolated database", async () => {
    const base = await profile();
    await link(join(base, "userdata/state.sqlite"), join(base, "second-name.sqlite"));
    const runtime = openProfile(base);
    expect(await runtime.runPromise(Effect.result(makeRoomProfileStorage))).toMatchObject({
      _tag: "Failure",
      failure: { code: "profile-mismatch" },
    });
  });

  it("keeps source data on main even when temporary tables shadow all three source names", async () => {
    const runtime = openProfile(await profile()),
      source = await runtime.runPromise(makeRoomProfileStorage);
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    await runtime.runPromise(
      sql`CREATE TEMP TABLE pages_realtime_docs AS SELECT * FROM main.pages_realtime_docs WHERE 0`,
    );
    await runtime.runPromise(
      sql`CREATE TEMP TABLE pages_documents AS SELECT * FROM main.pages_documents WHERE 0`,
    );
    await runtime.runPromise(
      sql`CREATE TEMP TABLE pages_versions AS SELECT * FROM main.pages_versions WHERE 0`,
    );
    const result = await runtime.runPromise(source.readCommittedCut(source.profileRef, location));
    expect(result).toMatchObject({ kind: "ready", cut: { state: expectedState } });
  });

  it.each(["attached", "foreign-keys", "sync-off"])(
    "rechecks connection policy after %s changes",
    async (variant) => {
      const runtime = openProfile(await profile()),
        source = await runtime.runPromise(makeRoomProfileStorage);
      const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      if (variant === "attached")
        await runtime.runPromise(sql`ATTACH DATABASE ':memory:' AS unexpected`);
      if (variant === "foreign-keys") await runtime.runPromise(sql`PRAGMA foreign_keys=OFF`);
      if (variant === "sync-off") await runtime.runPromise(sql`PRAGMA main.synchronous=OFF`);
      const result = await runtime.runPromise(
        Effect.result(source.readCommittedCut(source.profileRef, location)),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: variant === "attached" ? "profile-mismatch" : "storage-policy-mismatch" },
      });
    },
  );

  it.each(["fixture-table", "missing-receipt", "missing-column"])(
    "rejects %s in an isolated real profile",
    async (variant) => {
      const runtime = openProfile(await profile()),
        sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      const prior = await runtime.runPromise(makeRoomProfileStorage);
      if (variant === "fixture-table")
        await runtime.runPromise(sql`CREATE TABLE main.fixture_c1c_test_marker(id INTEGER)`);
      if (variant === "missing-receipt")
        await runtime.runPromise(
          sql`DELETE FROM main.effect_sql_migrations WHERE migration_id=163`,
        );
      if (variant === "missing-column")
        await runtime.runPromise(
          sql`ALTER TABLE main.pages_realtime_docs RENAME COLUMN compacted_through_sequence TO isolated_broken_column`,
        );
      const code = variant === "fixture-table" ? "fixture-storage" : "source-schema-unavailable";
      expect(await runtime.runPromise(Effect.result(makeRoomProfileStorage))).toMatchObject({
        _tag: "Failure",
        failure: { code },
      });
      expect(
        await runtime.runPromise(Effect.result(prior.readCommittedCut(prior.profileRef, location))),
      ).toMatchObject({ _tag: "Failure", failure: { code } });
    },
  );

  it("fails closed on an overlong persisted public ID without replacing it", async () => {
    const base = await profile(),
      persisted = "a".repeat(129);
    await writeFile(join(base, "userdata/environment-id"), persisted, { flag: "wx" });
    const runtime = openProfile(base);
    expect(await runtime.runPromise(Effect.result(makeRoomProfileStorage))).toMatchObject({
      _tag: "Failure",
      failure: { code: "profile-id-invalid" },
    });
    const env = await runtime.runPromise(Effect.service(ServerEnvironment));
    expect((await runtime.runPromise(env.getDescriptor)).environmentId).toBe(persisted);
  });
});
