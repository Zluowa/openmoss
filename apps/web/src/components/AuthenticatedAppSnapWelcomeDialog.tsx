// FILE: AuthenticatedAppSnapWelcomeDialog.tsx
// Purpose: Keep the first-run AppSnap introduction behind Moss account authentication, so
// it never covers the sign-in pages; the startup surfaces it wraps still render.
// Layer: Root web overlay authentication gate

import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossEnterpriseKeyState,
} from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

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

export function AuthenticatedAppSnapWelcomeDialog({ children }: { children?: ReactNode }) {
  const phoneAccountQuery = useQuery(serverMossAccountSessionQueryOptions());
  const cloudAccountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const enterpriseKeyQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());

  const signedIn = hasAuthenticatedMossAccount({
    phone: phoneAccountQuery.data,
    cloud: cloudAccountQuery.data,
    enterprise: enterpriseKeyQuery.data,
  });

  return <AppSnapWelcomeDialog deferred={!signedIn}>{children}</AppSnapWelcomeDialog>;
}
