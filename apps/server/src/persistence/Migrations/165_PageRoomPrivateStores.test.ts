import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { makeSqlitePersistenceLive } from "../Layers/Sqlite";
import { runMigrations } from "../Migrations";
import * as NodeSqliteClient from "../NodeSqliteClient";

let directory: string, template: string, migrated: string;
const digest = "a".repeat(64),
  other = "b".repeat(64),
  room = { tenantRef: "tenant", roomId: "room", documentGeneration: "gen", keyEpoch: 1 };
const owner = ["profile", "tenant", "room", "gen", 1] as const;
const tables = [
  "pages_room_owner_slots",
  "pages_room_owner_publications",
  "pages_room_owner_outbox",
  "pages_room_device_slots",
  "pages_room_device_installs",
];
function db(file: string) {
  const connection = new DatabaseSync(file);
  connection.exec("PRAGMA foreign_keys=ON");
  return connection;
}
async function start(file: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT migration_id,name FROM main.effect_sql_migrations WHERE migration_id=165`;
    }).pipe(
      Effect.provide(makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer))),
    ),
  );
}
function legacyContents(file: string) {
  const sql = db(file);
  try {
    return [
      "pages_documents",
      "pages_versions",
      "pages_realtime_docs",
      "pages_realtime_updates",
      "page_apps",
      "page_app_versions",
      "page_app_publication_slots",
      "page_app_publications",
    ].map((name) => sql.prepare(`SELECT * FROM ${name}`).all());
  } finally {
    sql.close();
  }
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "moss-room-165-"));
  template = join(directory, "legacy164.sqlite");
  migrated = join(directory, "current165.sqlite");
  await Effect.runPromise(
    runMigrations({ toMigrationInclusive: 164 }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: template })),
    ),
  );
  const sql = db(template);
  try {
    sql.exec(`BEGIN;
      INSERT INTO pages_documents(page_id,scope_key,root_page_id,title,revision,created_at,updated_at) VALUES('p','local-default','p','原页面',1,'old','old');
      INSERT INTO pages_versions(page_id,revision,page_json,content,operation,author,created_at) VALUES('p',1,'{ "保留": true }','原正文','create','local-user','old');
      INSERT INTO pages_realtime_docs(page_id,generation,state,compacted_revision,compacted_key,updated_at,next_sequence,compacted_through_sequence)
        VALUES('p','legacy',x'00ff13',1,'markdown:原正文','old',4,2);
      INSERT INTO pages_realtime_updates(page_id,seq,generation,update_data,created_at) VALUES('p',3,'legacy',x'feed','old');
      INSERT INTO page_apps(app_id,scope_key,title,revision,created_at,updated_at) VALUES('app','local-default','保留应用',1,'old','old');
      INSERT INTO page_app_versions(app_id,revision,title,description,capabilities_json,html,operation,author,created_at)
        VALUES('app',1,'保留应用','','{}','<p>原 HTML</p>','create','local-user','old');
      INSERT INTO page_app_publication_slots VALUES('link','entry','p','[0]',1);
      INSERT INTO page_app_publications VALUES('publication','link','entry','p','[0]',1,'stamp',1,'local-default',NULL,'body','app',1,'app-body'); COMMIT;`);
  } finally {
    sql.close();
  }
  await copyFile(template, migrated);
  await start(migrated);
});

it("upgrades actual 164 artifacts byte-for-byte, creates five empty stores, and reopens with one tracker entry", async () => {
  expect(legacyContents(migrated)).toEqual(legacyContents(template));
  expect(await start(migrated)).toEqual([{ migration_id: 165, name: "PageRoomPrivateStores" }]);
  const sql = db(migrated);
  try {
    expect(
      sql.prepare("SELECT count(*) AS n FROM effect_sql_migrations WHERE migration_id=165").get(),
    ).toMatchObject({ n: 1 });
    for (const table of tables)
      expect(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toMatchObject({ n: 0 });
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sql.close();
  }
});

it("rolls back all new objects on a late name collision, preserves tracker 164 and existing data", async () => {
  const file = join(directory, "collision.sqlite");
  await copyFile(template, file);
  let sql = db(file);
  sql.exec(
    "CREATE TABLE pages_room_device_slots(original TEXT); INSERT INTO pages_room_device_slots VALUES('preserved');",
  );
  sql.close();
  await expect(start(file)).rejects.toThrow();
  sql = db(file);
  try {
    expect(
      sql.prepare("SELECT max(migration_id) AS n FROM effect_sql_migrations").get(),
    ).toMatchObject({ n: 164 });
    expect(
      sql
        .prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'pages_room_*' ORDER BY name")
        .all(),
    ).toEqual([{ name: "pages_room_device_slots" }]);
    expect(sql.prepare("SELECT * FROM pages_room_device_slots").all()).toEqual([
      { original: "preserved" },
    ]);
  } finally {
    sql.close();
  }
  expect(legacyContents(file)).toEqual(legacyContents(template));
});

it("replays a populated private store without changing ciphertext, fences, pending delivery or installed state", async () => {
  const file = join(directory, "populated-replay.sqlite");
  await copyFile(migrated, file);
  const rows = (connection: DatabaseSync) =>
    tables.map((name) => connection.prepare(`SELECT * FROM ${name}`).all());
  const sql = db(file);
  const anchor = JSON.stringify({ room, bundleDigest: digest });
  const device = [...owner, "device"];
  let before: ReturnType<typeof rows>;
  try {
    sql.exec("BEGIN");
    sql
      .prepare("INSERT INTO pages_room_owner_slots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(...owner, "page", "sender", "local-default", 3, 5, 1, 0, 1, digest, digest);
    sql
      .prepare("INSERT INTO pages_room_owner_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        ...owner,
        digest,
        null,
        7,
        11,
        other,
        null,
        "A".repeat(43),
        anchor,
        JSON.stringify({ stream: { room } }),
        Uint8Array.from({ length: 32 }, (_, i) => i),
      );
    sql
      .prepare("INSERT INTO pages_room_owner_outbox VALUES(?,?,?,?,?,?,?,?)")
      .run(...owner, digest, 3, 0);
    sql
      .prepare("INSERT INTO pages_room_device_slots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(...device, 4, 6, 1, digest, 1, 2);
    sql
      .prepare("INSERT INTO pages_room_device_installs VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(...device, 2, digest, other, anchor, Uint8Array.of(255, 0, 17));
    sql.exec("DELETE FROM effect_sql_migrations WHERE migration_id>=165; COMMIT");
    before = rows(sql);
  } finally {
    sql.close();
  }
  expect(await start(file)).toEqual([{ migration_id: 165, name: "PageRoomPrivateStores" }]);
  const reopened = db(file);
  try {
    expect(rows(reopened)).toEqual(before);
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      reopened.exec("UPDATE pages_room_owner_publications SET ciphertext=ciphertext"),
    ).toThrow(/immutable/u);
  } finally {
    reopened.close();
  }
});

it("rejects a same-name replacement for an immutable-publication trigger on replay", async () => {
  const file = join(directory, "trigger-collision.sqlite");
  await copyFile(migrated, file);
  const sql = db(file);
  try {
    sql.exec(`DROP TRIGGER pages_room_publication_immutable;
      CREATE TRIGGER pages_room_publication_immutable BEFORE UPDATE ON pages_room_owner_publications
        BEGIN SELECT 1; END;
      DELETE FROM effect_sql_migrations WHERE migration_id>=165;`);
  } finally {
    sql.close();
  }
  await expect(start(file)).rejects.toThrow();
  const reopened = db(file);
  try {
    expect(
      reopened.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get(),
    ).toMatchObject({ id: 164 });
  } finally {
    reopened.close();
  }
});

it("enforces byte limits, immutable ciphertext, complete binding FKs and known-slot monotonicity", async () => {
  const file = join(directory, "constraints.sqlite");
  await copyFile(migrated, file);
  const sql = db(file);
  try {
    const addOwner = sql.prepare(
      "INSERT INTO pages_room_owner_slots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    addOwner.run(...owner, "page", "sender", "local-default", 1, 1, 1, 1, 0, null, null);
    const encoded = JSON.stringify({ room, bundleDigest: digest });
    const frame = JSON.stringify({ stream: { room } });
    const put = sql.prepare(
      "INSERT INTO pages_room_owner_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const pack = (
      cipher: Uint8Array | string = new Uint8Array(16),
      anchor = encoded,
      key: readonly (string | number)[] = owner,
    ) => put.run(...key, digest, null, 1, 0, other, null, "A".repeat(43), anchor, frame, cipher);
    expect(() => pack("x".repeat(16))).toThrow();
    expect(() => pack(new Uint8Array(15))).toThrow();
    expect(() => pack(new Uint8Array(262161))).toThrow();
    expect(() =>
      pack(
        new Uint8Array(16),
        JSON.stringify({ room, bundleDigest: digest, text: "界".repeat(1450) }),
      ),
    ).toThrow();
    expect(() =>
      pack(
        new Uint8Array(16),
        JSON.stringify({ room: { ...room, tenantRef: "other" }, bundleDigest: digest }),
      ),
    ).toThrow();
    expect(() => pack(new Uint8Array(16), encoded, ["other-profile", ...owner.slice(1)])).toThrow();
    pack(new Uint8Array(262160));
    expect(() =>
      sql.exec("UPDATE pages_room_owner_publications SET ciphertext=ciphertext"),
    ).toThrow(/immutable/u);
    const outbox = sql.prepare("INSERT INTO pages_room_owner_outbox VALUES(?,?,?,?,?,?,?,?)");
    for (const key of [
      ["other", ...owner.slice(1)],
      [owner[0], "other", ...owner.slice(2)],
      [...owner.slice(0, 3), "other", 1],
      [...owner.slice(0, 4), 2],
    ]) {
      expect(() => outbox.run(...key, digest, 1, 0)).toThrow();
    }
    outbox.run(...owner, digest, 1, 0);
    expect(() => sql.exec("DELETE FROM pages_room_owner_publications")).toThrow();
    sql
      .prepare("UPDATE pages_room_owner_slots SET head_digest=?,published_once=1,genesis_allowed=0")
      .run(digest);
    expect(() => sql.exec("UPDATE pages_room_owner_slots SET sender_ref='new-owner'")).toThrow();
    expect(() =>
      sql.exec("UPDATE pages_room_owner_slots SET published_once=0,head_digest=NULL"),
    ).toThrow();
    expect(() => sql.exec("DELETE FROM pages_room_owner_slots")).toThrow();
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sql.close();
  }
});

it("keeps device version and floor aligned and prevents deletion of a floor-referenced older blob", async () => {
  const file = join(directory, "floor.sqlite");
  await copyFile(migrated, file);
  const sql = db(file);
  try {
    sql
      .prepare("INSERT INTO pages_room_owner_slots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(...owner, "page", "sender", "local-default", 1, 1, 1, 1, 0, null, null);
    sql
      .prepare("INSERT INTO pages_room_owner_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        ...owner,
        digest,
        null,
        1,
        0,
        other,
        null,
        "A".repeat(43),
        JSON.stringify({ room, bundleDigest: digest }),
        JSON.stringify({ stream: { room } }),
        new Uint8Array(16),
      );
    const device = [...owner, "device"];
    sql
      .prepare("INSERT INTO pages_room_device_slots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(...device, 1, 1, 1, digest, 0, 0);
    const put = sql.prepare("INSERT INTO pages_room_device_installs VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const floor = JSON.stringify({ room, bundleDigest: digest });
    expect(() => put.run(...device, 1, digest, other, floor, new Uint8Array(1))).toThrow();
    sql.exec("BEGIN");
    expect(() =>
      put.run(
        ...device,
        1,
        digest,
        other,
        JSON.stringify({ room, bundleDigest: other }),
        new Uint8Array(1),
      ),
    ).toThrow();
    expect(() => put.run(...device, 1, digest, other, floor, new Uint8Array(4194305))).toThrow();
    expect(() =>
      put.run(
        ...device,
        1,
        digest,
        other,
        JSON.stringify({ room, bundleDigest: digest, x: "界".repeat(1400) }),
        new Uint8Array(1),
      ),
    ).toThrow();
    put.run(...device, 1, digest, other, floor, new Uint8Array(4194304));
    sql.exec("UPDATE pages_room_device_slots SET installed_once=1,install_version=1; COMMIT");
    expect(() => sql.exec("DELETE FROM pages_room_owner_publications")).toThrow(/referenced/u);
    expect(() => sql.exec("UPDATE pages_room_device_slots SET active=0")).toThrow();
    expect(() =>
      sql.exec("UPDATE pages_room_device_slots SET install_version=0,installed_once=0"),
    ).toThrow();
    expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sql.close();
  }
});
