import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      refreshProviders: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockResolvedValue({}),
      getSettings: vi.fn().mockResolvedValue({}),
    },
  }),
  readNativeApi: () => undefined,
}));

import {
  serverMossCloudSignInMutationOptions,
  serverMossPhoneLoginMutationOptions,
} from "~/components/auth/mossServerReactQuery";
import { profileQueryKeys, serverMossProfileQueryOptions } from "./profileReactQuery";
import { resolveProfileAvatarCacheScope } from "./useMossProfile";

describe("profileReactQuery", () => {
  it("retries transient startup RPC failures instead of sticking on fallback initials", () => {
    const options = serverMossProfileQueryOptions();
    expect(options.retry).toBe(3);
    expect(typeof options.retryDelay).toBe("function");
  });

  it("invalidates the Moss profile query on authenticated phone and cloud sign-in", async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(profileQueryKeys.state(), {
      scope: "local",
      realm: null,
      sync: "local",
      editable: true,
      profile: {
        displayName: "Local",
        handle: null,
        avatar: { kind: "initials" },
        updatedAt: null,
      },
    });

    const phoneOptions = serverMossPhoneLoginMutationOptions({ queryClient });
    await phoneOptions.onSuccess?.(
      { authenticated: true, activeRealm: "cn", session: null } as never,
      { phone: "13800138000", code: "123456" } as never,
      undefined as never,
      undefined as never,
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: profileQueryKeys.state() });

    invalidateSpy.mockClear();
    const cloudOptions = serverMossCloudSignInMutationOptions({ queryClient });
    await cloudOptions.onSuccess?.(
      { authenticated: true, activeRealm: "global", account: null, session: null } as never,
      { email: "ada@example.com", password: "secret" } as never,
      undefined as never,
      undefined as never,
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: profileQueryKeys.state() });
  });

  it("derives distinct account-scoped avatar cache keys for CN, global, local, and loading states", () => {
    const phoneA = {
      authenticated: true,
      activeRealm: "cn" as const,
      session: { id: "s-a", user: { id: "user-a" } },
    } as never;
    const phoneSignedOut = {
      authenticated: false,
      activeRealm: "cn" as const,
      session: null,
    } as never;
    const cloudGlobal = {
      authenticated: true,
      activeRealm: "global" as const,
      account: { id: "cloud-1" },
      session: { refreshedAt: "2026-11-26T00:00:00.000Z" },
    } as never;
    const cloudSignedOut = {
      authenticated: false,
      activeRealm: "cn" as const,
      account: null,
      session: null,
    } as never;

    expect(resolveProfileAvatarCacheScope(undefined, undefined)).toBeNull();
    expect(resolveProfileAvatarCacheScope(phoneA, cloudSignedOut)).toBe("account:cn:user-a");
    expect(resolveProfileAvatarCacheScope(phoneSignedOut, cloudGlobal)).toBe(
      "account:global:cloud-1",
    );
    expect(resolveProfileAvatarCacheScope(phoneA, cloudGlobal)).toBe("account:global:cloud-1");
    expect(resolveProfileAvatarCacheScope(phoneSignedOut, cloudSignedOut)).toBe("local");
  });
});
