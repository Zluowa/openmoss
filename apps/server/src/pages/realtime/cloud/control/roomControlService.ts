import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute } from "node:path";
import { type KeyObject } from "node:crypto";
import {
  copyRoomBinding,
  envelopeReference,
  roomIdentity,
  type RoomBinding,
} from "../roomEnvelopeProtocol";
import {
  copyRecoveryAnchor,
  copyRecoveryBundle,
  copyRecoveryFloor,
  type RecoveryBundle,
} from "../roomRecoveryProtocol";
import { collectCipher, createCipherTable, readCipher, saveCipher } from "./roomCiphertextStore";
import { RemoteAccountVerifier } from "@moss/shared/accountTokenVerifier";
import {
  CONTROL_PROOF_TTL,
  MAX_CONTROL_DEVICES,
  copyLivePeer,
  livePeerReceipt,
  copyRequest,
  copyView,
  floorAt,
  freshNonce,
  importSpki,
  keyRef,
  parseWire,
  proofBytes,
  publicSpki,
  receiptBytes,
  reject,
  requestDigest,
  signBytes,
  tenantRef,
  verified,
  wire,
  type ControlRealm,
  type ControlView,
  type Request,
} from "./roomControlProtocol";

export interface RoomControlProvision {
  realm: ControlRealm;
  accountId: string;
  room: RoomBinding;
  pageId: string;
  scopeKey: string;
  ownerPublicKey: string;
  ownerProfileRef: string;
}
export interface RoomControlServiceConfig {
  file: string;
  signer: KeyObject;
  auth: { url: string; publishableKey: string; fetch: typeof fetch };
  provision: RoomControlProvision;
  ciphertext?: boolean;
  live?: boolean;
}
interface RoomState {
  revision: number;
  head_json: string | null;
  present: number;
  prior_bundle: string | null;
  prior_commit: string | null;
}
interface Member {
  device_ref: string;
  public_key: string;
  profile_ref: string;
  owner: number;
  active: number;
  fence: number;
  version: number;
  floor_json: string | null;
}
const APPLICATION_ID = 0x4d525031;
const checkedJson = (value: string) => parseWire(value);
const sameRoom = (a: RoomBinding, b: RoomBinding) => roomIdentity(a) === roomIdentity(b);

/** Explicit single-room prototype; separate authority DB and injected key.
 * No listener, migration, account creation or implicit provisioning on import. */
export function openRoomControlService(options?: RoomControlServiceConfig) {
  if (!options) return null;
  const config = options;
  const p = config.provision,
    room = copyRoomBinding(p.room),
    ownerPublicKey = publicSpki(importSpki(p.ownerPublicKey));
  const expectedTenant = tenantRef(p.realm, p.accountId),
    ownerRef = keyRef(importSpki(ownerPublicKey)),
    authority = keyRef(config.signer);
  if (
    room.tenantRef !== expectedTenant ||
    !isAbsolute(config.file) ||
    basename(config.file) !== "room-control-prototype.sqlite" ||
    config.signer.type !== "private" ||
    !/^(?:local-default|project-space:[A-Za-z0-9_-]{1,128})$/u.test(p.scopeKey)
  )
    return reject();
  const pageId = envelopeReference(p.pageId),
    profile = envelopeReference(p.ownerProfileRef),
    scopeKey = p.scopeKey,
    realm = p.realm;
  const issuer = new URL(config.auth.url);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    typeof config.auth.fetch !== "function"
  )
    return reject();
  const verifier = new RemoteAccountVerifier({ ...config.auth, ttlMs: 0, negativeTtlMs: 0 });
  const dataMode = config.ciphertext === true,
    live = config.live === true;
  const identity = wire([
    1,
    realm,
    issuer.href,
    room,
    authority,
    pageId,
    scopeKey,
    ownerRef,
    profile,
    ...(dataMode ? ["checkpoint-data-v1"] : []),
    ...(live ? ["live-enrollment-v1"] : []),
  ]);
  const db = new DatabaseSync(config.file);
  const txn = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Original failure remains private. */
      }
      throw error;
    }
  };
  try {
    const tag = Number(db.prepare("PRAGMA application_id").get()?.application_id);
    const existing = db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
    if (tag !== APPLICATION_ID && (tag !== 0 || existing)) return reject();
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000",
    );
    if (tag === 0)
      txn(() => {
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        CREATE TABLE proto_control_room(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
          prior_bundle TEXT,prior_commit TEXT,head_json TEXT CHECK(head_json IS NULL OR (typeof(head_json)='text' AND length(CAST(head_json AS BLOB))<=4096)));
        CREATE TABLE proto_control_device(device_ref TEXT PRIMARY KEY,public_key TEXT NOT NULL,profile_ref TEXT NOT NULL,owner INTEGER NOT NULL CHECK(owner IN(0,1)),
          active INTEGER NOT NULL CHECK(active IN(0,1)),fence INTEGER NOT NULL CHECK(fence>0),version INTEGER NOT NULL CHECK(version>=0),
          floor_json TEXT CHECK(floor_json IS NULL OR (typeof(floor_json)='text' AND length(CAST(floor_json AS BLOB))<=4096)),
          CHECK((version=0 AND floor_json IS NULL) OR (version>0 AND floor_json IS NOT NULL)));`);
        if (dataMode) createCipherTable(db);
        if (live)
          db.exec(
            "CREATE TABLE proto_live_rights(device_ref TEXT PRIMARY KEY REFERENCES proto_control_device(device_ref),mode TEXT NOT NULL CHECK(mode IN ('edit','view')))",
          );
        db.prepare("INSERT INTO proto_control_room VALUES(1,?,1,NULL,NULL,NULL)").run(identity);
        db.prepare("INSERT INTO proto_control_device VALUES(?,?,?,1,1,1,0,NULL)").run(
          ownerRef,
          ownerPublicKey,
          profile,
        );
        if (live) db.prepare("INSERT INTO proto_live_rights VALUES(?,'edit')").run(ownerRef);
      });
    const saved = db.prepare("SELECT identity FROM proto_control_room WHERE id=1").get()?.identity;
    if (
      dataMode &&
      !db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='proto_ciphertext'")
        .get()
    )
      return reject();
    if (
      live &&
      !db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='proto_live_rights'")
        .get()
    )
      return reject();
    if (saved !== identity || db.prepare("PRAGMA user_version").get()?.user_version !== 1)
      return reject();
  } catch {
    db.close();
    return reject();
  }
  const member = (ref: string): Member | undefined =>
    db
      .prepare(`SELECT device_ref,public_key,profile_ref,owner,active,fence,version,
    CASE WHEN length(CAST(floor_json AS BLOB))<=4096 THEN floor_json END AS floor_json FROM proto_control_device WHERE device_ref=?`)
      .get(ref) as Member | undefined;
  const state = (): RoomState => {
    const row = db
      .prepare(
        `SELECT revision,head_json IS NOT NULL AS present,prior_bundle,prior_commit,CASE WHEN length(CAST(head_json AS BLOB))<=4096 THEN head_json END AS head_json FROM proto_control_room WHERE id=1`,
      )
      .get();
    if (
      !row ||
      typeof row.revision !== "number" ||
      typeof row.present !== "number" ||
      (row.prior_bundle !== null && typeof row.prior_bundle !== "string") ||
      (row.prior_commit !== null && typeof row.prior_commit !== "string") ||
      (row.head_json !== null && typeof row.head_json !== "string")
    )
      return reject();
    return {
      revision: row.revision,
      present: row.present,
      prior_bundle: row.prior_bundle,
      prior_commit: row.prior_commit,
      head_json: row.head_json,
    };
  };
  const view = (m: Member, s: RoomState): ControlView => {
    if (!!s.present !== !!s.head_json) return reject();
    const floor = m.floor_json ? copyRecoveryFloor(checkedJson(m.floor_json)) : null;
    if ((m.version === 0) !== (floor === null)) return reject();
    const pending = dataMode
      ? db
          .prepare(`SELECT CASE WHEN length(CAST(c.anchor_json AS BLOB))<=4096 THEN c.anchor_json END AS anchor
      FROM proto_cipher_device_pin p LEFT JOIN proto_ciphertext c ON c.digest=p.digest WHERE p.device_ref=?`)
          .get(m.device_ref)
      : undefined;
    if (pending && typeof pending.anchor !== "string") return reject();
    return copyView(
      {
        ...(dataMode
          ? { pending: pending ? copyRecoveryAnchor(checkedJson(pending.anchor as string)) : null }
          : {}),
        owner: !!m.owner,
        profileRef: m.profile_ref,
        scopeKey,
        pageId,
        fence: m.fence,
        revision: s.revision,
        head: s.head_json ? copyRecoveryAnchor(checkedJson(s.head_json)) : null,
        accepted: floor ? { version: m.version, floor } : null,
      },
      room,
    );
  };
  const bump = (s: RoomState) => {
    if (
      !Number.isSafeInteger(s.revision + 1) ||
      db
        .prepare("UPDATE proto_control_room SET revision=revision+1 WHERE id=1 AND revision=?")
        .run(s.revision).changes !== 1
    )
      return reject();
  };
  function apply(r: Request, m: Member, s: RoomState) {
    const v = view(m, s),
      head = v.head,
      op = r.operation;
    switch (op.kind) {
      case "read":
      case "fetch":
      case "live-peer":
        return;
      case "grant-live": {
        const target = member(op.deviceRef);
        if (!live || !m.owner || !target?.active || target.owner || op.expected !== s.revision)
          return reject();
        bump(s);
        if (op.mode === "none")
          db.prepare("DELETE FROM proto_live_rights WHERE device_ref=?").run(target.device_ref);
        else
          db.prepare(
            "INSERT INTO proto_live_rights VALUES(?,?) ON CONFLICT(device_ref) DO UPDATE SET mode=excluded.mode",
          ).run(target.device_ref, op.mode);
        return;
      }
      case "publish": {
        const a = op.anchor;
        if (
          !m.owner ||
          !sameRoom(a.room, room) ||
          a.coveredCommitIndex !== a.tailEndCommitIndex ||
          a.tailHeadDigest !== a.coveredCommitDigest ||
          a.checkpointVersion !== a.coveredCommitIndex + 1
        )
          return reject();
        if (head?.bundleDigest === a.bundleDigest) {
          if (
            JSON.stringify(a) !== JSON.stringify(head) ||
            op.expected !== s.prior_bundle ||
            op.previousCommit !== s.prior_commit
          )
            return reject();
          return;
        }
        if (
          (head?.bundleDigest ?? null) !== op.expected ||
          (head?.tailHeadDigest ?? null) !== op.previousCommit ||
          a.checkpointVersion !== (head?.checkpointVersion ?? 0) + 1 ||
          a.coveredCommitIndex !== (head?.coveredCommitIndex ?? -1) + 1 ||
          a.checkpointId === head?.checkpointId ||
          a.coveredCommitDigest === head?.coveredCommitDigest
        )
          return reject();
        bump(s);
        db.prepare(
          "UPDATE proto_control_room SET head_json=?,prior_bundle=?,prior_commit=? WHERE id=1",
        ).run(wire(a), op.expected, op.previousCommit);
        return;
      }
      case "accept": {
        if (op.expected > m.version) return reject();
        if (v.accepted?.floor.bundleDigest === op.digest) {
          if (op.expected !== m.version && op.expected !== m.version - 1) return reject();
          return;
        }
        const source = dataMode ? v.pending : head;
        if (
          !source ||
          source.bundleDigest !== op.digest ||
          op.expected !== m.version ||
          !Number.isSafeInteger(m.version + 1)
        )
          return reject();
        bump(s);
        db.prepare(
          "UPDATE proto_control_device SET version=version+1,floor_json=? WHERE device_ref=?",
        ).run(wire(floorAt(source)), m.device_ref);
        if (dataMode)
          db.prepare("DELETE FROM proto_cipher_device_pin WHERE device_ref=? AND digest=?").run(
            m.device_ref,
            op.digest,
          );
        return;
      }
      case "enroll": {
        if (!m.owner || op.expected !== s.revision) return reject();
        const ref = keyRef(importSpki(op.publicKey));
        if (
          member(ref) ||
          Number(db.prepare("SELECT count(*) n FROM proto_control_device").get()?.n) >=
            MAX_CONTROL_DEVICES
        )
          return reject();
        bump(s);
        db.prepare("INSERT INTO proto_control_device VALUES(?,?,?,0,1,1,0,NULL)").run(
          ref,
          op.publicKey,
          op.profileRef,
        );
        return;
      }
      case "revoke": {
        const victim = member(op.deviceRef);
        if (!m.owner || !victim?.active || victim.owner || op.expected !== s.revision)
          return reject();
        bump(s);
        db.prepare(
          "UPDATE proto_control_device SET active=0,fence=fence+1 WHERE device_ref=? AND active=1",
        ).run(victim.device_ref);
        if (dataMode)
          db.prepare("DELETE FROM proto_cipher_device_pin WHERE device_ref=?").run(
            victim.device_ref,
          );
        return;
      }
    }
  }
  let closed = false,
    verifying = 0;
  const pending = new Map<string, { keyRef: string; intent: string; expires: number }>();
  const authorize = async (token: string, r: Request) => {
    if (
      closed ||
      verifying >= 32 ||
      typeof token !== "string" ||
      !/^[\x21-\x7e]{1,16384}$/u.test(token) ||
      !sameRoom(r.room, room)
    )
      return reject();
    verifying++;
    try {
      const user = await verifier.verify(token);
      if (
        closed ||
        !user.ok ||
        tenantRef(realm, user.accountId) !== expectedTenant ||
        !member(r.keyRef)?.active
      )
        return reject();
    } catch {
      return reject();
    } finally {
      verifying--;
    }
  };
  async function finishProof(
    token: string,
    requestWire: string,
    challenge: string,
    signature: string,
    data?: { bundle?: RecoveryBundle },
  ) {
    if (closed || typeof challenge !== "string" || challenge.length !== 43) return reject();
    const r = copyRequest(parseWire(requestWire)),
      item = pending.get(challenge);
    if (!item || item.intent !== requestDigest(r) || item.keyRef !== r.keyRef) return reject();
    const op = r.operation,
      incoming = data?.bundle === undefined ? undefined : copyRecoveryBundle(data.bundle);
    if (data !== undefined && (!dataMode || (op.kind !== "publish" && op.kind !== "fetch")))
      return reject();
    if (
      (op.kind === "fetch" && (!dataMode || data === undefined || incoming)) ||
      (op.kind === "publish" && dataMode && !incoming)
    )
      return reject();
    pending.delete(challenge);
    await authorize(token, r);
    return txn(() => {
      const m = member(r.keyRef);
      if (
        !m?.active ||
        performance.now() >= item.expires ||
        !verified(importSpki(m.public_key), proofBytes(authority, r, challenge), signature)
      )
        return reject();
      const before = state(),
        old = view(m, before);
      if (op.kind === "publish" && dataMode) {
        if (!m.owner || !incoming) return reject();
        if (old.head?.bundleDigest === op.anchor.bundleDigest)
          readCipher(db, op.anchor.bundleDigest, ownerRef);
        saveCipher(db, incoming, op.anchor, ownerRef);
      }
      let bundle: RecoveryBundle | undefined;
      if (op.kind === "fetch") {
        if (
          op.digest !== old.accepted?.floor.bundleDigest &&
          op.digest !== (old.pending ?? old.head)?.bundleDigest
        )
          return reject();
        bundle = readCipher(db, op.digest, ownerRef);
        if (
          !old.pending &&
          op.digest === old.head?.bundleDigest &&
          op.digest !== old.accepted?.floor.bundleDigest
        ) {
          bump(before);
          db.prepare("INSERT INTO proto_cipher_device_pin VALUES(?,?)").run(
            m.device_ref,
            op.digest,
          );
        }
      }
      apply(r, m, before);
      if (dataMode && (op.kind === "publish" || op.kind === "accept" || op.kind === "revoke"))
        collectCipher(db);
      const current = member(r.keyRef);
      if (!current?.active) return reject();
      const result = view(current, state());
      const receiptSignature = signBytes(
        config.signer,
        receiptBytes(authority, r, challenge, result),
      );
      if (op.kind === "live-peer") {
        const target = member(op.deviceRef);
        if (!live || !target?.active || !!target.owner === !!m.owner) return reject();
        const mode = (key: string) =>
          db.prepare("SELECT mode FROM proto_live_rights WHERE device_ref=?").get(key)?.mode;
        const peer = copyLivePeer({
          key: target.public_key,
          deviceRef: target.device_ref,
          owner: !!target.owner,
          localMode: mode(m.device_ref),
          peerMode: mode(target.device_ref),
          fence: target.fence,
        });
        const peerSignature = signBytes(
          config.signer,
          livePeerReceipt(authority, r, challenge, result, peer),
        );
        return {
          receipt: wire({ view: result, signature: receiptSignature, peer, peerSignature }),
          bundle,
        };
      }
      return { receipt: wire({ view: result, signature: receiptSignature }), bundle };
    });
  }
  return {
    authority,
    /** Private issuer-to-recovery-service lookup. */
    confirmedAccountRecoveryHead() {
      if (closed || !dataMode || scopeKey !== "local-default") return null;
      const registered = member(ownerRef),
        raw = state().head_json;
      if (!registered?.owner || !registered.active || !raw) return null;
      const anchor = copyRecoveryAnchor(checkedJson(raw));
      readCipher(db, anchor.bundleDigest, ownerRef);
      return {
        realm,
        tenantRef: expectedTenant,
        scopeKey,
        pageId,
        ownerPublicKey: p.ownerPublicKey,
        anchor,
      };
    },
    async begin(token: string, requestWire: string) {
      const r = copyRequest(parseWire(requestWire));
      await authorize(token, r);
      const now = performance.now();
      for (const [id, item] of pending) if (now >= item.expires) pending.delete(id);
      if (
        pending.size >= 256 ||
        [...pending.values()].filter((item) => item.keyRef === r.keyRef).length >= 16
      )
        return reject();
      const challenge = freshNonce();
      pending.set(challenge, {
        keyRef: r.keyRef,
        intent: requestDigest(r),
        expires: now + CONTROL_PROOF_TTL,
      });
      return challenge;
    },
    async finish(token: string, requestWire: string, challenge: string, signature: string) {
      return (await finishProof(token, requestWire, challenge, signature)).receipt;
    },
    finishCheckpoint(
      token: string,
      requestWire: string,
      challenge: string,
      signature: string,
      bundle?: RecoveryBundle,
    ) {
      return finishProof(token, requestWire, challenge, signature, bundle ? { bundle } : {});
    },
    close() {
      if (!closed) {
        closed = true;
        pending.clear();
        db.close();
      }
    },
  };
}
