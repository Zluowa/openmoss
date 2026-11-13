// FILE: phonePairingModel.ts
// Purpose: Pure rules for pairing the owner's phone: which addresses, which link, which sessions.
// Layer: Settings UI model
import type {
  AuthClientSession,
  AuthPairingLink,
  DesktopPhoneAccessState,
  ServerConfig,
} from "@moss/contracts";
import { OWNER_DEVICE_SUBJECT, isOwnerDeviceSubject } from "@moss/shared/ownerDeviceSession";

/** Server subject of a code (and the session it becomes) made for the owner's own phone. */
export const PHONE_PAIRING_SUBJECT = OWNER_DEVICE_SUBJECT;

/** Origins a phone can open: the configured HTTPS origin first, then same-network ones. */
export function phonePairingOrigins(
  config: Pick<ServerConfig, "shareableOrigin" | "lanOrigins">,
): ReadonlyArray<string> {
  const origins = [
    ...(config.shareableOrigin ? [config.shareableOrigin] : []),
    ...(config.lanOrigins ?? []),
  ];
  return [...new Set(origins)];
}

/**
 * The one-time link the phone camera opens. The credential stays in the fragment so it
 * never reaches a server log or a proxy; `/pair` exchanges it for a session cookie.
 */
export function phonePairingUrl(origin: string, credential: string): string {
  const url = new URL(origin);
  url.pathname = "/pair";
  url.search = "";
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

export function isPhonePairingLink(link: AuthPairingLink): boolean {
  return link.subject === PHONE_PAIRING_SUBJECT;
}

/** A phone paired by code or admitted through the Moss account; never this window. */
export function isPairedPhoneSession(session: AuthClientSession): boolean {
  return isOwnerDeviceSubject(session.subject) && !session.current;
}

/** Plain-HTTP origins travel unencrypted; the panel says so next to the code. */
export function isPlaintextOrigin(origin: string): boolean {
  return origin.startsWith("http:");
}

/** A short, human label for an address chip: "192.168.1.42" rather than the full origin. */
export function phoneOriginLabel(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/** The one sentence under the desktop switch that says why phones cannot connect. */
export function phoneAccessProblemKey(
  state: Pick<DesktopPhoneAccessState, "unavailableReason" | "error">,
) {
  if (state.unavailableReason === "development") return "settings.phone.access.development";
  if (state.error === "port-unavailable") return "settings.phone.access.error.port";
  if (state.error === "restart-failed") return "settings.phone.access.error.restart";
  return null;
}
