// FILE: useMossGatewayUnreachable.ts
// Purpose: The signed-in Moss account's gateway state, from the phone, Google and enterprise
//          key accounts. "Unreachable" is a timeout, a network error or a Cloudflare 5xx: the
//          account stays signed in and its lanes stay set up, so surfaces say "Moss can't be
//          reached" instead of "sign in".
// Layer: React hooks over the Moss account queries

import { useQuery } from "@tanstack/react-query";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "./mossServerReactQuery";

interface MossAccountGatewayInput {
  readonly authenticated: boolean;
  readonly modelGatewayStatus?: string | undefined;
}

/** The account state's gateway answer means "unreachable", not an answer about the account. */
export function isMossGatewayUnreachableState(state: MossAccountGatewayInput | undefined): boolean {
  return state?.authenticated === true && state.modelGatewayStatus === "transport-degraded";
}

/** What Settings → 模型账号 says about Moss. */
export type MossAccountGatewayState =
  | "checking"
  | "signed-out"
  | "connected"
  | "unreachable"
  | "unavailable";

/**
 * One answer across the ways to sign in to Moss. A ready gateway on any signed-in account
 * wins; then "can't be reached"; then a refusal (no plan, key denied). A signed-in account
 * whose gateway hasn't answered yet reads as connected, like the lanes it already has.
 */
export function resolveMossAccountGatewayState(input: {
  readonly accounts: ReadonlyArray<MossAccountGatewayInput | undefined>;
  readonly loading: boolean;
}): MossAccountGatewayState {
  const signedIn = input.accounts.filter(
    (account): account is MossAccountGatewayInput => account?.authenticated === true,
  );
  if (signedIn.length === 0) {
    return input.loading ? "checking" : "signed-out";
  }
  const statuses = new Set(signedIn.map((account) => account.modelGatewayStatus));
  if (statuses.has("ready")) return "connected";
  if (statuses.has("transport-degraded")) return "unreachable";
  if (statuses.has("auth-denied") || statuses.has("no-entitlement")) return "unavailable";
  return "connected";
}

function useMossAccountGatewayInputs() {
  const phone = useQuery(serverMossAccountSessionQueryOptions());
  const cloud = useQuery(serverMossCloudAccountStateQueryOptions());
  const enterprise = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  const enterpriseState = enterprise.data;
  return {
    accounts: [
      phone.data,
      cloud.data,
      // A stored key counts only while it owns the Moss lanes.
      enterpriseState
        ? {
            authenticated: enterpriseState.authenticated && enterpriseState.active,
            modelGatewayStatus: enterpriseState.modelGatewayStatus,
          }
        : undefined,
    ],
    loading: phone.isPending || cloud.isPending || enterprise.isPending,
  };
}

export function useMossGatewayUnreachable(): boolean {
  const { accounts } = useMossAccountGatewayInputs();
  return accounts.some(isMossGatewayUnreachableState);
}

export function useMossAccountGatewayState(): MossAccountGatewayState {
  return resolveMossAccountGatewayState(useMossAccountGatewayInputs());
}
