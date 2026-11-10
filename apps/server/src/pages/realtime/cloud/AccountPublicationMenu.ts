import { randomBytes } from "node:crypto";
import type { PageAccountRecoveryInput, PageAccountRecoveryResult } from "@moss/contracts";
import { PagesRpcError } from "@moss/contracts";
import type {
  AccountPageRecoveryContext,
  AccountRecoveryPublication,
} from "./control/accountPageRecovery";
import type { PageSpaceSync } from "./PageSpaceSyncService";

type Input = Extract<PageAccountRecoveryInput, { op: "publication-status" | "set-publication" }>;
type Result = Extract<PageAccountRecoveryResult, { kind: "publication" }>;
const unavailable: Result = {
  kind: "publication",
  available: false,
  allowed: false,
  confirmedCount: 0,
  lastConfirmedAt: null,
  observation: "",
};
const changed = () =>
  new PagesRpcError({ code: "conflict", message: "Refresh this space's backup settings." });
export class AccountPublicationMenu {
  private readonly tokens = new Map<
    string,
    { key: string; version: string; consent: AbortSignal | null; expires: number }
  >();
  private readonly writes = new Set<string>();
  clear() {
    this.tokens.clear();
  }
  async apply(
    input: Input,
    context: AccountPageRecoveryContext,
    provider: typeof AccountRecoveryPublication.Service | undefined,
    sync: typeof PageSpaceSync.Service | undefined,
  ): Promise<Result> {
    if (!provider) {
      if (input.op === "set-publication") throw changed();
      return unavailable;
    }
    const target = { scopeSpaceId: null, spaceId: input.spaceId } as const;
    const key = JSON.stringify([context.tenantRef, input.spaceId]);
    if (this.writes.has(key)) throw changed();
    const lease = () => sync?.recoveryConsent?.(target) ?? null;
    const status = async () => {
      const consent = lease();
      const state = await provider.status(context, target);
      context.assertCurrent();
      if (consent !== lease()) throw changed();
      const available = state.state !== "unavailable" && (consent !== null || state.allowed);
      const version = JSON.stringify([
        context.tenantRef,
        context.authorityRevision,
        input.spaceId,
        state.allowed,
        state.confirmedCount,
        state.lastConfirmedAt,
        available,
      ]);
      return { state, available, version, consent };
    };
    let view = await status();
    if (input.op === "set-publication") {
      const observed = this.tokens.get(input.observation);
      this.tokens.delete(input.observation);
      if (
        this.writes.has(key) ||
        !view.available ||
        !observed ||
        observed.key !== key ||
        observed.version !== view.version ||
        observed.consent !== view.consent ||
        observed.expires <= Date.now()
      )
        throw changed();
      for (const [id, item] of this.tokens) if (item.key === key) this.tokens.delete(id);
      this.writes.add(key);
      try {
        if (input.enabled) {
          const consent = view.consent;
          if (!consent || consent.aborted) throw changed();
          const bound = {
            ...context,
            signal: AbortSignal.any([context.signal, consent]),
            assertCurrent() {
              context.assertCurrent();
              if (lease() !== consent || consent.aborted) throw changed();
            },
          };
          bound.assertCurrent();
          await provider.saveConfirmed(bound, target);
          bound.assertCurrent();
        } else {
          await provider.revoke(context, target);
        }
      } finally {
        this.writes.delete(key);
      }
      view = await status();
    }
    if (this.writes.has(key)) throw changed();
    if (!view.available) return unavailable;
    const now = Date.now();
    for (const [key, item] of this.tokens) if (item.expires <= now) this.tokens.delete(key);
    if (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value!);
    const observation = randomBytes(32).toString("hex");
    this.tokens.set(observation, {
      key,
      version: view.version,
      consent: view.consent,
      expires: now + 60_000,
    });
    return {
      kind: "publication",
      available: true,
      allowed: view.state.allowed,
      confirmedCount: view.state.confirmedCount,
      lastConfirmedAt: view.state.lastConfirmedAt,
      observation,
    };
  }
}
