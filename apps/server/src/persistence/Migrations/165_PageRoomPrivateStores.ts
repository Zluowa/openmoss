import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// All identifiers below are fixed migration constants. API data never enters
// the DDL. Byte limits also apply to UTF-8 JSON/TEXT, not just character counts.
const id = (name: string) =>
  `${name} TEXT NOT NULL CHECK(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND 128 AND instr(${name},char(0))=0 AND ${name} NOT GLOB '*[^A-Za-z0-9_-]*')`;
const uint = (name: string, minimum = 0) =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN ${minimum} AND 9007199254740991)`;
const flag = (name: string) =>
  `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} IN (0,1))`;
const digest = (name: string, nullable = false) =>
  `${name} TEXT ${nullable ? "" : "NOT NULL"} CHECK(${nullable ? `${name} IS NULL OR ` : ""}(typeof(${name})='text' AND length(CAST(${name} AS BLOB))=64 AND instr(${name},char(0))=0 AND ${name} NOT GLOB '*[^0-9a-f]*'))`;
const json = (name: string, limit: number) =>
  `${name} TEXT NOT NULL CHECK(CASE WHEN typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN 2 AND ${limit} THEN json_valid(${name}) AND json_type(${name})='object' ELSE 0 END)`;
const blob = (name: string, min: number, max: number) =>
  `${name} BLOB NOT NULL CHECK(typeof(${name})='blob' AND length(${name}) BETWEEN ${min} AND ${max})`;
const binding = `${id("profile_ref")},${id("tenant_ref")},${id("room_id")},${id("document_generation")},${uint("key_epoch")}`;
const ownerKey = "profile_ref,tenant_ref,room_id,document_generation,key_epoch";
const deviceKey = `${ownerKey},device_ref`;
const changed = (key: string) =>
  key
    .split(",")
    .map((field) => `NEW.${field} IS NOT OLD.${field}`)
    .join(" OR ");
const sameRoom = (field: string, position: string) =>
  [
    ["tenantRef", "tenant_ref"],
    ["roomId", "room_id"],
    ["documentGeneration", "document_generation"],
    ["keyEpoch", "key_epoch"],
  ]
    .map(([property, column]) => `json_extract(${field},'$.${position}.${property}') IS ${column}`)
    .join(" AND ");

/** Empty, profile-private stores. Enrollment/fences come from an independent
 * trusted authority. Neither migration nor opening the profile issues a grant.
 * Slots survive revoke; a missing known head/install cannot become a new room.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A reconciled ledger can legitimately replay 165 over populated stores.
  // Accept the original DDL only: ignoring a same-name table or no-op trigger
  // could silently remove the fence or the immutable-publication guarantee.
  const create = (kind: "TABLE" | "INDEX" | "TRIGGER", name: string, definition: string) =>
    Effect.gen(function* () {
      const ddl = `CREATE ${kind} ${name} ${definition}`;
      const existing = yield* sql<{ sql: string | null }>`
        SELECT sql FROM main.sqlite_schema WHERE name = ${name} COLLATE NOCASE
      `;
      if (existing.length === 0) {
        yield* sql.unsafe(ddl);
      } else if (existing.length !== 1 || existing[0]?.sql !== ddl) {
        return yield* Effect.fail(new Error(`Unexpected schema for room object ${name}`));
      }
    });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* create(
        "TABLE",
        "pages_room_owner_slots",
        `(
      ${binding},${id("page_id")},${id("sender_ref")},
      scope_key TEXT NOT NULL CHECK(typeof(scope_key)='text' AND length(CAST(scope_key AS BLOB)) BETWEEN 1 AND 142 AND instr(scope_key,char(0))=0
        AND (scope_key='local-default' OR (substr(scope_key,1,14)='project-space:' AND length(scope_key)>14 AND substr(scope_key,15) NOT GLOB '*[^A-Za-z0-9_-]*'))),
      ${uint("fence", 1)},${uint("authority_version", 1)},${flag("active")},${flag("genesis_allowed")},${flag("published_once")},
      ${digest("head_digest", true)},${digest("confirmed_digest", true)},
      CHECK((published_once=0 AND head_digest IS NULL) OR (published_once=1 AND head_digest IS NOT NULL AND genesis_allowed=0)),
      CHECK(active=1 OR genesis_allowed=0),
      PRIMARY KEY(${ownerKey}),
      FOREIGN KEY(${ownerKey},head_digest) REFERENCES pages_room_owner_publications(${ownerKey},bundle_digest) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    )`,
      );
      yield* create(
        "TABLE",
        "pages_room_owner_publications",
        `(
      ${binding},${digest("bundle_digest")},${digest("prior_head_digest", true)},${uint("source_revision", 1)},${uint("source_sequence")},
      ${digest("source_digest")},${digest("previous_commit_digest", true)},
      receipt_salt TEXT NOT NULL CHECK(typeof(receipt_salt)='text' AND length(CAST(receipt_salt AS BLOB))=43 AND instr(receipt_salt,char(0))=0 AND receipt_salt NOT GLOB '*[^A-Za-z0-9_-]*'
        AND substr(receipt_salt,43,1) GLOB '[AEIMQUYcgkosw048]'),
      ${json("anchor_json", 4096)},${json("frame_json", 2048)},${blob("ciphertext", 16, 262160)},
      CHECK(${sameRoom("anchor_json", "room")} AND json_extract(anchor_json,'$.bundleDigest') IS bundle_digest),
      CHECK(${sameRoom("frame_json", "stream.room")}),
      PRIMARY KEY(${ownerKey},bundle_digest),
      FOREIGN KEY(${ownerKey}) REFERENCES pages_room_owner_slots(${ownerKey}) ON DELETE RESTRICT
    )`,
      );
      yield* create(
        "TABLE",
        "pages_room_owner_outbox",
        `(
      ${binding},${digest("bundle_digest")},${uint("fence", 1)},${flag("delivered")},
      PRIMARY KEY(${ownerKey}),
      FOREIGN KEY(${ownerKey},bundle_digest) REFERENCES pages_room_owner_publications(${ownerKey},bundle_digest) ON DELETE RESTRICT
    )`,
      );
      yield* create(
        "TABLE",
        "pages_room_device_slots",
        `(
      ${binding},${id("device_ref")},${uint("fence", 1)},${uint("authority_version", 1)},${flag("active")},${digest("approved_anchor_digest")},
      ${flag("installed_once")},${uint("install_version")},
      CHECK((installed_once=0 AND install_version=0) OR (installed_once=1 AND install_version>0)),
      PRIMARY KEY(${deviceKey}), UNIQUE(${deviceKey},install_version)
    )`,
      );
      yield* create(
        "TABLE",
        "pages_room_device_installs",
        `(
      ${binding},${id("device_ref")},${uint("install_version", 1)},${digest("bundle_digest")},${digest("state_digest")},
      ${json("floor_json", 4096)},${blob("state", 1, 4194304)},
      CHECK(${sameRoom("floor_json", "room")} AND json_extract(floor_json,'$.bundleDigest') IS bundle_digest),
      PRIMARY KEY(${deviceKey}),
      FOREIGN KEY(${deviceKey},install_version) REFERENCES pages_room_device_slots(${deviceKey},install_version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    )`,
      );
      // A locally retained device floor can pin an owner's older blob without
      // requiring that remotely obtained bundles exist in this owner's database.
      yield* create(
        "INDEX",
        "idx_pages_room_device_floor_blob",
        "ON pages_room_device_installs(tenant_ref,room_id,document_generation,key_epoch,bundle_digest)",
      );
      yield* create(
        "TRIGGER",
        "pages_room_publication_immutable",
        "BEFORE UPDATE ON pages_room_owner_publications BEGIN SELECT RAISE(ABORT,'immutable room publication'); END",
      );
      yield* create(
        "TRIGGER",
        "pages_room_publication_protect_floor",
        `BEFORE DELETE ON pages_room_owner_publications WHEN
      EXISTS(SELECT 1 FROM pages_room_device_installs WHERE tenant_ref=OLD.tenant_ref AND room_id=OLD.room_id AND document_generation=OLD.document_generation
        AND key_epoch=OLD.key_epoch AND bundle_digest=OLD.bundle_digest) OR
      EXISTS(SELECT 1 FROM pages_room_owner_slots WHERE profile_ref=OLD.profile_ref AND tenant_ref=OLD.tenant_ref AND room_id=OLD.room_id
        AND document_generation=OLD.document_generation AND key_epoch=OLD.key_epoch AND confirmed_digest=OLD.bundle_digest)
      BEGIN SELECT RAISE(ABORT,'room publication is referenced'); END`,
      );
      yield* create(
        "TRIGGER",
        "pages_room_owner_slot_guard",
        `BEFORE UPDATE ON pages_room_owner_slots WHEN
      ${changed(`${ownerKey},page_id,scope_key`)} OR NEW.fence<OLD.fence OR NEW.authority_version<OLD.authority_version OR NEW.published_once<OLD.published_once OR
      ((${changed("active,sender_ref")}) AND NEW.fence<=OLD.fence) OR
      ((${changed("active,sender_ref,fence,confirmed_digest")}) AND NEW.authority_version<=OLD.authority_version) OR
      (NEW.genesis_allowed>OLD.genesis_allowed AND NEW.authority_version<=OLD.authority_version)
      BEGIN SELECT RAISE(ABORT,'invalid room owner transition'); END`,
      );
      yield* create(
        "TRIGGER",
        "pages_room_device_slot_guard",
        `BEFORE UPDATE ON pages_room_device_slots WHEN
      ${changed(deviceKey)} OR NEW.fence<OLD.fence OR NEW.authority_version<OLD.authority_version OR NEW.install_version<OLD.install_version OR NEW.installed_once<OLD.installed_once OR
      (NEW.active<>OLD.active AND NEW.fence<=OLD.fence) OR
      ((${changed("active,fence,approved_anchor_digest")}) AND NEW.authority_version<=OLD.authority_version)
      BEGIN SELECT RAISE(ABORT,'invalid room device transition'); END`,
      );
      yield* create(
        "TRIGGER",
        "pages_room_owner_slot_tombstone",
        "BEFORE DELETE ON pages_room_owner_slots BEGIN SELECT RAISE(ABORT,'retain room owner fence'); END",
      );
      yield* create(
        "TRIGGER",
        "pages_room_device_slot_tombstone",
        "BEFORE DELETE ON pages_room_device_slots BEGIN SELECT RAISE(ABORT,'retain room device floor marker'); END",
      );
    }),
  );
});
