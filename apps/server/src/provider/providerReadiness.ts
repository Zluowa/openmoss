// FILE: providerReadiness.ts
// Purpose: The one server-decided answer to "can this person use this agent now", attached to
//          every provider status so the picker and settings never guess from raw messages.
// Layer: Provider health (server).

import type { ProviderKind, ServerProviderReadiness, ServerProviderStatus } from "@moss/contracts";

import { type DesktopAgentKind, knownAgentDesktopInstall } from "./agentDesktopInstalls.ts";
import { resolveProviderInstallAction } from "./providerInstall.ts";

const DESKTOP_AGENT_KINDS: ReadonlySet<ProviderKind> = new Set(["cursor", "zcode", "devin"]);

const DISABLED_PROVIDER_STATUS_MESSAGE = "Provider is disabled in Moss settings.";
const UNCHECKED_PROVIDER_STATUS_MESSAGE = "Provider instance has not been checked yet.";

/** What a probe sets when the CLI is simply not there. Install details are filled in later. */
export const PROVIDER_NOT_INSTALLED_READINESS: ServerProviderReadiness = { state: "notInstalled" };

function isMossManagedInstance(status: ServerProviderStatus, managed: boolean): boolean {
  return managed || (status.instanceId ?? "").endsWith("_moss");
}

/**
 * Error codes are matched on the probe's English sentence because the probes predate this
 * field; anything unrecognised falls back to `failed-to-run`, never to the raw text.
 */
function classifyProviderErrorReason(status: ServerProviderStatus, managed: boolean): string {
  const message = status.message ?? "";
  if (
    /Reinstall Moss|Packaged Moss is missing|managed Claude runtime is unavailable/iu.test(message)
  ) {
    return "moss-runtime-damaged";
  }
  // Moss updated (or someone replaced) the agent's program while it ran. Every account on
  // that program, Moss's included, waits for a restart: say so instead of "unavailable".
  if (/program changed\. Restart Moss/iu.test(message)) return "restart-required";
  if (managed) return "moss-unavailable";
  if (/not supported by this Moss build/iu.test(message)) return "unsupported-driver";
  if (/Git Bash/u.test(message)) return "needs-git-bash";
  if (/\bor newer\b|\bupgrade\b|\bminimum\b|too old/iu.test(message)) return "version-unsupported";
  if (/account home|provider home|CODEX_HOME|refusing to/iu.test(message))
    return "home-unavailable";
  return "failed-to-run";
}

function withInstallAction(
  provider: ProviderKind,
  readiness: ServerProviderReadiness,
): ServerProviderReadiness {
  if (readiness.state !== "notInstalled") return readiness;
  // The desktop app is here but Moss needs its command-line part: the row says so, and
  // 安装 installs exactly that part.
  const desktopApp =
    DESKTOP_AGENT_KINDS.has(provider) &&
    knownAgentDesktopInstall(provider as DesktopAgentKind) !== null;
  // Derived on every pass, so a cached status never keeps a stale answer.
  const { reason: carriedReason, ...rest } = readiness;
  const reason = desktopApp
    ? "desktop-app-only"
    : carriedReason === "desktop-app-only"
      ? undefined
      : carriedReason;
  const withReason: ServerProviderReadiness = reason ? { ...rest, reason } : rest;
  if (withReason.install) return withReason;
  const action = resolveProviderInstallAction(provider);
  return action ? { ...withReason, ...action } : withReason;
}

export function deriveProviderReadiness(
  status: ServerProviderStatus,
  options: { readonly managed?: boolean } = {},
): ServerProviderReadiness {
  const provider = (status.driver ?? status.provider) as ProviderKind;
  const managed = isMossManagedInstance(status, options.managed ?? false);
  const disabled =
    status.enabled === false ||
    (status.available === false && status.message === DISABLED_PROVIDER_STATUS_MESSAGE);
  if (disabled) {
    // Signing out of Moss turns its provider off; the way back is signing in.
    return managed
      ? { state: "needsLogin", reason: "moss-sign-in" }
      : { state: "error", reason: "disabled" };
  }
  // Probes only ever mark "not installed"; every other state is derived here, so a stale
  // derived value carried on a cached status can never win.
  if (status.readiness?.state === "notInstalled") {
    return withInstallAction(provider, status.readiness);
  }
  if (
    status.status === "warning" &&
    !status.available &&
    status.message === UNCHECKED_PROVIDER_STATUS_MESSAGE
  ) {
    return { state: "checking" };
  }
  if (status.authStatus === "unauthenticated") {
    return { state: "needsLogin", reason: managed ? "moss-sign-in" : "agent-sign-in" };
  }
  if (status.available && status.status !== "error") return { state: "ready" };
  if (managed && status.status === "warning") return { state: "checking" };
  return { state: "error", reason: classifyProviderErrorReason(status, managed) };
}

export function withProviderReadiness(
  status: ServerProviderStatus,
  options: { readonly managed?: boolean } = {},
): ServerProviderStatus {
  return { ...status, readiness: deriveProviderReadiness(status, options) };
}
