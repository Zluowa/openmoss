// FILE: useMossPayQuotaQuery.ts
// Purpose: Shared resilient Moss quota loader for Settings → Usage, Settings → Account,
//          and sidebar/environment quota summaries. Keeps exact per-account isolation while
//          preserving the same account's last-known-good snapshot across session-token refreshes.
// Layer: Web data hook
// Exports: findSameAccountCachedMossQuota, useMossPayQuotaQuery

import type { MossPayQuota } from "@moss/contracts";
import { useIsMutating, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import {
  isMossPayAccountTransitionPending,
  mossPayQuotaOwnerPrefix,
  resolveMossPayQuotaAccountIdentity,
} from "~/lib/mossPayQuotaIdentity";
import {
  mossServerMutationKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "./mossServerReactQuery";

/**
 * Returns the freshest cached quota snapshot for the exact same account owner
 * (same lane + same user/account id) when the current session timestamp key has
 * not finished loading or transiently errored. Never crosses account or realm boundaries.
 */
export function findSameAccountCachedMossQuota(
  queryClient: QueryClient,
  accountIdentity: string | null,
): MossPayQuota | undefined {
  const ownerPrefix = mossPayQuotaOwnerPrefix(accountIdentity);
  if (!ownerPrefix) return undefined;
  let bestData: MossPayQuota | undefined;
  let bestUpdatedAt = -1;
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: ["server", "mossPay", "quota"] })) {
    const keyIdentity = query.queryKey[3];
    if (
      typeof keyIdentity !== "string" ||
      keyIdentity === accountIdentity ||
      !keyIdentity.startsWith(ownerPrefix)
    ) {
      continue;
    }
    const candidate = query.state.data as MossPayQuota | undefined;
    if (!candidate) continue;
    const updatedAt = query.state.dataUpdatedAt;
    if (updatedAt >= bestUpdatedAt) {
      bestUpdatedAt = updatedAt;
      bestData = candidate;
    }
  }
  return bestData;
}

export function useMossPayQuotaQuery() {
  const queryClient = useQueryClient();
  const phoneAccountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const cloudAccountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const phoneLoginCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossPhoneLogin() });
  const phoneLogoutCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossLogout() });
  const cloudAccountSwitchCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossCloudSelect(),
  });
  const cloudLogoutCount = useIsMutating({ mutationKey: mossServerMutationKeys.mossCloudLogout() });
  const accountTransitionPending = isMossPayAccountTransitionPending({
    phoneLoginCount,
    phoneLogoutCount,
    cloudAccountSwitchCount,
    cloudLogoutCount,
  });
  const accountIdentity = resolveMossPayQuotaAccountIdentity(
    phoneAccountQuery.data,
    cloudAccountQuery.data,
    accountTransitionPending,
  );
  const quotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: accountIdentity !== null,
      accountIdentity,
    }),
  );
  const fallbackQuota =
    !accountTransitionPending && !quotaQuery.data
      ? findSameAccountCachedMossQuota(queryClient, accountIdentity)
      : undefined;
  const quota = accountTransitionPending ? undefined : (quotaQuery.data ?? fallbackQuota);
  const isStaleFallback = !accountTransitionPending && !quotaQuery.data && Boolean(fallbackQuota);
  const accountLoading =
    accountTransitionPending ||
    (accountIdentity === null &&
      (phoneAccountQuery.isPending ||
        phoneAccountQuery.isFetching ||
        cloudAccountQuery.isPending ||
        cloudAccountQuery.isFetching));
  const quotaLoading = accountIdentity !== null && quotaQuery.isPending && !quota;

  return {
    phoneAccountQuery,
    cloudAccountQuery,
    accountTransitionPending,
    accountIdentity,
    quotaQuery,
    quota,
    isStaleFallback,
    accountLoading,
    quotaLoading,
  };
}
