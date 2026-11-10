import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { MossCloudAccountService } from "../../../account/Services/MossCloudAccountService";
import { MossPhoneAccountService } from "../../../account/Services/MossPhoneAccountService";
import { withMossLocalAuthorityTransition } from "../../../account/mossAccountLifecycleLock";
import { ServerSecretStore } from "../../../auth/Services/ServerSecretStore";
import { CurrentWsSessionRole } from "../../../wsConnectionSessions";
import type { PageAccountRecoveryInput } from "@moss/contracts";
import {
  AccountPageRecovery,
  type AccountPageRecoveryContext,
} from "./control/accountPageRecovery";
import {
  ownerAccountRecovery,
  PageAccountRecoveryRpcLive,
  PageAccountRecoveryRpcService,
} from "./PageAccountRecoveryService";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture(configured = true) {
  let account = "owner-a";
  const phone = {
    getLocalAuthority: () =>
      Effect.sync(() => ({
        activeRealm: "cn",
        identity: {
          realm: "memfire-phone",
          account: { id: account, realm: "memfire-phone" },
          gatewayBaseUrl: "https://issuer.example",
        },
      })),
    getAuthorityCredential: vi.fn(() =>
      Effect.succeed({
        realm: "memfire-phone",
        gatewayBaseUrl: "https://issuer.example",
        issuer: "https://auth.example",
        realtimeRelayUrl: "",
        accessToken: "test-session",
      }),
    ),
  };
  const global = { getLocalAuthority: () => Effect.succeed({ activeRealm: "cn", identity: null }) };
  const secrets = {} as typeof ServerSecretStore.Service;
  const accounts = Layer.mergeAll(
    Layer.succeed(MossPhoneAccountService, phone as never),
    Layer.succeed(MossCloudAccountService, global as never),
    Layer.succeed(ServerSecretStore, secrets),
  );
  const entry = {
    recoveryId: "copy-1",
    pageId: "source-page",
    title: "笔记",
    checkpointVersion: 7,
    confirmedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const list = vi.fn(async (context: AccountPageRecoveryContext) => {
    expect(await context.currentCredential()).toBe("test-session");
    return { items: [entry] };
  });
  const restore = vi.fn(
    async (
      _context: AccountPageRecoveryContext,
      input: { expectedCheckpointVersion: number; targetScopeSpaceId: null; recoveryId: string },
    ) => {
      return {
        kind: "restored-local-copy" as const,
        pageId: "new-local-page",
        checkpointVersion: input.expectedCheckpointVersion,
        bundleDigest: "a".repeat(64),
      };
    },
  );
  const provider = Layer.succeed(AccountPageRecovery, { list, restore });
  const layer = PageAccountRecoveryRpcLive.pipe(
    Layer.provide(configured ? Layer.merge(accounts, provider) : accounts),
  );
  const rt = ManagedRuntime.make(layer);
  cleanup.push(() => rt.dispose());
  const service = await rt.runPromise(Effect.service(PageAccountRecoveryRpcService));
  const apply = (input: PageAccountRecoveryInput, role: "owner" | "client" = "owner") =>
    rt.runPromise(
      ownerAccountRecovery(service, input).pipe(Effect.provideService(CurrentWsSessionRole, role)),
    );
  const switchTo = (id: string) =>
    Effect.runPromise(
      withMossLocalAuthorityTransition(
        secrets,
        Effect.sync(() => {
          account = id;
        }),
      ),
    );
  return { apply, list, restore, getCredential: phone.getAuthorityCredential, switchTo };
}

it("probes availability without sending a credential, and denies a paired client before reading any account data", async () => {
  const disabled = await fixture(false);
  expect(await disabled.apply({ op: "availability" })).toEqual({
    kind: "availability",
    available: false,
  });
  await expect(disabled.apply({ op: "list" })).rejects.toThrow();
  const live = await fixture();
  expect(await live.apply({ op: "availability" })).toEqual({
    kind: "availability",
    available: true,
  });
  await expect(live.apply({ op: "list" }, "client")).rejects.toThrow();
  expect(live.list).not.toHaveBeenCalled();
  expect(live.getCredential).not.toHaveBeenCalled();
});

it("restores the displayed checkpoint exactly once, rejects edited IDs and rejects observations after account A → B → A", async () => {
  const f = await fixture();
  const lookup = async () => {
    const result = await f.apply({ op: "list" });
    if (result.kind !== "list") throw new Error("Expected a confirmed catalog");
    return result.items[0]!;
  };
  const first = await lookup();
  await f.switchTo("owner-b");
  await f.switchTo("owner-a");
  await expect(
    f.apply({ op: "restore", recoveryId: first.recoveryId, observation: first.observation }),
  ).rejects.toThrow();
  const second = await lookup();
  await expect(
    f.apply({ op: "restore", recoveryId: "different", observation: second.observation }),
  ).rejects.toThrow();
  expect(f.restore).not.toHaveBeenCalled();
  const third = await lookup();
  const input = {
    op: "restore" as const,
    recoveryId: third.recoveryId,
    observation: third.observation,
  };
  expect(await f.apply(input)).toEqual({ kind: "restored", pageId: "new-local-page" });
  await expect(f.apply(input)).rejects.toThrow();
  expect(f.restore).toHaveBeenCalledTimes(1);
  expect(f.restore.mock.calls[0]![1]).toEqual({
    recoveryId: "copy-1",
    targetScopeSpaceId: null,
    expectedCheckpointVersion: 7,
  });
});

it("discards a pending list result when the user changes accounts before its response arrives", async () => {
  const f = await fixture();
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.list.mockImplementationOnce(async (ctx) => {
    entered();
    await gate;
    expect(ctx.signal.aborted).toBe(true);
    return { items: [] };
  });
  const pending = f.apply({ op: "list" });
  await started;
  await f.switchTo("owner-b");
  resume();
  await expect(pending).rejects.toThrow();
});
