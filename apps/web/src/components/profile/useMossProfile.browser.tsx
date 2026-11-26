// FILE: useMossProfile.browser.tsx
// Purpose: Real Chromium rendered tests verifying what a person sees in RailAccountMenu
//          for Moss profile avatar persistence across startup retries, account-cache
//          restoration/switches, and sign-out / uncustomized account isolation.
// Layer: Browser UI test

import "../../index.css";

import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossProfileState,
  NativeApi,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { RailAccountMenu } from "~/components/SidebarAccountMenu";
import { MossLocaleScope } from "~/localization";

const originalNativeApi = window.nativeApi;

function makePhoneSession(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly phoneNumber?: string;
}): MossAccountSessionState {
  return {
    configured: true,
    authenticated: true,
    activeRealm: "cn",
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
    session: {
      id: input.sessionId,
      user: {
        id: input.userId,
        phoneNumber: input.phoneNumber ?? "+8613800138000",
        displayName: input.displayName,
        role: "member",
        status: "active",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastLoginAt: "2026-11-26T00:00:00.000Z",
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-12-26T00:00:00.000Z",
      lastSeenAt: "2026-11-26T00:00:00.000Z",
    },
  } as unknown as MossAccountSessionState;
}

const SIGNED_OUT_PHONE: MossAccountSessionState = {
  configured: true,
  authenticated: false,
  activeRealm: "cn",
  session: null,
  smsProvider: "aliyun",
  aliyunSmsConfigured: true,
} as unknown as MossAccountSessionState;

const SIGNED_OUT_CLOUD: MossCloudAccountState = {
  configured: true,
  authenticated: false,
  activeRealm: "cn",
  account: null,
  session: null,
  emailVerificationRequired: false,
  modelGatewayConfigured: true,
  authProvider: "supabase_google",
} as unknown as MossCloudAccountState;

const DEFAULT_QUOTA = {
  planCode: "free",
  billingModel: "wallet_credits_v1" as const,
  creditBalance: 0,
  periodStart: null,
  periodEnd: null,
  quotaPolicyMode: "metered" as const,
  requestLimit: null,
  requestsUsed: 0,
  tokenLimit: null,
  tokensUsed: 0,
  usageLimits: [],
  windowId: null,
  windowSource: null,
  windowDurationSeconds: null,
  realtimeConfigured: false,
  realtimeModelAllowlist: [],
  realtimeCostLimitNanoUsd: null,
  realtimeCostUsedNanoUsd: 0,
  realtimeCostReservedNanoUsd: 0,
  realtimeEstimatedMinutesRemaining: null,
  realtimeSessionLimit: null,
  realtimeSessionsUsed: 0,
};

function installProfileNativeApi(profileGet: () => Promise<MossProfileState>) {
  const api = {
    profile: {
      get: profileGet,
      update: vi.fn(),
      checkHandle: vi.fn(),
      uploadAvatar: vi.fn(),
    },
    mossAccount: {
      getSession: vi.fn().mockResolvedValue(SIGNED_OUT_PHONE),
    },
    mossCloudAccount: {
      getState: vi.fn().mockResolvedValue(SIGNED_OUT_CLOUD),
      listAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    },
    mossEnterpriseKey: {
      getState: vi.fn().mockResolvedValue({
        configured: true,
        authenticated: false,
        keyPrefix: null,
        verifiedAt: null,
        modelCount: 0,
        active: false,
      }),
    },
    mossPay: {
      getCatalog: vi.fn().mockResolvedValue({
        plans: [],
        pointPackages: [],
        paymentMethods: [],
        plansPurchasable: false,
      }),
      getQuota: vi.fn().mockResolvedValue(DEFAULT_QUOTA),
    },
  } as unknown as NativeApi;
  window.nativeApi = api;
  return api;
}

function seedNonProfileQueries(
  queryClient: QueryClient,
  phoneState: MossAccountSessionState,
  cloudState: MossCloudAccountState = SIGNED_OUT_CLOUD,
) {
  queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, phoneState);
  queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, cloudState);
  queryClient.setQueryData(serverMossCloudAccountsQueryOptions().queryKey, { accounts: [] });
  queryClient.setQueryData(serverMossEnterpriseKeyStateQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    keyPrefix: null,
    verifiedAt: null,
    modelCount: 0,
    active: false,
  });
  queryClient.setQueryData(serverMossPayCatalogQueryOptions().queryKey, {
    plans: [],
    pointPackages: [],
    paymentMethods: [],
    plansPurchasable: false,
  });
  if (phoneState.authenticated && phoneState.session) {
    const accountIdentity = `phone:${phoneState.session.user.id}:${phoneState.session.id}`;
    queryClient.setQueryData(
      serverMossPayQuotaQueryOptions({ accountIdentity }).queryKey,
      DEFAULT_QUOTA,
    );
  }
}

async function mountRailAccountMenu(queryClient: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <MossLocaleScope locale="zh-CN">
          <Outlet />
        </MossLocaleScope>
      </QueryClientProvider>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/thread-1",
      component: () => (
        <div className="flex h-dvh items-end p-4">
          <RailAccountMenu />
        </div>
      ),
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/thread-1"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

async function expectRenderedAvatarSrc(expectedSrc: string) {
  await vi.waitFor(
    () => {
      const disc = page.getByTestId("rail-account-avatar-disc").element();
      const img = disc.querySelector("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe(expectedSrc);
      expect(img?.complete).toBe(true);
      expect(img?.naturalWidth).toBeGreaterThan(0);
      const rect = img!.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(24);
      expect(rect.height).toBeGreaterThanOrEqual(24);
    },
    { timeout: 5_000 },
  );
}

async function expectInitialsWithoutAvatarImage() {
  await vi.waitFor(
    () => {
      const disc = page.getByTestId("rail-account-avatar-disc").element();
      expect(disc.querySelector("img")).toBeNull();
      expect(disc.textContent?.trim().length).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
}

afterEach(() => {
  if (originalNativeApi === undefined) {
    delete window.nativeApi;
  } else {
    window.nativeApi = originalNativeApi;
  }
  localStorage.clear();
  document.body.replaceChildren();
});

describe("useResolvedMossProfileAvatar in RailAccountMenu", () => {
  it("retries transient startup profile.get failures and renders the persisted avatar image", async () => {
    await page.viewport(1024, 768);
    const phoneA = makePhoneSession({
      userId: "user-retry-a",
      sessionId: "sess-retry-a",
      displayName: "小林",
    });

    let attempts = 0;
    const profileGet = vi.fn(async (): Promise<MossProfileState> => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error("local RPC transport still handshaking");
      }
      return {
        scope: "account",
        realm: "cn",
        sync: "synced",
        editable: true,
        profile: {
          displayName: "小林",
          handle: "lin_moss",
          avatar: { kind: "preset", id: "moss-cat" },
          updatedAt: "2026-11-26T00:00:00.000Z",
        },
      };
    });
    installProfileNativeApi(profileGet);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedNonProfileQueries(queryClient, phoneA);

    const screen = await mountRailAccountMenu(queryClient);
    try {
      // Initially no avatar image while the first RPC fails.
      await expectInitialsWithoutAvatarImage();
      // Automatic retries recover and paint the persisted preset avatar pixels.
      await expectRenderedAvatarSrc("/avatars/moss-cat.svg");
      expect(profileGet).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
    }

    // Reopening for the same account shows its scoped cached avatar immediately while profile.get is still loading.
    let resolveReload!: (value: MossProfileState) => void;
    installProfileNativeApi(
      vi.fn(
        () =>
          new Promise<MossProfileState>((resolve) => {
            resolveReload = resolve;
          }),
      ),
    );
    const reloadClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedNonProfileQueries(reloadClient, phoneA);
    const reloaded = await mountRailAccountMenu(reloadClient);
    try {
      await expectRenderedAvatarSrc("/avatars/moss-cat.svg");
      resolveReload({
        scope: "account",
        realm: "cn",
        sync: "synced",
        editable: true,
        profile: {
          displayName: "小林",
          handle: "lin_moss",
          avatar: { kind: "preset", id: "moss-cat" },
          updatedAt: "2026-11-26T00:00:00.000Z",
        },
      });
      await expectRenderedAvatarSrc("/avatars/moss-cat.svg");
    } finally {
      await reloaded.unmount();
    }
  });

  it("refetches and renders the signed-in account avatar when account cache restores or switches", async () => {
    await page.viewport(1024, 768);
    const phoneA = makePhoneSession({
      userId: "user-restore-a",
      sessionId: "sess-restore-a",
      displayName: "阿达",
    });
    const phoneB = makePhoneSession({
      userId: "user-restore-b",
      sessionId: "sess-restore-b",
      displayName: "小苔",
    });

    let currentProfile: MossProfileState = {
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
    };
    const profileGet = vi.fn(async () => currentProfile);
    installProfileNativeApi(profileGet);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedNonProfileQueries(queryClient, SIGNED_OUT_PHONE);

    const screen = await mountRailAccountMenu(queryClient);
    try {
      await expectInitialsWithoutAvatarImage();
      expect(profileGet).toHaveBeenCalledTimes(1);

      // Account session cache restores Account A -> refetches and renders Account A's avatar.
      currentProfile = {
        scope: "account",
        realm: "cn",
        sync: "synced",
        editable: true,
        profile: {
          displayName: "阿达",
          handle: "ada_cn",
          avatar: { kind: "preset", id: "smiling-glasses" },
          updatedAt: "2026-11-26T00:00:00.000Z",
        },
      };
      seedNonProfileQueries(queryClient, phoneA);
      await expectRenderedAvatarSrc("/avatars/smiling-glasses.svg");
      expect(profileGet).toHaveBeenCalledTimes(2);

      // Switching to Account B refetches and renders Account B's avatar.
      currentProfile = {
        scope: "account",
        realm: "cn",
        sync: "synced",
        editable: true,
        profile: {
          displayName: "小苔",
          handle: "moss_b",
          avatar: { kind: "preset", id: "leaf-sprout" },
          updatedAt: "2026-11-26T00:01:00.000Z",
        },
      };
      seedNonProfileQueries(queryClient, phoneB);
      await expectRenderedAvatarSrc("/avatars/leaf-sprout.svg");
      expect(profileGet).toHaveBeenCalledTimes(3);
    } finally {
      await screen.unmount();
    }
  });

  it("never leaks the previous account avatar after sign-out or switching to an uncustomized account", async () => {
    await page.viewport(1024, 768);
    const phoneA = makePhoneSession({
      userId: "user-leak-a",
      sessionId: "sess-leak-a",
      displayName: "账号甲",
    });
    const phoneB = makePhoneSession({
      userId: "user-leak-b",
      sessionId: "sess-leak-b",
      displayName: "账号乙",
    });

    const profileA: MossProfileState = {
      scope: "account",
      realm: "cn",
      sync: "synced",
      editable: true,
      profile: {
        displayName: "账号甲",
        handle: "acct_a",
        avatar: { kind: "preset", id: "moss-cat" },
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
    };
    const localInitials: MossProfileState = {
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
    };
    const uncustomizedB: MossProfileState = {
      scope: "account",
      realm: "cn",
      sync: "synced",
      editable: true,
      profile: {
        displayName: "账号乙",
        handle: null,
        avatar: { kind: "initials" },
        updatedAt: null,
      },
    };

    let nextResponse: () => Promise<MossProfileState> = async () => profileA;
    installProfileNativeApi(vi.fn(() => nextResponse()));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    seedNonProfileQueries(queryClient, phoneA);

    const screen = await mountRailAccountMenu(queryClient);
    try {
      // Account A renders its custom preset avatar and writes its scoped cache.
      await expectRenderedAvatarSrc("/avatars/moss-cat.svg");

      // 1) Signing out to a local profile (updatedAt: null, avatar: initials) must NOT show Account A's avatar.
      nextResponse = async () => localInitials;
      seedNonProfileQueries(queryClient, SIGNED_OUT_PHONE);
      await expectInitialsWithoutAvatarImage();

      // Re-sign into Account A so its scoped avatar cache is populated again.
      nextResponse = async () => profileA;
      seedNonProfileQueries(queryClient, phoneA);
      await expectRenderedAvatarSrc("/avatars/moss-cat.svg");

      // 2) Switching to uncustomized Account B must clear Account A's avatar even while Account B is loading,
      //    and must stay on initials after Account B resolves with updatedAt: null.
      let resolveB!: (value: MossProfileState) => void;
      nextResponse = () =>
        new Promise<MossProfileState>((resolve) => {
          resolveB = resolve;
        });
      seedNonProfileQueries(queryClient, phoneB);
      await expectInitialsWithoutAvatarImage();

      resolveB(uncustomizedB);
      await expectInitialsWithoutAvatarImage();
      // Confirm no stale img appears after resolution settles.
      const disc = page.getByTestId("rail-account-avatar-disc").element();
      expect(disc.querySelector("img")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
