import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute } from "node:path";
import {
  RemoteAccountVerifier,
  type RemoteAccountVerifierOptions,
} from "@moss/shared/accountTokenVerifier";
import {
  canonicalManifest,
  claimBytes,
  digest,
  hex,
  ref,
  recoveryIdFor,
  manifestBytes,
  publicWrappingKey,
  binary,
  type SealedBackup,
  type AccountRecoveryKms,
  type RecoveryRegistration,
} from "./accountRecoveryCrypto";
import { importSpki, verified, tenantRef, type ControlRealm, reject } from "./roomControlProtocol";
import type { AccountRecoverablePage } from "./accountPageRecovery";
import type { AccountRecoveryRuntimeShape } from "./accountRecoveryRuntime";

export type RecoveryCommand =
  | { op: "allow" | "revoke"; spaceId: string }
  | { op: "publish"; backup: SealedBackup }
  | { op: "list" }
  | { op: "release"; id: string; version: number; recipient: string }
  | { op: "validate"; id: string; version: number; manifestDigest: string };
export type RecoveryReply =
  | { kind: "allow"; consent: string; wrappingKey: string }
  | { kind: "revoked" | "valid" }
  | { kind: "list"; items: AccountRecoverablePage[] }
  | { kind: "confirmed"; item: AccountRecoverablePage }
  | { kind: "release"; backup: SealedBackup; delivery: string; ownerPublicKey: string };
export interface AccountRecoveryTransport {
  call(
    token: string,
    realm: ControlRealm,
    tenant: string,
    command: RecoveryCommand,
    signal: AbortSignal,
  ): Promise<RecoveryReply>;
}
type Row = {
  id: string;
  tenant: string;
  space: string;
  page: string;
  title: string;
  version: number;
  confirmed: number;
  expires: number;
  data: string;
  owner: string;
  size: number;
};
const item = (r: Row): AccountRecoverablePage => ({
  recoveryId: r.id,
  pageId: r.page,
  title: r.title,
  checkpointVersion: r.version,
  confirmedAt: new Date(r.confirmed).toISOString(),
  expiresAt: new Date(r.expires).toISOString(),
});
export interface RecoveryAuthorityConfig {
  file: string;
  realm: ControlRealm;
  kms: AccountRecoveryKms;
  auth: RemoteAccountVerifierOptions;
  /** Trusted service-side mapping. A publisher's body cannot select the Space or authority. */
  registeredHead(tenant: string, pageId: string): RecoveryRegistration | null;
  retentionMs: number;
  now?: () => number;
}
/** Build the hosted authority only from an explicitly configured authority
 * runtime. The desktop/client runtime never exposes a private KMS key. */
export function openAccountRecoveryAuthorityFromRuntime(
  config: Omit<RecoveryAuthorityConfig, "kms">,
  runtime: AccountRecoveryRuntimeShape,
) {
  if (runtime.health.role !== "authority" || runtime.health.state !== "ready" || !runtime.kms)
    return null;
  return openAccountRecoveryAuthority({ ...config, kms: runtime.kms });
}
export function openAccountRecoveryAuthority(input?: RecoveryAuthorityConfig) {
  const config = input;
  if (!config) return null;
  const authorityConfig: RecoveryAuthorityConfig = config;
  if (
    !isAbsolute(authorityConfig.file) ||
    basename(authorityConfig.file) !== "account-recovery.sqlite" ||
    !Number.isSafeInteger(authorityConfig.retentionMs) ||
    authorityConfig.retentionMs < 1 ||
    authorityConfig.retentionMs > 366 * 86_400_000 ||
    new URL(authorityConfig.auth.url).protocol !== "https:"
  )
    return reject();
  publicWrappingKey(authorityConfig.kms.publicKey);
  const verify = new RemoteAccountVerifier({
      ...authorityConfig.auth,
      ttlMs: 0,
      negativeTtlMs: 0,
    }),
    now = authorityConfig.now ?? Date.now;
  const db = new DatabaseSync(authorityConfig.file);
  const identity = JSON.stringify([
    1,
    authorityConfig.realm,
    new URL(authorityConfig.auth.url).origin,
    digest(authorityConfig.kms.publicKey),
  ]);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS authority(identity TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS grants(tenant TEXT,space TEXT,consent TEXT,PRIMARY KEY(tenant,space)); CREATE TABLE IF NOT EXISTS copies(id TEXT PRIMARY KEY, tenant TEXT, space TEXT,page TEXT,title TEXT,version INTEGER,confirmed INTEGER,expires INTEGER,data TEXT,owner TEXT,size INTEGER); CREATE INDEX IF NOT EXISTS copies_tenant ON copies(tenant,space)",
    );
    db.prepare(
      "INSERT INTO authority(identity) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM authority)",
    ).run(identity);
    if (db.prepare("SELECT identity FROM authority").get()?.identity !== identity) return reject();
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false,
    active = 0;
  const grant = (tenant: string, space: string) =>
    db.prepare("SELECT consent FROM grants WHERE tenant=? AND space=?").get(tenant, space)?.consent;
  const eligible = (tenant: string, id: string, version: number) => {
    if (!hex(id) || !Number.isSafeInteger(version) || version < 1) return reject();
    const row = db
      .prepare("SELECT * FROM copies WHERE tenant=? AND id=? AND version=? AND expires>?")
      .get(tenant, id, version, now()) as unknown as Row;
    if (!row) return reject();
    const backup = JSON.parse(row.data) as SealedBackup;
    if (grant(tenant, row.space) !== backup.manifest.consent) return reject();
    return { row, backup };
  };
  const call: AccountRecoveryTransport["call"] = async (token, realm, tenant, cmd, signal) => {
    if (
      closed ||
      active >= 16 ||
      !hex(tenant) ||
      realm !== authorityConfig.realm ||
      !token ||
      token.length > 16_384 ||
      signal.aborted
    )
      return reject();
    active++;
    try {
      const user = await verify.verify(token);
      if (closed || signal.aborted || !user.ok || tenantRef(realm, user.accountId) !== tenant)
        return reject();
      db.exec("BEGIN IMMEDIATE");
      try {
        const answer = execute(tenant, cmd);
        if (signal.aborted) return reject();
        db.exec("COMMIT");
        return answer;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      active--;
    }
  };
  function execute(tenant: string, cmd: RecoveryCommand): RecoveryReply {
    switch (cmd.op) {
      case "allow": {
        if (!ref(cmd.spaceId)) return reject();
        const existing = grant(tenant, cmd.spaceId);
        if (typeof existing === "string")
          return { kind: "allow", consent: existing, wrappingKey: authorityConfig.kms.publicKey };
        if (Number(db.prepare("SELECT count(*) n FROM grants WHERE tenant=?").get(tenant)?.n) >= 64)
          return reject();
        const consent = randomBytes(32).toString("hex");
        db.prepare("INSERT INTO grants VALUES(?,?,?)").run(tenant, cmd.spaceId, consent);
        return { kind: "allow", consent, wrappingKey: authorityConfig.kms.publicKey };
      }
      case "revoke": {
        if (!ref(cmd.spaceId)) return reject();
        db.prepare("DELETE FROM grants WHERE tenant=? AND space=?").run(tenant, cmd.spaceId);
        db.prepare("DELETE FROM copies WHERE tenant=? AND space=?").run(tenant, cmd.spaceId);
        return { kind: "revoked" };
      }
      case "publish": {
        const b = cmd.backup,
          m = canonicalManifest(b.manifest);
        if (
          m.realm !== authorityConfig.realm ||
          m.tenantRef !== tenant ||
          grant(tenant, m.spaceId) !== m.consent ||
          binary(b.iv, 12).length !== 12
        )
          return reject();
        const r = authorityConfig.registeredHead(tenant, m.pageId);
        if (
          !r ||
          r.realm !== authorityConfig.realm ||
          r.scopeKey !== "local-default" ||
          r.tenantRef !== tenant ||
          r.pageId !== m.pageId ||
          r.spaceId !== m.spaceId ||
          !manifestBytes(m).equals(manifestBytes({ ...m, anchor: r.anchor })) ||
          !verified(importSpki(r.ownerPublicKey), claimBytes(b), b.signature)
        )
          return reject();
        const id = recoveryIdFor(tenant, m.pageId);
        const old = db.prepare("SELECT * FROM copies WHERE id=?").get(id) as unknown as
          | Row
          | undefined;
        if (old && old.version >= m.anchor.checkpointVersion) {
          if (
            old.expires <= now() ||
            old.version !== m.anchor.checkpointVersion ||
            !manifestBytes(JSON.parse(old.data).manifest).equals(manifestBytes(m))
          )
            return reject();
          return { kind: "confirmed", item: item(old) };
        }
        const data = JSON.stringify({
            manifest: m,
            cipher: b.cipher,
            wrapped: b.wrapped,
            signature: b.signature,
            iv: b.iv,
          }),
          size = Buffer.byteLength(data);
        const totals = db
          .prepare(
            "SELECT count(*) n, coalesce(sum(size),0) bytes FROM copies WHERE tenant=? AND id<>?",
          )
          .get(tenant, id);
        if (Number(totals?.n) >= 64 || Number(totals?.bytes) + size > 64 * 1024 * 1024)
          return reject();
        const confirmed = now(),
          expires = confirmed + authorityConfig.retentionMs;
        db.prepare("INSERT OR REPLACE INTO copies VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
          id,
          tenant,
          m.spaceId,
          m.pageId,
          m.title,
          m.anchor.checkpointVersion,
          confirmed,
          expires,
          data,
          r.ownerPublicKey,
          size,
        );
        return {
          kind: "confirmed",
          item: item({
            ...old,
            id,
            page: m.pageId,
            title: m.title,
            version: m.anchor.checkpointVersion,
            confirmed,
            expires,
          } as Row),
        };
      }
      case "list": {
        const rows = db
          .prepare(
            "SELECT id,page,title,version,confirmed,expires FROM copies JOIN grants USING(tenant,space) WHERE tenant=? AND expires>? ORDER BY confirmed DESC,id LIMIT 64",
          )
          .all(tenant, now()) as unknown as Row[];
        return { kind: "list", items: rows.map(item) };
      }
      case "release": {
        const { row, backup } = eligible(tenant, cmd.id, cmd.version);
        publicWrappingKey(cmd.recipient);
        const delivery = authorityConfig.kms.rewrap(backup.manifest, backup.wrapped, cmd.recipient);
        return { kind: "release", backup, delivery, ownerPublicKey: row.owner };
      }
      case "validate": {
        const { backup } = eligible(tenant, cmd.id, cmd.version);
        if (cmd.manifestDigest !== digest(manifestBytes(backup.manifest))) return reject();
        return { kind: "valid" };
      }
      default:
        return reject();
    }
  }
  return {
    call,
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
