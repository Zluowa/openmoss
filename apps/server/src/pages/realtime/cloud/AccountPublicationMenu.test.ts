import { expect, it, vi } from "vitest";
import { PageSpaceId } from "@moss/contracts";
import { Schema } from "effect";
import { AccountPublicationMenu } from "./AccountPublicationMenu";
import type {
  AccountPageRecoveryContext,
  AccountRecoveryPublicationApi,
  AccountRecoveryStatus,
} from "./control/accountPageRecovery";

function fixture() {
  const menu = new AccountPublicationMenu();
  let lease = new AbortController();
  let allowed = false;
  const context: AccountPageRecoveryContext = {
    realm: "memfire-phone",
    tenantRef: "tenant",
    authorityRevision: 1,
    signal: new AbortController().signal,
    assertCurrent: () => {},
    currentCredential: async () => {
      throw Error("Unexpected remote credential on menu read");
    },
  };
  const status = async (): Promise<AccountRecoveryStatus> => ({
    state: "not-saved",
    allowed,
    confirmedCount: 0,
    lastConfirmedAt: null,
  });
  const writer: AccountRecoveryPublicationApi = {
    status,
    saveConfirmed: vi.fn(async (ctx) => {
      ctx.assertCurrent();
      allowed = true;
    }),
    revoke: vi.fn(async () => {
      allowed = false;
    }),
  };
  const sync = {
    recoveryConsent: () => (lease.signal.aborted ? null : lease.signal),
    apply: () => {
      throw Error("No sync mutation");
    },
  };
  const spaceId = Schema.decodeUnknownSync(PageSpaceId)("space-a");
  const show = () => menu.apply({ op: "publication-status", spaceId }, context, writer, sync);
  const set = (enabled: boolean, observation: string) =>
    menu.apply({ op: "set-publication", spaceId, enabled, observation }, context, writer, sync);
  return {
    writer,
    show,
    set,
    replaceLease: () => {
      lease.abort();
      lease = new AbortController();
    },
    endLease: () => lease.abort(),
  };
}
it("requires a fresh displayed consent and keeps consent distinct from a confirmed remote copy", async () => {
  const f = fixture();
  const first = await f.show(),
    second = await f.show();
  expect(first).toMatchObject({ available: true, allowed: false, confirmedCount: 0 });
  expect(f.writer.saveConfirmed).not.toHaveBeenCalled();
  const enabled = await f.set(true, first.observation);
  expect(enabled).toMatchObject({ allowed: true, confirmedCount: 0, lastConfirmedAt: null });
  await expect(f.set(false, second.observation)).rejects.toThrow();
  expect(f.writer.revoke).not.toHaveBeenCalled();
  f.endLease();
  const menu = await f.show();
  expect(menu.available).toBe(true);
  expect((await f.set(false, menu.observation)).allowed).toBe(false);
});
it("rejects a menu captured before the same space's device sync stopped and restarted", async () => {
  const f = fixture();
  const old = await f.show();
  f.replaceLease();
  await expect(f.set(true, old.observation)).rejects.toThrow();
  expect(f.writer.saveConfirmed).not.toHaveBeenCalled();
});
