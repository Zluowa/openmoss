// FILE: providerReadinessCopy.ts
// Purpose: Maps the server's readiness and install codes to translation keys, so the picker
//          and settings show the same calm copy and never a raw English diagnostic.
// Layer: Web presentation helpers.

import type {
  ServerProviderInstallState,
  ServerProviderReadiness,
  ServerProviderReadinessState,
} from "@moss/contracts";

import type { TranslationKey } from "~/localization";

export const PROVIDER_READINESS_LABEL_KEY: Readonly<
  Record<ServerProviderReadinessState, TranslationKey>
> = {
  ready: "provider.readiness.ready",
  checking: "provider.readiness.checking",
  needsLogin: "provider.readiness.needsLogin",
  notInstalled: "provider.readiness.notInstalled",
  error: "provider.readiness.error",
};

const READINESS_REASON_KEYS: Readonly<Record<string, TranslationKey>> = {
  "moss-sign-in": "provider.readiness.reason.moss-sign-in",
  "agent-sign-in": "provider.readiness.reason.agent-sign-in",
  "failed-to-run": "provider.readiness.reason.failed-to-run",
  "version-unsupported": "provider.readiness.reason.version-unsupported",
  "moss-runtime-damaged": "provider.readiness.reason.moss-runtime-damaged",
  "moss-unavailable": "provider.readiness.reason.moss-unavailable",
  "home-unavailable": "provider.readiness.reason.home-unavailable",
  "needs-git-bash": "provider.readiness.reason.needs-git-bash",
  "unsupported-driver": "provider.readiness.reason.unsupported-driver",
  disabled: "provider.readiness.reason.disabled",
};

/**
 * The one line under an agent that is not ready, formatted with `{provider}`. Null when the
 * agent is ready or still being checked.
 */
export function providerReadinessDescriptionKey(
  readiness: ServerProviderReadiness | null | undefined,
): TranslationKey | null {
  if (!readiness) return null;
  switch (readiness.state) {
    case "ready":
    case "checking":
      return null;
    case "notInstalled":
      // The desktop app is here; Moss needs the command-line part its 安装 button installs.
      return readiness.reason === "desktop-app-only"
        ? "provider.readiness.notInstalled.desktopApp"
        : "provider.readiness.notInstalled.description";
    case "needsLogin":
      return (
        READINESS_REASON_KEYS[readiness.reason ?? ""] ?? "provider.readiness.reason.agent-sign-in"
      );
    case "error":
      return (
        READINESS_REASON_KEYS[readiness.reason ?? ""] ?? "provider.readiness.reason.failed-to-run"
      );
  }
}

const INSTALL_FAILURE_KEYS: Readonly<Record<string, TranslationKey>> = {
  "npm-unavailable": "provider.install.failed.npm-unavailable",
  "download-failed": "provider.install.failed.download-failed",
  "verify-failed": "provider.install.failed.verify-failed",
  "cleanup-unproven": "provider.install.failed.cleanup-unproven",
  "timed-out": "provider.install.failed.timed-out",
  "not-installable": "provider.install.failed.not-installable",
  disabled: "provider.install.failed.disabled",
};

/** Progress or result line for a one-click install, formatted with `{provider}`. */
export function providerInstallStateKey(
  installState: ServerProviderInstallState | null | undefined,
): TranslationKey | null {
  if (!installState) return null;
  switch (installState.status) {
    case "queued":
      return "provider.install.queued";
    case "running":
      return installState.phase === "verifying"
        ? "provider.install.verifying"
        : "provider.install.installing";
    case "succeeded":
      return "provider.install.succeeded";
    case "failed":
      return (
        INSTALL_FAILURE_KEYS[installState.reason ?? ""] ?? "provider.install.failed.download-failed"
      );
  }
}
