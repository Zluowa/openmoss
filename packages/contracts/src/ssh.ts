// FILE: ssh.ts
// Purpose: Desktop SSH connection records and the narrow settings bridge contract.
// Layer: Shared schemas
// Exports: SshConnection, SshConnectionState, DesktopSshBridge
import { Schema } from "effect";

export const SshConnection = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  host: Schema.String,
  port: Schema.optional(Schema.Number),
  identityFile: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
});
export type SshConnection = typeof SshConnection.Type;
export interface SshConfigHost {
  readonly alias: string;
  readonly host: string;
  readonly user?: string;
  readonly port: number;
  readonly identityFile?: string;
  readonly usesProxy: boolean;
}
export const SshConnectionState = Schema.Struct({
  connection: SshConnection,
  status: Schema.Literals([
    "disconnected",
    "connecting",
    "connected",
    "failed",
    "host-key-required",
  ]),
  phase: Schema.optional(Schema.Literals(["runtime", "agents", "starting"])),
  errorCode: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  previousFingerprint: Schema.optional(Schema.String),
  hostKeyHost: Schema.optional(Schema.String),
});
export type SshConnectionState = typeof SshConnectionState.Type;
export interface DesktopSshBridge {
  list: () => Promise<ReadonlyArray<SshConnectionState>>;
  listConfigHosts: () => Promise<ReadonlyArray<SshConfigHost>>;
  save: (
    connection: Omit<SshConnection, "id"> & { readonly id?: string },
  ) => Promise<SshConnection>;
  remove: (id: string) => Promise<void>;
  connect: (input: {
    readonly id: string;
    readonly trustFingerprint?: string;
  }) => Promise<SshConnectionState>;
  disconnect: (id: string) => Promise<void>;
  pickIdentityFile: () => Promise<string | null>;
}
