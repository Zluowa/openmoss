import { useIsMutating, useQuery } from "@tanstack/react-query";

import {
  isMossPayAccountTransitionPending,
  resolveMossPayQuotaAccountIdentity,
} from "~/lib/mossPayQuotaIdentity";
import {
  mossServerMutationKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "~/components/auth/mossServerReactQuery";

export type ManagedMossVoiceAccountReadiness =
  | "not-applicable"
  | "loading"
  | "ready"
  | "authentication-required"
  | "unavailable";

/**
 * Inlined from the pre-merge ~/lib/providerAvailability; upstream rewrote that
 * module and this readiness resolver is owned by the Moss voice surface.
 */
export function resolveManagedMossVoiceAccountReadiness(input: {
  readonly applies: boolean;
  readonly accountIdentity: string | null;
  /** An enterprise key that owns Moss pays for voice like a signed-in account. */
  readonly enterpriseKeyActive?: boolean;
  readonly accountTransitionPending: boolean;
  readonly phoneAccountPending: boolean;
  readonly cloudAccountPending: boolean;
  readonly phoneAccountError: boolean;
  readonly cloudAccountError: boolean;
}): ManagedMossVoiceAccountReadiness {
  if (!input.applies) return "not-applicable";
  if (input.accountIdentity !== null || input.enterpriseKeyActive) return "ready";
  if (input.accountTransitionPending || input.phoneAccountPending || input.cloudAccountPending) {
    return "loading";
  }
  if (input.phoneAccountError || input.cloudAccountError) return "unavailable";
  return "authentication-required";
}

export function useManagedMossVoiceAccountReadiness(enabled: boolean) {
  const phoneLoginCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossPhoneLogin(),
  });
  const phoneLogoutCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossLogout(),
  });
  const cloudAccountSwitchCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossCloudSelect(),
  });
  const cloudLogoutCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossCloudLogout(),
  });
  const accountTransitionPending = isMossPayAccountTransitionPending({
    phoneLoginCount,
    phoneLogoutCount,
    cloudAccountSwitchCount,
    cloudLogoutCount,
  });
  const phoneAccountQuery = useQuery(serverMossAccountSessionQueryOptions({ enabled }));
  const cloudAccountQuery = useQuery(serverMossCloudAccountStateQueryOptions({ enabled }));
  const enterpriseKeyQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions({ enabled }));
  const accountIdentity = resolveMossPayQuotaAccountIdentity(
    phoneAccountQuery.data,
    cloudAccountQuery.data,
    accountTransitionPending,
  );

  return resolveManagedMossVoiceAccountReadiness({
    applies: enabled,
    accountIdentity,
    enterpriseKeyActive: enterpriseKeyQuery.data?.active === true,
    accountTransitionPending,
    phoneAccountPending: phoneAccountQuery.isPending,
    cloudAccountPending: cloudAccountQuery.isPending,
    phoneAccountError: phoneAccountQuery.isError,
    cloudAccountError: cloudAccountQuery.isError,
  });
}
