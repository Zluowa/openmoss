import type { MossAccountSessionState, MossCloudAccountState } from "@synara/contracts";

export type MossCloudCallbackDestination =
  | { readonly to: "/"; readonly freshChat: true }
  | { readonly to: "/reset-password" }
  | { readonly to: "/account" }
  | null;

export function resolveMossCloudCallbackDestination(
  state: Pick<MossCloudAccountState, "authenticated" | "lastAuthFlow">,
): MossCloudCallbackDestination {
  if (!state.authenticated) return null;
  if (state.lastAuthFlow === "recovery") {
    return { to: "/reset-password" };
  }
  if (state.lastAuthFlow === "google") {
    return { to: "/", freshChat: true };
  }
  if (state.lastAuthFlow === "signup") {
    return { to: "/account" };
  }
  return null;
}

export function shouldGuardMossCloudAccountRoute(
  state: Pick<MossCloudAccountState, "authenticated" | "configured"> | null | undefined,
  phoneState?: Pick<MossAccountSessionState, "authenticated" | "configured"> | null,
): boolean {
  const signInConfigured = Boolean(state?.configured || phoneState?.configured);
  const authenticated = Boolean(state?.authenticated || phoneState?.authenticated);
  // Membership is sold to phone and Google accounts. An enterprise key is
  // billed by its contract, and a personal provider login never bypasses the
  // Moss account gate.
  return signInConfigured && !authenticated;
}
