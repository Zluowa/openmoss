import type { MossAccountSessionState, MossCloudAccountState } from "@synara/contracts";

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

export function resolveMossPayQuotaAccountIdentity(
  phoneState: Pick<MossAccountSessionState, "authenticated" | "session"> | null | undefined,
  cloudState:
    | Pick<MossCloudAccountState, "authenticated" | "account" | "session">
    | null
    | undefined,
  accountTransitionPending = false,
): string | null {
  if (accountTransitionPending || phoneState === null || phoneState === undefined) {
    return null;
  }
  if (phoneState.authenticated && phoneState.session) {
    return `phone:${phoneState.session.user.id}:${phoneState.session.id}`;
  }
  const phoneExplicitlySignedOut =
    phoneState.authenticated === false && phoneState.session === null;
  if (
    phoneExplicitlySignedOut &&
    cloudState?.authenticated &&
    cloudState.account &&
    cloudState.session
  ) {
    return `cloud:${cloudState.account.id}:${cloudState.session.refreshedAt}`;
  }
  return null;
}
