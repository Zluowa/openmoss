// FILE: useMossProfile.ts
// Purpose: Shared hook reading the `#759` Moss profile state from the local server
//          (gracefully disabled when no native API transport is present, e.g. in pure
//          unit/component tests) and resolving the avatar URL for the rail, header,
//          Profile page, and ShareCard.
// Layer: Web profile feature

import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossProfileState,
} from "@moss/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { mossServerQueryKeys } from "~/components/auth/mossServerReactQuery";
import { resolveMossPayQuotaAccountIdentity } from "~/lib/mossPayQuotaIdentity";
import { readNativeApi } from "~/nativeApi";
import { resolveProfileAvatarSrc } from "./profileAvatarPresets";
import {
  checkMossProfileHandleAvailability,
  profileQueryKeys,
  serverMossProfileQueryOptions,
  serverMossProfileUpdateMutationOptions,
  serverMossProfileUploadAvatarMutationOptions,
} from "./profileReactQuery";
import { useProfileAvatarImage } from "./useProfileAvatarImage";

const SCOPED_AVATAR_CACHE_STORAGE_KEY = "moss:profile:lastResolvedAvatar:v2";
const LEGACY_UNSCOPED_AVATAR_CACHE_STORAGE_KEY = "moss:profile:lastResolvedAvatar:v1";
const PHONE_ACCOUNT_QUERY_KEY = mossServerQueryKeys.mossAccountSession();
const CLOUD_ACCOUNT_QUERY_KEY = mossServerQueryKeys.mossCloudAccountState();
const subscribedProfileSyncClients = new WeakSet<QueryClient>();

interface ScopedCachedAvatar {
  readonly scope: string;
  readonly avatarSrc: string;
}

function matchesQueryKey(queryKey: readonly unknown[], expected: readonly string[]): boolean {
  if (queryKey.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (queryKey[i] !== expected[i]) return false;
  }
  return true;
}

function isAccountIdentityQueryKey(queryKey: readonly unknown[]): boolean {
  return (
    matchesQueryKey(queryKey, PHONE_ACCOUNT_QUERY_KEY) ||
    matchesQueryKey(queryKey, CLOUD_ACCOUNT_QUERY_KEY)
  );
}

/**
 * Stable scope key for caching a resolved avatar URL while `profile.get` is still
 * loading for the same account identity. Returns `null` until enough account state
 * has loaded to know which identity is active.
 */
export function resolveProfileAvatarCacheScope(
  phoneState:
    | Pick<MossAccountSessionState, "authenticated" | "session" | "activeRealm">
    | null
    | undefined,
  cloudState:
    | Pick<MossCloudAccountState, "authenticated" | "account" | "session" | "activeRealm">
    | null
    | undefined,
): string | null {
  const cloudAccountId =
    cloudState?.authenticated && cloudState.account ? cloudState.account.id : null;
  const phoneUserId =
    phoneState?.authenticated && phoneState.session ? phoneState.session.user.id : null;
  const preferGlobal =
    cloudAccountId !== null &&
    (cloudState?.activeRealm === "global" || phoneState?.activeRealm === "global");
  if (preferGlobal) {
    return `account:global:${cloudAccountId}`;
  }
  if (phoneUserId !== null && (phoneState?.activeRealm !== "global" || cloudState !== undefined)) {
    return `account:cn:${phoneUserId}`;
  }
  const phoneSignedOut = phoneState?.authenticated === false && phoneState.session === null;
  if (phoneSignedOut && cloudAccountId !== null) {
    return `account:global:${cloudAccountId}`;
  }
  const cloudSignedOut = cloudState?.authenticated === false && cloudState.account === null;
  if (phoneSignedOut && cloudSignedOut) {
    return "local";
  }
  return null;
}

function readProfileAvatarCacheScope(queryClient: QueryClient): string | null {
  const phoneState = queryClient.getQueryData<MossAccountSessionState>(PHONE_ACCOUNT_QUERY_KEY);
  const cloudState = queryClient.getQueryData<MossCloudAccountState>(CLOUD_ACCOUNT_QUERY_KEY);
  return resolveProfileAvatarCacheScope(phoneState, cloudState);
}

function readProfileAccountSyncKey(queryClient: QueryClient): string | null {
  const phoneState = queryClient.getQueryData<MossAccountSessionState>(PHONE_ACCOUNT_QUERY_KEY);
  const cloudState = queryClient.getQueryData<MossCloudAccountState>(CLOUD_ACCOUNT_QUERY_KEY);
  const sessionIdentity = resolveMossPayQuotaAccountIdentity(phoneState, cloudState);
  if (sessionIdentity) return sessionIdentity;
  const scope = resolveProfileAvatarCacheScope(phoneState, cloudState);
  return scope && scope !== "local" ? scope : null;
}

function doesProfileStateMatchScope(
  profileState: MossProfileState,
  cacheScope: string | null,
): boolean {
  if (!cacheScope) return false;
  if (cacheScope === "local") return profileState.scope === "local";
  if (cacheScope.startsWith("account:cn:")) {
    return profileState.scope === "account" && profileState.realm === "cn";
  }
  if (cacheScope.startsWith("account:global:")) {
    return profileState.scope === "account" && profileState.realm === "global";
  }
  return false;
}

function readScopedProfileAvatarEntry(): ScopedCachedAvatar | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(SCOPED_AVATAR_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ScopedCachedAvatar> | null;
    if (
      parsed &&
      typeof parsed.scope === "string" &&
      parsed.scope.length > 0 &&
      typeof parsed.avatarSrc === "string" &&
      parsed.avatarSrc.length > 0
    ) {
      return { scope: parsed.scope, avatarSrc: parsed.avatarSrc };
    }
    return null;
  } catch {
    return null;
  }
}

function readScopedProfileAvatar(scope: string | null): string | null {
  if (!scope) return null;
  const entry = readScopedProfileAvatarEntry();
  return entry && entry.scope === scope ? entry.avatarSrc : null;
}

function writeScopedProfileAvatar(scope: string | null, avatarSrc: string | null): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(LEGACY_UNSCOPED_AVATAR_CACHE_STORAGE_KEY);
    if (scope && avatarSrc && avatarSrc.length > 0) {
      const payload: ScopedCachedAvatar = { scope, avatarSrc };
      window.localStorage.setItem(SCOPED_AVATAR_CACHE_STORAGE_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(SCOPED_AVATAR_CACHE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or disabled-storage errors.
  }
}

function clearScopedProfileAvatarIfMismatched(nextScope: string | null): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(LEGACY_UNSCOPED_AVATAR_CACHE_STORAGE_KEY);
    const entry = readScopedProfileAvatarEntry();
    if (!entry || entry.scope !== nextScope) {
      window.localStorage.removeItem(SCOPED_AVATAR_CACHE_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or disabled-storage errors.
  }
}

// Watch the existing account-session query cache entries (without issuing extra
// RPCs) so startup session restoration, sign-out, or account/realm switches clear
// the previous account's profile snapshot and immediately refetch `profile.get`.
function ensureProfileAccountCacheSync(queryClient: QueryClient): void {
  if (subscribedProfileSyncClients.has(queryClient)) return;
  subscribedProfileSyncClients.add(queryClient);
  let lastSyncKey = readProfileAccountSyncKey(queryClient);
  queryClient.getQueryCache().subscribe((event) => {
    const queryKey = event.query?.queryKey;
    if (!queryKey || !isAccountIdentityQueryKey(queryKey)) return;
    const nextSyncKey = readProfileAccountSyncKey(queryClient);
    if (nextSyncKey === lastSyncKey) return;
    lastSyncKey = nextSyncKey;
    clearScopedProfileAvatarIfMismatched(readProfileAvatarCacheScope(queryClient));
    void queryClient.resetQueries({ queryKey: profileQueryKeys.state() }).catch(() => undefined);
  });
}

function useCachedProfileAccountScope(queryClient: QueryClient): string | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        const queryKey = event.query?.queryKey;
        if (!queryKey || !isAccountIdentityQueryKey(queryKey)) return;
        onStoreChange();
      }),
    [queryClient],
  );
  const getSnapshot = useCallback(() => readProfileAvatarCacheScope(queryClient), [queryClient]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function isMossProfileState(value: unknown): value is MossProfileState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "profile" in (value as Record<string, unknown>) &&
    "scope" in (value as Record<string, unknown>)
  );
}

export function useMossProfileState(options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  const hasApi = Boolean(readNativeApi());
  useEffect(() => {
    if (!hasApi) return;
    ensureProfileAccountCacheSync(queryClient);
  }, [hasApi, queryClient]);
  const query = useQuery(
    serverMossProfileQueryOptions({ enabled: (options.enabled ?? true) && hasApi }),
  );
  const profileState = hasApi && isMossProfileState(query.data) ? query.data : null;
  return {
    ...query,
    profileState,
    hasApi,
  };
}

export function useMossProfileMutations() {
  const queryClient = useQueryClient();
  const updateMutation = useMutation(serverMossProfileUpdateMutationOptions({ queryClient }));
  const uploadAvatarMutation = useMutation(
    serverMossProfileUploadAvatarMutationOptions({ queryClient }),
  );
  return {
    updateMutation,
    uploadAvatarMutation,
    checkHandle: checkMossProfileHandleAvailability,
  };
}

/**
 * Single source for the person's active avatar image URL across the bottom-left rail,
 * sidebar account badge, Profile hero, and share card. Prefers the `#759` profile
 * contract (`preset` SVG or `upload` URL), using an account-scoped cached avatar only
 * while the server profile is still loading for that same identity, and never overriding
 * a loaded `{ kind: "initials" }` profile.
 */
export function useResolvedMossProfileAvatar(): {
  readonly avatarSrc: string | null;
  readonly profileState: MossProfileState | null;
} {
  const queryClient = useQueryClient();
  const { profileState } = useMossProfileState();
  const cacheScope = useCachedProfileAccountScope(queryClient);
  const { image: legacyImage } = useProfileAvatarImage();
  const resolvedProfileAvatar = profileState
    ? resolveProfileAvatarSrc(profileState.profile.avatar, null)
    : null;

  useEffect(() => {
    if (!profileState || !cacheScope) return;
    if (!doesProfileStateMatchScope(profileState, cacheScope)) return;
    writeScopedProfileAvatar(cacheScope, resolvedProfileAvatar);
  }, [cacheScope, profileState, resolvedProfileAvatar]);

  const avatarSrc = profileState
    ? resolvedProfileAvatar
    : (readScopedProfileAvatar(cacheScope) ??
      (cacheScope === "local" || cacheScope === null ? legacyImage : null));
  return { avatarSrc, profileState };
}
