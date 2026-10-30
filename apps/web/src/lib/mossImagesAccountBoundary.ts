import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossEnterpriseKeyState,
} from "@synara/contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import {
  mossServerMutationKeys,
  mossServerQueryKeys,
} from "~/components/auth/mossServerReactQuery";

const AUTH_MUTATIONS = new Set(
  [
    mossServerMutationKeys.mossPhoneLogin(),
    mossServerMutationKeys.mossLogout(),
    mossServerMutationKeys.mossSelectRealm(),
    mossServerMutationKeys.mossCloudSignUp(),
    mossServerMutationKeys.mossCloudSignIn(),
    mossServerMutationKeys.mossCloudSelect(),
    mossServerMutationKeys.mossCloudRemove(),
    mossServerMutationKeys.mossCloudExchangeGoogleOAuthCode(),
    mossServerMutationKeys.mossCloudExchangeCode(),
    mossServerMutationKeys.mossCloudLogout(),
    mossServerMutationKeys.mossEnterpriseKeySignIn(),
    mossServerMutationKeys.mossEnterpriseKeyActivate(),
    mossServerMutationKeys.mossEnterpriseKeySignOut(),
  ].map((key) => JSON.stringify(key)),
);

const ACCOUNT_QUERIES = new Set(
  [
    mossServerQueryKeys.mossAccountSession(),
    mossServerQueryKeys.mossCloudAccountState(),
    mossServerQueryKeys.mossEnterpriseKeyState(),
  ].map((key) => JSON.stringify(key)),
);

/** Identity-only snapshot; auth tokens and profile details never enter this boundary. */
export function readMossImagesAccountIdentity(queryClient: QueryClient): string {
  const phone = queryClient.getQueryData<MossAccountSessionState>(
    mossServerQueryKeys.mossAccountSession(),
  );
  const cloud = queryClient.getQueryData<MossCloudAccountState>(
    mossServerQueryKeys.mossCloudAccountState(),
  );
  const enterprise = queryClient.getQueryData<MossEnterpriseKeyState>(
    mossServerQueryKeys.mossEnterpriseKeyState(),
  );
  return JSON.stringify([
    phone?.authenticated ?? null,
    phone?.session?.user.id ?? null,
    phone?.activeRealm ?? null,
    cloud?.authenticated ?? null,
    cloud?.account?.id ?? null,
    cloud?.activeRealm ?? null,
    enterprise?.keyPrefix ?? null,
    enterprise?.active ?? null,
  ]);
}

export function readMossImagesAccountBoundary(queryClient: QueryClient): string {
  const transitioning = queryClient
    .getMutationCache()
    .getAll()
    .some(
      (mutation) =>
        mutation.state.status === "pending" &&
        AUTH_MUTATIONS.has(JSON.stringify(mutation.options.mutationKey)),
    );
  const phone = queryClient.getQueryState<MossAccountSessionState>(
    mossServerQueryKeys.mossAccountSession(),
  );
  const cloud = queryClient.getQueryState<MossCloudAccountState>(
    mossServerQueryKeys.mossCloudAccountState(),
  );
  const enterprise = queryClient.getQueryState<MossEnterpriseKeyState>(
    mossServerQueryKeys.mossEnterpriseKeyState(),
  );
  return `${transitioning ? "pending" : "settled"}:${JSON.stringify([
    phone?.status ?? null,
    phone?.data?.authenticated ?? null,
    phone?.data?.session?.user.id ?? null,
    phone?.data?.activeRealm ?? null,
    cloud?.status ?? null,
    cloud?.data?.authenticated ?? null,
    cloud?.data?.account?.id ?? null,
    cloud?.data?.activeRealm ?? null,
    enterprise?.status ?? null,
    enterprise?.data?.keyPrefix ?? null,
    enterprise?.data?.active ?? null,
  ])}`;
}

/** React Query is already the app's account-change source; observe it without another auth cache. */
export function useMossImagesAccountBoundary() {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) => {
      // Ignore unrelated cache events: queries may be registered during another
      // component's render, when notifying an account observer would update it
      // from inside that render. Identity changes come only from these records.
      const offQueries = queryClient.getQueryCache().subscribe((event) => {
        if (ACCOUNT_QUERIES.has(JSON.stringify(event.query.queryKey))) notify();
      });
      const offMutations = queryClient.getMutationCache().subscribe((event) => {
        if (
          event.mutation &&
          AUTH_MUTATIONS.has(JSON.stringify(event.mutation.options.mutationKey))
        )
          notify();
      });
      return () => {
        offQueries();
        offMutations();
      };
    },
    [queryClient],
  );
  const getSnapshot = useCallback(() => readMossImagesAccountBoundary(queryClient), [queryClient]);
  const key = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isCurrent = useCallback(
    () => !key.startsWith("pending:") && getSnapshot() === key,
    [getSnapshot, key],
  );
  return {
    key,
    identityKey: readMossImagesAccountIdentity(queryClient),
    transitioning: key.startsWith("pending:"),
    isCurrent,
  };
}
