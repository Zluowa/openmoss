// FILE: agentInstall.ts
// Purpose: Installing an agent the person does not have yet: where the picker sends them
//   (Settings, at that agent) and the one 安装 button's install itself, behind one adapter.
// Layer: Web app domain logic
// Depends on: the native API (`server.installProvider`), provider readiness and install state.

import type {
  ProviderKind,
  ServerProviderInstallState,
  ServerProviderStatus,
} from "@moss/contracts";
import { useState } from "react";

import { readNativeApi } from "../nativeApi";
import type { AgentReadiness } from "./providerAvailability";

/** The DOM id of an agent's row in Settings > providers, for deep links. */
export function agentSettingsAnchorId(provider: ProviderKind): string {
  return `provider-${provider}`;
}

/** Settings at the agent's row: its sign-in, its 安装 button, its status. */
export function agentSettingsHref(provider: ProviderKind): string {
  return `/settings?section=providers&provider=${provider}&target=${agentSettingsAnchorId(provider)}`;
}

export type AgentInstallState = "idle" | "installing" | "done" | "failed";

/**
 * The install the server reports on the agent's status (`installState`), when one is
 * running or just ended there, so progress shows in whichever window started it.
 */
export function readAgentInstallState(
  status: Pick<ServerProviderStatus, "installState"> | null | undefined,
): AgentInstallState | null {
  switch (status?.installState?.status) {
    case "queued":
    case "running":
      return "installing";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** One agent's install: start it, follow it, and report how it ended. */
export function useAgentInstall(
  provider: ProviderKind,
  /** The agent's official page, opened when the server names none. */
  fallbackUrl?: string | undefined,
) {
  const [state, setState] = useState<AgentInstallState>("idle");
  // How the last install this button started ended, for its plain reason line.
  const [endedState, setEndedState] = useState<ServerProviderInstallState | null>(null);
  const install = async (readiness: Pick<AgentReadiness, "install" | "installUrl">) => {
    const api = readNativeApi();
    if (readiness.install !== "oneClick") {
      // The agent's official install page, in the system browser.
      const pageUrl = readiness.installUrl ?? fallbackUrl;
      if (pageUrl && api) {
        try {
          await api.shell.openExternal(pageUrl);
          return;
        } catch {
          setState("failed");
          return;
        }
      }
      setState("failed");
      return;
    }
    if (!api) {
      setState("failed");
      return;
    }
    setState("installing");
    setEndedState(null);
    try {
      // Resolves once the install ended, either way; the agent's own status says how.
      const result = await api.server.installProvider({ provider });
      const status = result.providers.find(
        (entry) => (entry.driver ?? entry.provider) === provider && entry.instanceId === provider,
      );
      setEndedState(status?.installState ?? null);
      setState(readAgentInstallState(status) === "failed" ? "failed" : "done");
    } catch {
      setState("failed");
    }
  };
  return { state, endedState, install };
}
