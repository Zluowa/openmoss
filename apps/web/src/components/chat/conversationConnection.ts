import type { ThreadSession } from "../../types";
import type { OrchestrationThreadActivity } from "@synara/contracts";

export type ConversationConnectionStatus = "loading" | "reconnecting";

export function readProviderConnectionActivity(
  activities: readonly OrchestrationThreadActivity[],
  providerKey: string,
  provider: ThreadSession["provider"] | undefined,
): { isConnecting: boolean; hasEstablishedSession: boolean } {
  let isConnecting = false;
  let hasEstablishedSession = false;
  for (const activity of activities) {
    if (activity.kind !== "provider.session.connection") continue;
    const payload = activity.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const connection = payload as Record<string, unknown>;
    if (
      connection.providerInstanceId !== undefined
        ? connection.providerInstanceId !== providerKey
        : connection.provider !== provider
    )
      continue;
    isConnecting = connection.state === "starting";
    hasEstablishedSession ||= connection.state === "ready" || connection.state === "running";
  }
  return { isConnecting, hasEstablishedSession };
}

export function isEstablishedConversationSession(session: ThreadSession | null): boolean {
  return (
    session?.orchestrationStatus === "ready" ||
    session?.orchestrationStatus === "running" ||
    session?.orchestrationStatus === "interrupted"
  );
}

/** Transport startup/resume only. Queueing, approval waits and stream retries are separate. */
export function deriveConversationConnectionStatus({
  session,
  isStarting,
  isResuming,
  hasEstablishedSession,
  isProviderConnecting,
}: {
  session: ThreadSession | null;
  isStarting: boolean;
  isResuming: boolean;
  hasEstablishedSession: boolean;
  isProviderConnecting: boolean;
}): ConversationConnectionStatus | null {
  if (isProviderConnecting && session?.status === "connecting") {
    return hasEstablishedSession ? "reconnecting" : "loading";
  }
  // Ordinary sends optimistically set `starting`, and resuming a turn need not
  // reconnect a provider. Neither proves a transport restart of a ready session.
  if (!hasEstablishedSession && (isStarting || isResuming || session?.status === "connecting")) {
    return "loading";
  }
  return null;
}
