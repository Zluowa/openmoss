// FILE: phoneAccess.ts
// Purpose: The desktop's "Allow phone connections" setting: what is stored, which port
//          and address the backend gets, and the environment that makes it reachable.
// Layer: Desktop main process
// Depends on: filesystem for the preference; everything else is pure so it is testable
//             without Electron or a network.
//
// Off (the default, and whenever phone-access.json is missing or unreadable): the backend
// listens on a random loopback port, exactly as before this setting existed, and its
// environment gains nothing. On: it listens on every IPv4 interface at a port that stays
// the same across restarts, so a phone's saved address keeps working. Either way the
// desktop's own window keeps its private loopback connection (see `isLocalOnlyAccess` in
// the server).

import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopPhoneAccessState } from "@moss/contracts";

export const DEFAULT_PHONE_ACCESS_PORT = 3773;
/** How many ports after the preferred one are tried before giving up. */
const PHONE_ACCESS_PORT_ATTEMPTS = 20;

export interface PhoneAccessPreference {
  readonly version: 1;
  readonly enabled: boolean;
  /** The port phones were last told to use; kept so their saved address survives. */
  readonly port: number | null;
}

export const PHONE_ACCESS_OFF: PhoneAccessPreference = {
  version: 1,
  enabled: false,
  port: null,
};

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65_535;
}

export function parsePhoneAccessPreference(value: unknown): PhoneAccessPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.enabled !== "boolean") return null;
  return {
    version: 1,
    enabled: candidate.enabled,
    port: isPort(candidate.port) ? candidate.port : null,
  };
}

/** The stored preference; off when the file is missing or unreadable. */
export function readPhoneAccessPreference(filePath: string): PhoneAccessPreference {
  try {
    return (
      parsePhoneAccessPreference(JSON.parse(FS.readFileSync(filePath, "utf8"))) ?? PHONE_ACCESS_OFF
    );
  } catch {
    return PHONE_ACCESS_OFF;
  }
}

export function writePhoneAccessPreference(
  filePath: string,
  preference: PhoneAccessPreference,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(preference, null, 2)}\n`, "utf8");
}

/** What the renderer may ask for; anything else is dropped at the IPC boundary. */
export function parsePhoneAccessRequest(value: unknown): { readonly enabled: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== "boolean") return null;
  return { enabled: candidate.enabled };
}

/** How one backend start is exposed. Decided before the backend is spawned. */
export type PhoneAccessEndpoint =
  | { readonly mode: "off" }
  | { readonly mode: "lan"; readonly port: number };

export type PhoneAccessError = NonNullable<DesktopPhoneAccessState["error"]>;

export interface PhoneAccessResolution {
  readonly endpoint: PhoneAccessEndpoint;
  readonly error: PhoneAccessError | null;
}

export const PHONE_ACCESS_RESOLUTION_OFF: PhoneAccessResolution = {
  endpoint: { mode: "off" },
  error: null,
};

/** The remembered port, else 3773, else the next one nothing else is using. */
export async function pickPhoneAccessPort(input: {
  readonly remembered: number | null;
  readonly canListen: (port: number) => Promise<boolean>;
}): Promise<number | null> {
  const first = input.remembered ?? DEFAULT_PHONE_ACCESS_PORT;
  for (let offset = 0; offset < PHONE_ACCESS_PORT_ATTEMPTS; offset++) {
    const port = first + offset;
    if (port > 65_535) break;
    if (await input.canListen(port)) return port;
  }
  return null;
}

/**
 * Turns the preference into an endpoint for the next backend start. Nothing here
 * can stop Moss from starting: when no port is to be had, phones stay disconnected
 * and `error` says why. While the setting is off nothing is probed at all.
 */
export async function resolvePhoneAccessEndpoint(input: {
  readonly preference: PhoneAccessPreference;
  /** A dev server cannot be reached from a phone; the server refuses the combination. */
  readonly isDevelopment: boolean;
  readonly canListen: (port: number, host: string) => Promise<boolean>;
}): Promise<PhoneAccessResolution> {
  const { preference } = input;
  if (!preference.enabled || input.isDevelopment) return PHONE_ACCESS_RESOLUTION_OFF;
  const port = await pickPhoneAccessPort({
    remembered: preference.port,
    canListen: (candidate) => input.canListen(candidate, "0.0.0.0"),
  });
  if (port === null) {
    return { endpoint: { mode: "off" }, error: "port-unavailable" };
  }
  return { endpoint: { mode: "lan", port }, error: null };
}

/** The address the backend binds for this endpoint (the desktop always dials loopback). */
export function phoneAccessBindHost(endpoint: PhoneAccessEndpoint): "127.0.0.1" | "0.0.0.0" {
  return endpoint.mode === "lan" ? "0.0.0.0" : "127.0.0.1";
}

/**
 * The backend environment for an endpoint. Off adds nothing: the backend keeps today's
 * loopback default, and only the phone-access flag itself is dropped if a launching shell
 * happened to carry it. On, every key is set, so an inherited value cannot change it.
 */
export function phoneAccessBackendEnv(
  endpoint: PhoneAccessEndpoint,
): Partial<
  Record<
    "MOSS_HOST" | "MOSS_ALLOW_INSECURE_REMOTE" | "MOSS_DESKTOP_PHONE_ACCESS" | "MOSS_PUBLIC_URL",
    string | undefined
  >
> {
  if (endpoint.mode === "off") return { MOSS_DESKTOP_PHONE_ACCESS: undefined };
  return {
    MOSS_HOST: phoneAccessBindHost(endpoint),
    // Plain HTTP on the local network is the trade-off the owner accepted in Settings.
    MOSS_ALLOW_INSECURE_REMOTE: "1",
    MOSS_DESKTOP_PHONE_ACCESS: "1",
    MOSS_PUBLIC_URL: undefined,
  };
}

/** What Settings shows: the stored choice next to what the running backend really does. */
export function resolvePhoneAccessState(input: {
  readonly preference: PhoneAccessPreference;
  readonly endpoint: PhoneAccessEndpoint;
  readonly error: PhoneAccessError | null;
  readonly isDevelopment: boolean;
}): DesktopPhoneAccessState {
  return {
    enabled: input.preference.enabled,
    active: input.endpoint.mode,
    unavailableReason: input.isDevelopment ? "development" : null,
    error: input.error,
  };
}
