import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { LOCAL_PAGES_PRINCIPAL, type PagesServiceShape } from "../../../Services/PagesService";
import {
  claimBytes,
  manifestBytes,
  canonicalManifest,
  decryptRecoveryBody,
  digest,
  hex,
  recoveryIdFor,
} from "./accountRecoveryCrypto";
import { importSpki, reject, verified } from "./roomControlProtocol";
import type { AccountPageRecoveryContext, AccountRecoveryApi } from "./accountPageRecovery";
import type { AccountRecoveryTransport, RecoveryCommand } from "./accountRecoveryAuthority";

export async function recoveryCall(
  transport: AccountRecoveryTransport,
  ctx: AccountPageRecoveryContext,
  cmd: RecoveryCommand,
) {
  ctx.assertCurrent();
  if (ctx.signal.aborted) return reject();
  const token = await ctx.currentCredential();
  ctx.assertCurrent();
  const reply = await transport.call(token, ctx.realm, ctx.tenantRef, cmd, ctx.signal);
  ctx.assertCurrent();
  if (ctx.signal.aborted) return reject();
  return reply;
}
export function makeAccountPageRecovery(
  transport: AccountRecoveryTransport,
  sql: SqlClient.SqlClient,
  pages: PagesServiceShape,
): AccountRecoveryApi {
  let reading = false;
  return {
    async list(ctx) {
      const reply = await recoveryCall(transport, ctx, { op: "list" });
      if (
        reply.kind !== "list" ||
        !Array.isArray(reply.items) ||
        reply.items.length > 64 ||
        reply.items.some(
          (i) =>
            !hex(i.recoveryId) ||
            recoveryIdFor(ctx.tenantRef, i.pageId) !== i.recoveryId ||
            !Number.isSafeInteger(i.checkpointVersion) ||
            i.checkpointVersion < 1 ||
            typeof i.title !== "string" ||
            !Number.isFinite(Date.parse(i.expiresAt)) ||
            !Number.isFinite(Date.parse(i.confirmedAt)),
        )
      )
        return reject();
      return { items: reply.items };
    },
    async restore(ctx, input) {
      if (
        reading ||
        input.targetScopeSpaceId !== null ||
        !hex(input.recoveryId) ||
        !Number.isSafeInteger(input.expectedCheckpointVersion) ||
        input.expectedCheckpointVersion < 1
      )
        return reject();
      ctx.assertCurrent();
      reading = true;
      try {
        const keys = await promisify(generateKeyPair)("rsa", { modulusLength: 2048 });
        const id = input.recoveryId,
          version = input.expectedCheckpointVersion;
        const reply = await recoveryCall(transport, ctx, {
          op: "release",
          id,
          version,
          recipient: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        });
        if (reply.kind !== "release") return reject();
        const b = reply.backup,
          m = canonicalManifest(b.manifest);
        if (
          m.realm !== ctx.realm ||
          m.tenantRef !== ctx.tenantRef ||
          recoveryIdFor(ctx.tenantRef, m.pageId) !== id ||
          m.anchor.checkpointVersion !== version ||
          !verified(importSpki(reply.ownerPublicKey), claimBytes(b), b.signature)
        )
          return reject();
        const body = decryptRecoveryBody(m, b.cipher, b.iv, reply.delivery, keys.privateKey);
        let rich: string;
        try {
          rich = parsePageRichContent(body.toString("utf8")).richContent;
        } finally {
          body.fill(0);
        }
        const requestId = "account-recovery-" + digest(manifestBytes(m));
        const assertRemote = async () => {
          const r = await recoveryCall(transport, ctx, {
            op: "validate",
            id,
            version,
            manifestDigest: digest(manifestBytes(m)),
          });
          if (r.kind !== "valid") return reject();
        };
        await assertRemote();
        // Reuse the existing create request ledger inside the same SQLite transaction.
        // A stale session or failed remote re-check rolls back both the Page and its ledger.
        const result = await Effect.runPromise(
          sql.withTransaction(
            Effect.gen(function* () {
              const copy = yield* pages.mutate(
                {
                  op: "create",
                  requestId,
                  scopeSpaceId: null,
                  title: m.title,
                  parentPageId: null,
                  spaceId: null,
                  richContent: rich,
                },
                LOCAL_PAGES_PRINCIPAL,
              );
              yield* Effect.promise(assertRemote);
              yield* Effect.sync(ctx.assertCurrent);
              return copy;
            }),
          ),
          { signal: ctx.signal },
        );
        return {
          kind: "restored-local-copy",
          pageId: result.page.id,
          checkpointVersion: version,
          bundleDigest: m.anchor.bundleDigest,
        };
      } finally {
        reading = false;
      }
    },
  };
}
