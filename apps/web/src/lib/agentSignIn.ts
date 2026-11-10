// FILE: agentSignIn.ts
// Purpose: Signing in to an agent the person runs with their own account (Codex, Claude):
//   Moss runs the agent's own sign-in in the background, the browser opens on the agent's
//   page, and the agent turns ready once its credential lands. No terminal, no command.
// Layer: Web app domain logic
// Depends on: the native API (`server.startProviderLogin` / `server.cancelProviderLogin`) and
//   the `loginState` the server pushes with each provider status.

import type { ProviderInstanceId, ProviderKind, ServerProviderStatus } from "@moss/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { readNativeApi } from "../nativeApi";
import { isMossManagedProviderStatus } from "./providerAvailability";
import { reconcileServerProviderStatuses } from "./serverReactQuery";

/** Agents whose own sign-in Moss can run for the person. */
const IN_APP_SIGN_IN_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);

/**
 * Whether Moss can sign this agent account in by itself. Moss's own provider signs in
 * with the Moss account instead, and API-key accounts have nothing to sign in.
 */
export function supportsAgentSignIn(
  provider: ProviderKind,
  status: Pick<ServerProviderStatus, "instanceId" | "displayName"> | null | undefined,
): boolean {
  if (!IN_APP_SIGN_IN_PROVIDERS.has(provider)) return false;
  const instanceId = status?.instanceId ?? provider;
  return !isMossManagedProviderStatus(status) && !instanceId.endsWith("_byok");
}

export type AgentSignInState = "idle" | "signingIn" | "verifying" | "failed";

/** The sign-in the server reports on the agent's status, while it runs or after it failed. */
export function readAgentSignInState(
  status: Pick<ServerProviderStatus, "loginState"> | null | undefined,
): AgentSignInState | null {
  switch (status?.loginState?.status) {
    case "starting":
    case "waiting_browser":
      return "signingIn";
    case "verifying":
      return "verifying";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** One agent account's sign-in: start it, cancel it, and follow it on the agent's status. */
export function useAgentSignIn(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly status: Pick<ServerProviderStatus, "loginState"> | null | undefined;
}) {
  const instanceId = input.instanceId ?? (input.provider as ProviderInstanceId);
  const queryClient = useQueryClient();
  // Covers the moment between the click and the status showing this attempt: until then
  // the status still describes the previous one (or none), which must not flash back.
  const [pendingSince, setPendingSince] = useState<{ readonly previous: string | null } | null>(
    null,
  );
  const [startFailed, setStartFailed] = useState(false);
  const currentStartedAt = input.status?.loginState?.startedAt ?? null;
  const awaitingServer = pendingSince !== null && pendingSince.previous === currentStartedAt;
  useEffect(() => {
    if (pendingSince !== null && pendingSince.previous !== currentStartedAt) {
      setPendingSince(null);
    }
  }, [currentStartedAt, pendingSince]);
  const serverState = readAgentSignInState(input.status);
  const state: AgentSignInState = awaitingServer
    ? "signingIn"
    : (serverState ?? (startFailed ? "failed" : "idle"));

  const start = async () => {
    const api = readNativeApi();
    if (!api) {
      setStartFailed(true);
      return;
    }
    setPendingSince({ previous: currentStartedAt });
    setStartFailed(false);
    try {
      // The answer already carries `waiting_browser`; show it now rather than on the push.
      const result = await api.server.startProviderLogin({ provider: input.provider, instanceId });
      await reconcileServerProviderStatuses(queryClient, result.providers);
    } catch {
      setPendingSince(null);
      setStartFailed(true);
    }
  };

  const cancel = async () => {
    const api = readNativeApi();
    if (!api) return;
    try {
      const result = await api.server.cancelProviderLogin({ provider: input.provider, instanceId });
      await reconcileServerProviderStatuses(queryClient, result.providers);
    } catch {
      // Nothing was running any more; the status already says how it ended.
    }
  };

  return { state, start, cancel };
}
