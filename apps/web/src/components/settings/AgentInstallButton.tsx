// FILE: AgentInstallButton.tsx
// Purpose: The one 安装 button on an agent's Settings row: installs it in one click (or opens
//   its official install page), follows the install, then says plainly how it went.
// Layer: Settings UI components
// Depends on: the agent install adapter, the shared readiness/install copy.

import type { ProviderKind, ServerProviderStatus } from "@moss/contracts";

import { readAgentInstallState, useAgentInstall } from "~/lib/agentInstall";
import { DownloadIcon, Loader2Icon } from "~/lib/icons";
import type { AgentReadiness } from "~/lib/providerAvailability";
import { providerInstallStateKey } from "~/lib/providerReadinessCopy";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";

export function AgentInstallButton(props: {
  provider: ProviderKind;
  /** The agent's name, as the copy names it. */
  providerLabel: string;
  readiness: Pick<AgentReadiness, "install" | "installUrl">;
  /** The agent's provider status: an install the server is running shows here too. */
  status: Pick<ServerProviderStatus, "installState"> | undefined;
  /** The agent's official page, for when the server names none. */
  fallbackUrl?: string | undefined;
}) {
  const { t, format } = useTranslation();
  const install = useAgentInstall(props.provider, props.fallbackUrl);
  const serverInstall = props.status?.installState ?? null;
  const serverState = readAgentInstallState(props.status);
  // The server's own report wins while it runs; this button's click covers the gap before.
  const state =
    serverState === "installing" || install.state === "idle"
      ? (serverState ?? install.state)
      : install.state;
  const installState = serverInstall ?? install.endedState;
  const lineKey =
    state === "idle"
      ? null
      : (providerInstallStateKey(installState) ??
        (state === "installing"
          ? "provider.install.installing"
          : state === "done"
            ? "provider.install.succeeded"
            : "provider.install.failed.download-failed"));
  const line = lineKey ? format(lineKey, { provider: props.providerLabel }) : null;
  return (
    <span className="inline-flex items-center gap-2">
      {line ? (
        <span
          className={
            state === "failed" ? "text-ui-sm text-destructive" : "text-ui-sm text-muted-foreground"
          }
          role="status"
        >
          {line}
        </span>
      ) : null}
      {state === "done" ? null : (
        <Button
          type="button"
          size="xs"
          disabled={state === "installing"}
          onClick={() => void install.install(props.readiness)}
        >
          {state === "installing" ? (
            <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <DownloadIcon aria-hidden="true" className="size-3.5" />
          )}
          {state === "failed" ? t("provider.install.retry") : t("provider.readiness.installAction")}
        </Button>
      )}
    </span>
  );
}
