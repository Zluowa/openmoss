// FILE: AuthenticatedAppSnapWelcomeDialog.tsx
// Purpose: Keep the first-run AppSnap introduction behind Moss account authentication.
// Layer: Root web overlay authentication gate

import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossEnterpriseKeyState,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "./auth/mossServerReactQuery";
import { AppSnapWelcomeDialog } from "./AppSnapWelcomeDialog";

export function hasAuthenticatedMossAccount(input: {
  phone: Pick<MossAccountSessionState, "authenticated"> | null | undefined;
  cloud: Pick<MossCloudAccountState, "authenticated"> | null | undefined;
  enterprise?: Pick<MossEnterpriseKeyState, "authenticated"> | null | undefined;
}): boolean {
  return (
    input.phone?.authenticated === true ||
    input.cloud?.authenticated === true ||
    input.enterprise?.authenticated === true
  );
}

export function AuthenticatedAppSnapWelcomeDialog() {
  const phoneAccountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const cloudAccountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const enterpriseKeyQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());

  if (
    !hasAuthenticatedMossAccount({
      phone: phoneAccountQuery.data,
      cloud: cloudAccountQuery.data,
      enterprise: enterpriseKeyQuery.data,
    })
  ) {
    return null;
  }

  return <AppSnapWelcomeDialog />;
}
