import { type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { writeFileStringAtomically } from "../../../../atomicWrite";
import { readPageDoc } from "../../pageYjsContent";
import type { RoomKeyProvider } from "../roomEnvelope";
import type { RoomBinding } from "../roomEnvelopeProtocol";
import type { RecoveryAnchor } from "../roomRecoveryProtocol";
import { createRoomRecoveryAuthority } from "../roomRecoveryBundle";
import type { makeRoomPrivateStorage } from "../roomPrivateStorage";
import { type openRoomControlClient } from "./roomControlClient";
import { observeConfirmedRoom, publishRoomCheckpoint } from "./roomCheckpointSync";
import {
  claimBytes,
  digest,
  encryptRecoveryBody,
  hex,
  ref,
  type RecoveryManifest,
  RECOVERY_BODY_BYTES,
} from "./accountRecoveryCrypto";
import { publicSpki, reject, signBytes } from "./roomControlProtocol";
import type {
  AccountPageRecoveryContext,
  AccountRecoveryPublicationApi,
  AccountRecoveryTarget,
  AccountRecoverablePage,
} from "./accountPageRecovery";
import { recoveryCall } from "./accountPageRecoveryClient";
import type { AccountRecoveryTransport } from "./accountRecoveryAuthority";

type Local = NonNullable<Effect.Success<ReturnType<typeof makeRoomPrivateStorage>>>;
export interface RecoveryOwnerRoom {
  spaceId: string;
  pageId: string;
  room: RoomBinding;
  keys: RoomKeyProvider;
  signer: KeyObject;
  local: Local;
  control: NonNullable<ReturnType<typeof openRoomControlClient>>;
}
export interface RecoveryPublisherConfig {
  stateDir: string;
  sql: SqlClient.SqlClient;
  transport: AccountRecoveryTransport;
  rooms: readonly RecoveryOwnerRoom[];
  /** Returns the real PageSpaceSync active consent. A changed identity or Space must abort it. */
  recoveryConsent(target: AccountRecoveryTarget): AbortSignal | null;
  /** Fresh local account context for normal P3 publication, independent of an earlier menu RPC. */
  currentContext(target: AccountRecoveryTarget): Promise<AccountPageRecoveryContext | null>;
}
export type RecoveryPublisherProvision = Omit<RecoveryPublisherConfig, "transport">;
interface Ledger {
  consent: string;
  wrappingKey: string;
  stopping: boolean;
  items: AccountRecoverablePage[];
}
const ledgerPath = (
  cfg: RecoveryPublisherConfig,
  ctx: AccountPageRecoveryContext,
  target: AccountRecoveryTarget,
) => {
  if (target.scopeSpaceId !== null || !ref(target.spaceId) || !hex(ctx.tenantRef)) return reject();
  return join(
    cfg.stateDir,
    "page-account-backup-" +
      digest(JSON.stringify([1, ctx.realm, ctx.tenantRef, target.spaceId])) +
      ".json",
  );
};
async function readLedger(filename: string): Promise<Ledger | null> {
  try {
    const st = await lstat(filename);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size < 1 || st.size > 64_000)
      return reject();
    const fd = await open(
      filename,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const s = await fd.stat();
      if (s.dev !== st.dev || s.ino !== st.ino || s.nlink !== 1 || s.size !== st.size)
        return reject();
      const buf = Buffer.alloc(st.size + 1);
      if ((await fd.read(buf, 0, buf.length, 0)).bytesRead !== st.size) return reject();
      const data = JSON.parse(buf.toString("utf8", 0, st.size));
      if (data === null) return null;
      if (
        !hex(data.consent) ||
        typeof data.wrappingKey !== "string" ||
        data.wrappingKey.length > 2048 ||
        typeof data.stopping !== "boolean" ||
        !Array.isArray(data.items) ||
        data.items.length > 64
      )
        return reject();
      return data;
    } finally {
      await fd.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const writeLedger = (file: string, data: Ledger | null) =>
  Effect.runPromise(
    writeFileStringAtomically({ filePath: file, mode: 0o600, contents: JSON.stringify(data) }),
  );
export function makeAccountRecoveryPublication(
  cfg: RecoveryPublisherConfig,
): AccountRecoveryPublicationApi & { close(): void } {
  if (cfg.rooms.length > 64) return reject();
  const stops: (() => void)[] = [],
    ongoing = new Set<string>(),
    writers = new Set<string>(),
    close = new AbortController();
  const bound = (ctx: AccountPageRecoveryContext, target: AccountRecoveryTarget) => {
    const consent = cfg.recoveryConsent(target);
    if (!consent || consent.aborted || close.signal.aborted) return reject();
    const signal = AbortSignal.any([ctx.signal, consent, close.signal]);
    return {
      ...ctx,
      signal,
      assertCurrent() {
        ctx.assertCurrent();
        if (signal.aborted || cfg.recoveryConsent(target) !== consent) return reject();
      },
    };
  };
  async function page(r: RecoveryOwnerRoom) {
    const rows = await Effect.runPromise(cfg.sql<{
      title: string;
    }>`SELECT d.title FROM pages_documents d JOIN pages_spaces s ON s.space_id=d.space_id AND s.scope_key=d.scope_key
      WHERE d.page_id=${r.pageId} AND d.space_id=${r.spaceId} AND d.scope_key='local-default' AND d.kind='page' AND d.trashed_at IS NULL AND s.trashed_at IS NULL`);
    if (!rows[0]) return reject();
    return rows[0].title;
  }
  async function archive(
    r: RecoveryOwnerRoom,
    anchor: RecoveryAnchor,
  ): Promise<"inactive" | "confirmed"> {
    const target = { scopeSpaceId: null, spaceId: r.spaceId } as const;
    if (!cfg.recoveryConsent(target) || close.signal.aborted) return "inactive";
    const current = await cfg.currentContext(target);
    if (!current || current.tenantRef !== anchor.room.tenantRef) return "inactive";
    const ctx = bound(current, target),
      file = ledgerPath(cfg, ctx, target),
      local = await readLedger(file);
    if (!local || local.stopping) return "inactive";
    const key = file;
    if (ongoing.has(key)) return reject();
    ongoing.add(key);
    try {
      ctx.assertCurrent();
      const title = await page(r);
      const { view, bundle } = await r.control.fetchCheckpoint(anchor.bundleDigest);
      if (
        !view.owner ||
        view.pageId !== r.pageId ||
        view.scopeKey !== "local-default" ||
        view.head?.bundleDigest !== anchor.bundleDigest
      )
        return reject();
      const authority = createRoomRecoveryAuthority(r.keys, {
        capture(room) {
          const g = r.control.anchors.capture(room);
          if (!g || g.anchor.bundleDigest !== anchor.bundleDigest) return null;
          return { ...g, floor: null };
        },
      });
      const doc = new Y.Doc();
      try {
        const lease = await authority.acquireRoom(anchor.room, ctx.signal);
        const verifier = authority.openVerifier(authority.admit(lease));
        const candidate = await verifier.prepare(bundle, ctx.signal);
        const { update } = verifier.take(candidate);
        try {
          Y.applyUpdate(doc, update);
        } finally {
          update.fill(0);
        }
        const body = Buffer.from(
          parsePageRichContent(JSON.stringify(readPageDoc(doc))).richContent,
        );
        try {
          if (body.length > RECOVERY_BODY_BYTES || (await page(r)) !== title) return reject();
          ctx.assertCurrent();
          verifier.assertCurrent();
          const m: RecoveryManifest = {
            v: 1,
            scope: "local-default",
            realm: ctx.realm,
            tenantRef: ctx.tenantRef,
            spaceId: target.spaceId,
            pageId: r.pageId,
            room: anchor.room,
            title,
            anchor,
            bodyDigest: digest(body),
            consent: local.consent,
          };
          const sealed = encryptRecoveryBody(m, body, local.wrappingKey);
          const reply = await recoveryCall(cfg.transport, ctx, {
            op: "publish",
            backup: { ...sealed, signature: signBytes(r.signer, claimBytes(sealed)) },
          });
          if (
            reply.kind !== "confirmed" ||
            reply.item.pageId !== r.pageId ||
            reply.item.checkpointVersion !== anchor.checkpointVersion
          )
            return reject();
          const after = await readLedger(file);
          if (!after || after.stopping || after.consent !== local.consent) return reject();
          ctx.assertCurrent();
          await writeLedger(file, {
            ...after,
            items: [...after.items.filter((i) => i.pageId !== r.pageId), reply.item],
          });
          return "confirmed";
        } finally {
          body.fill(0);
        }
      } finally {
        doc.destroy();
        authority.close();
      }
    } finally {
      ongoing.delete(key);
    }
  }
  try {
    for (const r of cfg.rooms) {
      if (!ref(r.pageId) || !ref(r.spaceId) || !publicSpki(r.signer) || r.signer.type !== "private")
        return reject();
      stops.push(observeConfirmedRoom(r.local, r.room.roomId, (anchor) => archive(r, anchor)));
    }
  } catch (error) {
    for (const stop of stops) stop();
    throw error;
  }
  return {
    async status(ctx, target) {
      ctx.assertCurrent();
      const saved = await readLedger(ledgerPath(cfg, ctx, target));
      ctx.assertCurrent();
      const items = (saved?.items ?? []).filter((i) => Date.parse(i.expiresAt) > Date.now());
      return {
        state: items.length ? "confirmed" : "not-saved",
        allowed: !!saved,
        confirmedCount: items.length,
        lastConfirmedAt:
          items
            .map((i) => i.confirmedAt)
            .sort()
            .at(-1) ?? null,
      };
    },
    async saveConfirmed(ctx, target) {
      const active = bound(ctx, target),
        file = ledgerPath(cfg, ctx, target);
      if (writers.has(file) || ongoing.has(file)) return reject();
      writers.add(file);
      try {
        const rooms = cfg.rooms.filter(
          (r) => r.room.tenantRef === ctx.tenantRef && r.spaceId === target.spaceId,
        );
        if (!rooms.length) return reject();
        for (const r of rooms) await page(r);
        const existing = await readLedger(file);
        if (existing?.stopping) return reject();
        const ack = await recoveryCall(cfg.transport, active, {
          op: "allow",
          spaceId: target.spaceId,
        });
        if (ack.kind !== "allow" || !hex(ack.consent)) return reject();
        await writeLedger(file, {
          consent: ack.consent,
          wrappingKey: ack.wrappingKey,
          stopping: false,
          items: existing?.consent === ack.consent ? existing.items : [],
        });
        const confirmed = [];
        for (const r of rooms) {
          active.assertCurrent();
          const lease = await r.local.publisher.acquireRoom(r.room, active.signal);
          try {
            const result = await publishRoomCheckpoint(r.local, r.control, lease);
            if (!("accountBackup" in result) || result.accountBackup !== "confirmed")
              return reject();
            confirmed.push(result.anchor.bundleDigest);
          } finally {
            lease.close();
          }
        }
        return confirmed;
      } finally {
        writers.delete(file);
      }
    },
    async revoke(ctx, target) {
      const file = ledgerPath(cfg, ctx, target);
      if (writers.has(file) || ongoing.has(file)) return reject();
      writers.add(file);
      try {
        const saved = await readLedger(file);
        if (saved) await writeLedger(file, { ...saved, stopping: true });
        const ack = await recoveryCall(cfg.transport, ctx, {
          op: "revoke",
          spaceId: target.spaceId,
        });
        if (ack.kind !== "revoked") return reject();
        if (saved) await writeLedger(file, null);
      } finally {
        writers.delete(file);
      }
    },
    close() {
      close.abort();
      for (const stop of stops) stop();
    },
  };
}
