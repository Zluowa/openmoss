// FILE: url.ts
// Purpose: Reads the share id and the one-time invite from the guest page URL.
// Layer: Guest page
// Why: The invite travels in the fragment so it never reaches relay or CDN logs. The page drops
//      it from the address bar at once (screenshots and copied links must not leak it) and keeps
//      it in sessionStorage until the name form redeems it, so a reload before joining still works.

import { GUEST_PAGE_PATH_PREFIX } from "@synara/contracts";

export interface GuestEntry {
  readonly shareId: string | null;
  /** The unspent invite credential, or null when this load has none. */
  readonly invite: string | null;
}

// Share ids are base64url; anything else in the path is not a share page.
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseShareId(pathname: string): string | null {
  if (!pathname.startsWith(GUEST_PAGE_PATH_PREFIX)) return null;
  const rest = pathname.slice(GUEST_PAGE_PATH_PREFIX.length);
  const shareId = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  return SHARE_ID_PATTERN.test(shareId) ? shareId : null;
}

/** A malformed fragment is an invalid link, not a crash. */
export function parseInviteHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return null;
  let credential: string;
  try {
    credential = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  return credential === "" || credential.length > 256 ? null : credential;
}

export function parseGuestLocation(pathname: string, hash: string): GuestEntry {
  const shareId = parseShareId(pathname);
  return { shareId, invite: shareId === null ? null : parseInviteHash(hash) };
}

const inviteStorageKey = (shareId: string) => `moss-guest:invite:${shareId}`;

export interface InviteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStorageOrNull(): InviteStorage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredInvite(
  shareId: string,
  storage: InviteStorage | null = sessionStorageOrNull(),
): string | null {
  try {
    return storage?.getItem(inviteStorageKey(shareId)) || null;
  } catch {
    return null;
  }
}

export function storeInvite(
  shareId: string,
  invite: string,
  storage: InviteStorage | null = sessionStorageOrNull(),
): void {
  try {
    storage?.setItem(inviteStorageKey(shareId), invite);
  } catch {
    // Private mode or a full store: the invite then lives only in memory for this load.
  }
}

export function clearStoredInvite(
  shareId: string,
  storage: InviteStorage | null = sessionStorageOrNull(),
): void {
  try {
    storage?.removeItem(inviteStorageKey(shareId));
  } catch {
    // Nothing to clear.
  }
}

interface EntryWindow {
  readonly location: { readonly pathname: string; readonly hash: string; readonly search: string };
  readonly history: {
    readonly state: unknown;
    replaceState(data: unknown, unused: string, url?: string): void;
  };
}

/**
 * Reads the entry once, hides the invite from the address bar, and remembers it for this tab.
 * A load without a fragment still finds an invite a previous load of this tab stored.
 */
export function takeGuestEntry(
  window: EntryWindow,
  storage: InviteStorage | null = sessionStorageOrNull(),
): GuestEntry {
  const { pathname, hash, search } = window.location;
  const entry = parseGuestLocation(pathname, hash);
  if (hash !== "") {
    try {
      window.history.replaceState(window.history.state, "", `${pathname}${search}`);
    } catch {
      // Some embedded browsers refuse history changes; the invite still leaves memory on join.
    }
  }
  if (entry.shareId === null) return entry;
  if (entry.invite !== null) {
    storeInvite(entry.shareId, entry.invite, storage);
    return entry;
  }
  return { shareId: entry.shareId, invite: readStoredInvite(entry.shareId, storage) };
}
