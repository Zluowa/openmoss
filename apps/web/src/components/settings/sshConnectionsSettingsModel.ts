// FILE: sshConnectionsSettingsModel.ts
// Purpose: Connection status/error copy and normalized alias identity shared by the SSH UI.
// Layer: Settings model
import type { SshConnectionState } from "@moss/contracts";
import type { TranslationKey } from "~/localization";
export const SSH_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  "invalid-name": "settings.ssh.error.name",
  "invalid-host": "settings.ssh.error.host",
  "invalid-port": "settings.ssh.error.port",
  "invalid-identity": "settings.ssh.error.identity",
  authentication: "settings.ssh.error.authentication",
  "host-key": "settings.ssh.error.hostKey",
  resolve: "settings.ssh.error.resolve",
  refused: "settings.ssh.error.refused",
  timeout: "settings.ssh.error.timeout",
  "runtime-missing": "settings.ssh.error.runtime",
  "runtime-install": "settings.ssh.error.runtimeInstall",
  "runtime-payload": "settings.ssh.error.payload",
  "runtime-integrity": "settings.ssh.error.integrity",
  "runtime-native": "settings.ssh.error.native",
  "runtime-platform": "settings.ssh.error.platform",
  "runtime-agent": "settings.ssh.error.agent",
  "proxy-unsupported": "settings.ssh.error.proxy",
  "ssh-missing": "settings.ssh.error.sshMissing",
  "runtime-upload": "settings.ssh.error.upload",
  "runtime-busy": "settings.ssh.error.busy",
  storage: "settings.ssh.error.storage",
  "workspace-load": "settings.ssh.error.workspaceLoad",
};
export const SSH_STATUS_KEYS: Readonly<Record<SshConnectionState["status"], TranslationKey>> = {
  disconnected: "settings.ssh.disconnected",
  connecting: "settings.ssh.connecting",
  connected: "settings.ssh.connected",
  failed: "settings.ssh.failed",
  "host-key-required": "settings.ssh.verifyHost",
};
export const SSH_PHASE_KEYS: Readonly<
  Record<NonNullable<SshConnectionState["phase"]>, TranslationKey>
> = {
  runtime: "settings.ssh.preparingRuntime",
  agents: "settings.ssh.preparingAgents",
  starting: "settings.ssh.startingWorkspace",
};
export function sshFailureTranslationKey(value: unknown): TranslationKey {
  const message = value instanceof Error ? value.message : String(value);
  const code = Object.keys(SSH_ERROR_KEYS).find((candidate) => message.includes(candidate));
  return code ? SSH_ERROR_KEYS[code]! : "settings.ssh.error.connection";
}
export const sshHostIdentity = (host: string): string => host.trim().toLowerCase();
