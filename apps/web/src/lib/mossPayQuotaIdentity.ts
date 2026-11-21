import type { MossAccountSessionState, MossCloudAccountState } from "@moss/contracts";

export function isMossPayAccountTransitionPending(input: {
  readonly phoneLoginCount: number;
  readonly phoneLogoutCount: number;
  readonly cloudAccountSwitchCount: number;
  readonly cloudLogoutCount: number;
}): boolean {
  return (
    input.phoneLoginCount +
      input.phoneLogoutCount +
      input.cloudAccountSwitchCount +
      input.cloudLogoutCount >
    0
  );
}

export function mossPayQuotaOwnerPrefix(accountIdentity: string | null | undefined): string | null {
  if (!accountIdentity) return null;
  const firstColon = accountIdentity.indexOf(":");
  if (firstColon <= 0) return null;
  const secondColon = accountIdentity.indexOf(":", firstColon + 1);
  if (secondColon <= firstColon + 1) return null;
  const lane = accountIdentity.slice(0, firstColon);
  if (lane !== "phone" && lane !== "cloud") return null;
  return accountIdentity.slice(0, secondColon + 1);
}

export function resolveMossPayQuotaAccountIdentity(
  phoneState:
    | Pick<MossAccountSessionState, "authenticated" | "session" | "activeRealm">
    | null
    | undefined,
  cloudState:
    | Pick<MossCloudAccountState, "authenticated" | "account" | "session" | "activeRealm">
    | null
    | undefined,
  accountTransitionPending = false,
): string | null {
  if (accountTransitionPending || phoneState === null || phoneState === undefined) {
    return null;
  }
  const cloudReady = Boolean(cloudState?.authenticated && cloudState.account && cloudState.session);
  const preferGlobal =
    cloudReady && (cloudState?.activeRealm === "global" || phoneState.activeRealm === "global");
  if (preferGlobal && cloudState?.account && cloudState.session) {
    return `cloud:${cloudState.account.id}:${cloudState.session.refreshedAt}`;
  }
  if (phoneState.authenticated && phoneState.session) {
    return `phone:${phoneState.session.user.id}:${phoneState.session.id}`;
  }
  const phoneExplicitlySignedOut =
    phoneState.authenticated === false && phoneState.session === null;
  if (phoneExplicitlySignedOut && cloudReady && cloudState?.account && cloudState.session) {
    return `cloud:${cloudState.account.id}:${cloudState.session.refreshedAt}`;
  }
  return null;
}
