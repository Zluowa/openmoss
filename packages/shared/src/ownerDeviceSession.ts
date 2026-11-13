// FILE: ownerDeviceSession.ts
// Purpose: How a session of the owner's own phone records the way it was created.
// Layer: Shared pure logic (server issues and revokes; the interface lists)
// Exports: OWNER_DEVICE_SUBJECT, isOwnerDeviceSubject, accountDeviceSubject,
//   isAccountDeviceSubject
// Why: a phone paired by code and a phone admitted through a Moss account are both owner
//   devices, but signing the computer out of an account must end exactly the sessions that
//   account created. The session subject carries that provenance, so no stored field and no
//   migration are needed.

/** A phone paired with a code from Settings (and the code itself). */
export const OWNER_DEVICE_SUBJECT = "owner-device";

const ACCOUNT_PREFIX = `${OWNER_DEVICE_SUBJECT}:account:`;

/** Any session of the owner's own phone, however it was created. */
export function isOwnerDeviceSubject(subject: string): boolean {
  return subject === OWNER_DEVICE_SUBJECT || subject.startsWith(`${OWNER_DEVICE_SUBJECT}:`);
}

/**
 * The subject of a phone session created through account sign-in. `accountKey` is a
 * one-way digest of the account, never its id, email or phone number.
 */
export function accountDeviceSubject(realm: string, accountKey: string): string {
  return `${ACCOUNT_PREFIX}${realm}:${accountKey}`;
}

/** A session created through account sign-in, optionally for one realm and account. */
export function isAccountDeviceSubject(
  subject: string,
  scope?: { readonly realm: string; readonly accountKey?: string },
): boolean {
  if (!subject.startsWith(ACCOUNT_PREFIX)) return false;
  if (!scope) return true;
  if (scope.accountKey !== undefined) {
    return subject === accountDeviceSubject(scope.realm, scope.accountKey);
  }
  return subject.startsWith(`${ACCOUNT_PREFIX}${scope.realm}:`);
}
