// FILE: useMossGatewayUnreachable.ts
// Purpose: Whether the signed-in Moss account's model gateway can't be reached right now
//          (a timeout, a network error, a Cloudflare 5xx). The account stays signed in and its
//          lanes stay set up; surfaces say "Moss can't be reached" instead of "sign in".
// Layer: React hook over the Moss account queries

import { useQuery } from "@tanstack/react-query";

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "./mossServerReactQuery";

/** The account state's gateway answer means "unreachable", not an answer about the account. */
export function isMossGatewayUnreachableState(
  state:
    | { readonly authenticated: boolean; readonly modelGatewayStatus?: string | undefined }
    | undefined,
): boolean {
  return state?.authenticated === true && state.modelGatewayStatus === "transport-degraded";
}

export function useMossGatewayUnreachable(): boolean {
  const phone = useQuery(serverMossAccountSessionQueryOptions()).data;
  const cloud = useQuery(serverMossCloudAccountStateQueryOptions()).data;
  return isMossGatewayUnreachableState(phone) || isMossGatewayUnreachableState(cloud);
}
