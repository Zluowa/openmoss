// FILE: mossServerReactQuery.ts
// Purpose: React Query keys and options for Moss-owned server RPC surfaces
//          (Moss phone account, Moss Cloud account, enterprise key, Moss Pay). These
//          helpers lived in ~/lib/serverReactQuery before the upstream merge;
//          they are kept with the Moss auth feature so upstream's server query
//          module stays untouched.
// Layer: Web data access
// Exports: moss server query/mutation keys, query options, mutation options,
//          and managed-provider cache synchronization helpers.

import type {
  MossAccountActiveRealmState,
  MossAccountSelectRealmInput,
  MossAccountStartPhoneLoginInput,
  MossAccountVerifyPhoneLoginInput,
  MossEnterpriseKeySignInInput,
  MossCloudAccountState,
  MossCloudExchangeCodeInput,
  MossCloudExchangeGoogleOAuthCodeInput,
  MossCloudRemoveAccountInput,
  MossCloudRequestPasswordResetInput,
  MossCloudSelectAccountInput,
  MossCloudSignInInput,
  MossCloudSignUpInput,
  MossCloudUpdatePasswordInput,
  MossPayCreateOrderInput,
} from "@synara/contracts";
import { isMossPayOrderSettled } from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { providerDiscoveryQueryKeys } from "~/lib/providerDiscoveryReactQuery";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";

export const mossServerQueryKeys = {
  mossAccountSession: () => ["server", "mossAccount", "session"] as const,
  mossCloudAccountState: () => ["server", "mossCloudAccount", "state"] as const,
  mossCloudAccounts: () => ["server", "mossCloudAccount", "accounts"] as const,
  mossEnterpriseKeyState: () => ["server", "mossEnterpriseKey", "state"] as const,
  mossPayCatalog: () => ["server", "mossPay", "catalog"] as const,
  mossPayQuota: (accountIdentity?: string | null) =>
    ["server", "mossPay", "quota", accountIdentity ?? null] as const,
  mossPayOrder: (outTradeNo: string | null) =>
    ["server", "mossPay", "order", outTradeNo ?? null] as const,
};

export const mossServerMutationKeys = {
  mossPhoneLogin: () => ["server", "mutation", "mossPhoneLogin"] as const,
  mossLogout: () => ["server", "mutation", "mossLogout"] as const,
  mossSelectRealm: () => ["server", "mutation", "mossSelectRealm"] as const,
  mossCloudSignUp: () => ["server", "mutation", "mossCloudAccount", "signUp"] as const,
  mossCloudSignIn: () => ["server", "mutation", "mossCloudAccount", "signIn"] as const,
  mossCloudSelect: () => ["server", "mutation", "mossCloudAccount", "select"] as const,
  mossCloudRemove: () => ["server", "mutation", "mossCloudAccount", "remove"] as const,
  mossCloudRefresh: () => ["server", "mutation", "mossCloudAccount", "refresh"] as const,
  mossCloudStartGoogleOAuth: () =>
    ["server", "mutation", "mossCloudAccount", "startGoogleOAuth"] as const,
  mossCloudExchangeGoogleOAuthCode: () =>
    ["server", "mutation", "mossCloudAccount", "exchangeGoogleOAuthCode"] as const,
  mossCloudPasswordReset: () =>
    ["server", "mutation", "mossCloudAccount", "passwordReset"] as const,
  mossCloudExchangeCode: () => ["server", "mutation", "mossCloudAccount", "exchangeCode"] as const,
  mossCloudUpdatePassword: () =>
    ["server", "mutation", "mossCloudAccount", "updatePassword"] as const,
  mossCloudLogout: () => ["server", "mutation", "mossCloudAccount", "logout"] as const,
  mossEnterpriseKeySignIn: () => ["server", "mutation", "mossEnterpriseKey", "signIn"] as const,
  mossEnterpriseKeyActivate: () => ["server", "mutation", "mossEnterpriseKey", "activate"] as const,
  mossEnterpriseKeySignOut: () => ["server", "mutation", "mossEnterpriseKey", "signOut"] as const,
  mossPayCreateOrder: () => ["server", "mutation", "mossPay", "createOrder"] as const,
};

async function refreshMossManagedProviderCaches(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() }),
    queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() }),
    queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
  ]);
}

function clearMossManagedProviderAuthoritySnapshot(queryClient: QueryClient): void {
  // Config and settings are account-authority snapshots. Invalidation preserves
  // their old data while refetching, which can briefly authorize a managed
  // instance from the previous account. Remove both synchronously at every auth
  // boundary; the current account then repopulates them through refresh/sync.
  queryClient.removeQueries({ queryKey: serverQueryKeys.config(), exact: true });
  queryClient.removeQueries({ queryKey: serverQueryKeys.settings(), exact: true });
}

export async function synchronizeMossManagedChatCaches(queryClient: QueryClient): Promise<void> {
  const api = ensureNativeApi();
  const [config, settings] = await Promise.all([api.server.getConfig(), api.server.getSettings()]);
  queryClient.setQueryData(serverQueryKeys.config(), config);
  queryClient.setQueryData(serverQueryKeys.settings(), settings);
}

/**
 * Waits until a newly provisioned managed provider is both projected into the
 * chat caches and has a fresh health result. Account restoration can create the
 * provider after the renderer's initial config read, so cache synchronization
 * alone is not enough to make the first composer immediately usable.
 */
export async function synchronizeMossManagedChatReadiness(queryClient: QueryClient): Promise<void> {
  const api = ensureNativeApi();
  await api.server.refreshProviders();
  await synchronizeMossManagedChatCaches(queryClient);
}

export function serverMossAccountSessionQueryOptions(
  input: { enabled?: boolean; retry?: boolean | number } = {},
) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossAccountSession(),
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getMossAccountSession();
    },
    staleTime: 15_000,
    retry: input.retry ?? 3,
    retryDelay: (attemptIndex) => Math.min(250 * 2 ** attemptIndex, 1_000),
  });
}

export function serverMossCloudAccountStateQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossCloudAccountState(),
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getMossCloudAccountState();
    },
    staleTime: 15_000,
    retry: false,
  });
}

export function serverMossSelectRealmMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossSelectRealm(),
    mutationFn: async (payload: MossAccountSelectRealmInput) => {
      const api = ensureNativeApi();
      return api.server.selectMossAccountRealm(payload);
    },
    onSuccess: async (result: MossAccountActiveRealmState) => {
      // The RPC has already committed the durable managed-provider switch.
      // Publish that fact before any best-effort cache/readiness work so a
      // transient config or health failure can never roll the UI back.
      const updateActiveRealm = (current: unknown) =>
        current && typeof current === "object"
          ? { ...(current as Record<string, unknown>), activeRealm: result.activeRealm }
          : current;
      input.queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), updateActiveRealm);
      input.queryClient.setQueryData(
        mossServerQueryKeys.mossCloudAccountState(),
        updateActiveRealm,
      );
      await Promise.allSettled([
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossAccountSession(),
        }),
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossCloudAccountState(),
        }),
      ]);
      await synchronizeMossManagedChatReadiness(input.queryClient).catch(() => {
        // Keep the committed realm visible; a later account/provider refetch
        // will retry the readiness projection without rejecting the mutation.
        void Promise.allSettled([
          input.queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() }),
          input.queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() }),
          input.queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
        ]);
      });
    },
  });
}

export function serverMossCloudAccountsQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossCloudAccounts(),
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.listMossCloudAccounts();
    },
    staleTime: 15_000,
    retry: false,
  });
}

export function serverMossPayCatalogQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossPayCatalog(),
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getMossPayCatalog();
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function serverMossPayQuotaQueryOptions(
  input: { enabled?: boolean; accountIdentity?: string | null } = {},
) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossPayQuota(input.accountIdentity),
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getMossPayQuota();
    },
    staleTime: 10_000,
    retry: false,
  });
}

export function serverMossPayCreateOrderMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossPayCreateOrder(),
    mutationFn: async (payload: MossPayCreateOrderInput) => {
      const api = ensureNativeApi();
      return api.server.createMossPayOrder(payload);
    },
  });
}

export function serverMossPayOrderQueryOptions(outTradeNo: string | null) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossPayOrder(outTradeNo),
    enabled: outTradeNo !== null,
    refetchInterval: (query) =>
      query.state.data?.refundReviewRequired ||
      (query.state.data?.status && isMossPayOrderSettled(query.state.data.status))
        ? false
        : 3_000,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getMossPayOrder({ outTradeNo: outTradeNo ?? "" });
    },
    retry: false,
  });
}

export function serverMossCloudSignUpMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudSignUp(),
    mutationFn: async (payload: MossCloudSignUpInput) => {
      const api = ensureNativeApi();
      return api.server.signUpMossCloudAccount(payload);
    },
    onSuccess: async (result) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), result.state);
      await Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossCloudAccounts(),
        }),
        refreshMossManagedProviderCaches(input.queryClient),
      ]);
    },
  });
}

export function serverMossCloudSignInMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudSignIn(),
    mutationFn: async (payload: MossCloudSignInInput) => {
      const api = ensureNativeApi();
      return api.server.signInMossCloudAccount(payload);
    },
    onSuccess: async (state) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), state);
      const refreshAccounts = input.queryClient.invalidateQueries({
        queryKey: mossServerQueryKeys.mossCloudAccounts(),
      });
      if (!state.authenticated) {
        await Promise.all([refreshAccounts, refreshMossManagedProviderCaches(input.queryClient)]);
        return;
      }

      await Promise.all([refreshAccounts, synchronizeMossManagedChatReadiness(input.queryClient)]);
      void input.queryClient
        .invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all })
        .catch(() => undefined);
    },
  });
}

export function serverMossCloudSelectAccountMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudSelect(),
    mutationFn: async (payload: MossCloudSelectAccountInput) => {
      const api = ensureNativeApi();
      return api.server.selectMossCloudAccount(payload);
    },
    onSuccess: async (state) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), state);
      await Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossCloudAccounts(),
        }),
        refreshMossManagedProviderCaches(input.queryClient),
      ]);
    },
  });
}

export function serverMossCloudRemoveAccountMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudRemove(),
    mutationFn: async (payload: MossCloudRemoveAccountInput) => {
      const api = ensureNativeApi();
      return api.server.removeMossCloudAccount(payload);
    },
    onSuccess: async (result) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), result.state);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccounts(), {
        accounts: result.accounts,
      });
      await refreshMossManagedProviderCaches(input.queryClient);
    },
  });
}

export function serverMossCloudRefreshMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudRefresh(),
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.refreshMossCloudAccount();
    },
    onSuccess: async (state) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), state);
      await Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossCloudAccounts(),
        }),
        refreshMossManagedProviderCaches(input.queryClient),
      ]);
    },
  });
}

export function serverMossCloudStartGoogleOAuthMutationOptions() {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudStartGoogleOAuth(),
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.startMossCloudGoogleOAuth();
    },
  });
}

export function serverMossCloudExchangeGoogleOAuthCodeMutationOptions(input: {
  queryClient: QueryClient;
  onVerified?: (state: MossCloudAccountState) => void;
}) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudExchangeGoogleOAuthCode(),
    mutationFn: async (payload: MossCloudExchangeGoogleOAuthCodeInput) => {
      const api = ensureNativeApi();
      return api.server.exchangeMossCloudGoogleOAuthCode(payload);
    },
    onSuccess: (state) => {
      if (state.authenticated && state.lastAuthFlow === "google") {
        input.onVerified?.(state);
      }
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), state);
      const refreshAccounts = input.queryClient.invalidateQueries({
        queryKey: mossServerQueryKeys.mossCloudAccounts(),
      });
      if (!state.authenticated) {
        return Promise.all([
          refreshAccounts,
          refreshMossManagedProviderCaches(input.queryClient),
        ]).then(() => undefined);
      }
      // A verified Google session is the navigation boundary. Account/provider
      // cache hydration continues in the background; the managed runtime starts
      // on the first real turn and must not delay entry into chat.
      void Promise.all([refreshAccounts, synchronizeMossManagedChatReadiness(input.queryClient)])
        .then(() =>
          input.queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
        )
        .catch(() => undefined);
      return undefined;
    },
  });
}

export function serverMossCloudRequestPasswordResetMutationOptions() {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudPasswordReset(),
    mutationFn: async (payload: MossCloudRequestPasswordResetInput) => {
      const api = ensureNativeApi();
      return api.server.requestMossCloudPasswordReset(payload);
    },
  });
}

export function serverMossCloudExchangeCodeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudExchangeCode(),
    mutationFn: async (payload: MossCloudExchangeCodeInput) => {
      const api = ensureNativeApi();
      return api.server.exchangeMossCloudAuthCode(payload);
    },
    onSuccess: async (state) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossCloudAccountState(), state);
      await Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossCloudAccounts(),
        }),
        refreshMossManagedProviderCaches(input.queryClient),
      ]);
    },
  });
}

export function serverMossCloudUpdatePasswordMutationOptions() {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudUpdatePassword(),
    mutationFn: async (payload: MossCloudUpdatePasswordInput) => {
      const api = ensureNativeApi();
      return api.server.updateMossCloudPassword(payload);
    },
  });
}

export function serverMossCloudLogoutMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossCloudLogout(),
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.logoutMossCloudAccount();
    },
    onSuccess: async () => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      const queryKey = mossServerQueryKeys.mossCloudAccountState();
      input.queryClient.setQueryData(queryKey, (current: unknown) => {
        if (!current || typeof current !== "object") return current;
        return {
          ...current,
          authenticated: false,
          account: null,
          session: null,
          emailVerificationRequired: false,
        };
      });
      await Promise.all([
        input.queryClient.invalidateQueries({ queryKey }),
        input.queryClient.invalidateQueries({
          queryKey: mossServerQueryKeys.mossCloudAccounts(),
        }),
        refreshMossManagedProviderCaches(input.queryClient),
      ]);
    },
  });
}

export function serverMossEnterpriseKeyStateQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: mossServerQueryKeys.mossEnterpriseKeyState(),
    enabled: input.enabled ?? true,
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getMossEnterpriseKeyState();
    },
    staleTime: 15_000,
    // Packaged Windows can briefly expose the page before the local RPC
    // transport has completed its first connection; mutations stay user driven.
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 2_000),
  });
}

/**
 * Sign-in and activation both hand the managed Moss surface to the key. Chat
 * navigation must not outrun that surface: `mutateAsync` resolves only after
 * the provider projection and its first health result are coherent.
 */
async function adoptMossEnterpriseKeySurface(queryClient: QueryClient): Promise<void> {
  clearMossManagedProviderAuthoritySnapshot(queryClient);
  await synchronizeMossManagedChatReadiness(queryClient);
  void queryClient
    .invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all })
    .catch(() => undefined);
}

function invalidateMossAccountLanes(queryClient: QueryClient): void {
  for (const queryKey of [
    mossServerQueryKeys.mossAccountSession(),
    mossServerQueryKeys.mossCloudAccountState(),
    mossServerQueryKeys.mossEnterpriseKeyState(),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export function serverMossEnterpriseKeySignInMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossEnterpriseKeySignIn(),
    mutationFn: async (payload: MossEnterpriseKeySignInInput) => {
      const api = ensureNativeApi();
      return api.server.signInMossEnterpriseKey(payload);
    },
    onSuccess: async (state) => {
      input.queryClient.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), state);
      await adoptMossEnterpriseKeySurface(input.queryClient);
    },
    onSettled: () => invalidateMossAccountLanes(input.queryClient),
  });
}

export function serverMossEnterpriseKeyActivateMutationOptions(input: {
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossEnterpriseKeyActivate(),
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.activateMossEnterpriseKey();
    },
    onSuccess: async (state) => {
      input.queryClient.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), state);
      await adoptMossEnterpriseKeySurface(input.queryClient);
    },
    onSettled: () => invalidateMossAccountLanes(input.queryClient),
  });
}

export function serverMossEnterpriseKeySignOutMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossEnterpriseKeySignOut(),
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.signOutMossEnterpriseKey();
    },
    onSuccess: async (state) => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), state);
      await refreshMossManagedProviderCaches(input.queryClient);
    },
    onSettled: () => invalidateMossAccountLanes(input.queryClient),
  });
}

export function serverMossPhoneLoginMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossPhoneLogin(),
    mutationFn: async (
      payload: MossAccountStartPhoneLoginInput | MossAccountVerifyPhoneLoginInput,
    ) => {
      const api = ensureNativeApi();
      if ("code" in payload) {
        return api.server.verifyMossPhoneLogin(payload);
      }
      return api.server.startMossPhoneLogin(payload);
    },
    onSuccess: async (result) => {
      if (!("authenticated" in result) || !result.authenticated) return;
      // The durable account session is authoritative once OTP verification
      // succeeds. Provider health/cache refresh is recoverable background work
      // and must never turn that successful login into a rejected mutation.
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), result);
      void synchronizeMossManagedChatReadiness(input.queryClient)
        .then(() =>
          input.queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all }),
        )
        .catch(() => undefined);
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({
        queryKey: mossServerQueryKeys.mossAccountSession(),
      });
    },
  });
}

export function serverMossLogoutMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: mossServerMutationKeys.mossLogout(),
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.logoutMossAccount();
    },
    onSuccess: async () => {
      clearMossManagedProviderAuthoritySnapshot(input.queryClient);
      input.queryClient.setQueryData(
        mossServerQueryKeys.mossAccountSession(),
        (current: unknown) => {
          if (!current || typeof current !== "object") return current;
          return { ...current, authenticated: false, session: null };
        },
      );
      await refreshMossManagedProviderCaches(input.queryClient);
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({
        queryKey: mossServerQueryKeys.mossAccountSession(),
      });
    },
  });
}
