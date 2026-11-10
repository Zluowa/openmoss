// FILE: pageGuestUrl.ts
// Purpose: Reads a 资料空间 link or site from the guest page URL (`/p/<id>?l=<link>#<key>`),
//          keeps its credential out of the address bar, and remembers this browser's visitor id.
// Layer: Guest page (page links and sites)
// Why: Like thread invites, the credential travels in the fragment so it never reaches relay
//      logs. Page links are reusable, so the credential is kept in localStorage: the guest can
//      come back to a bookmarked `/p/<id>?l=<link>` without the fragment.

import { PAGE_GUEST_LINK_PARAM, PAGE_GUEST_PATH_PREFIX } from "@moss/contracts";

export interface PageGuestEntry {
  readonly shareId: string;
  readonly link: string | null;
  readonly key: string | null;
}

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const LINK_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const isPageGuestPath = (pathname: string) => pathname.startsWith(PAGE_GUEST_PATH_PREFIX);

export function parsePageGuestLocation(
  pathname: string,
  search: string,
  hash: string,
): PageGuestEntry | null {
  if (!isPageGuestPath(pathname)) return null;
  const rest = pathname.slice(PAGE_GUEST_PATH_PREFIX.length).replace(/\/$/, "");
  if (!SHARE_ID_PATTERN.test(rest)) return null;
  const link = new URLSearchParams(search).get(PAGE_GUEST_LINK_PARAM);
  let key: string | null = null;
  if (hash.length > 1) {
    try {
      key = decodeURIComponent(hash.slice(1)).trim() || null;
    } catch {
      key = null;
    }
  }
  return {
    shareId: rest,
    link: link !== null && LINK_PATTERN.test(link) ? link : null,
    key: key !== null && key.length <= 200 ? key : null,
  };
}

interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStorageOrNull(): KeyStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

const credentialSlot = (entry: { shareId: string; link: string | null }) =>
  `moss-page:key:${entry.shareId}:${entry.link ?? "personal"}`;

export function rememberPageKey(
  entry: { shareId: string; link: string | null },
  key: string,
  storage: KeyStorage | null = localStorageOrNull(),
) {
  try {
    storage?.setItem(credentialSlot(entry), key);
  } catch {
    // A browser without storage still works for this visit.
  }
}

export function forgetPageKey(
  entry: { shareId: string; link: string | null },
  storage: KeyStorage | null = localStorageOrNull(),
) {
  try {
    storage?.removeItem(credentialSlot(entry));
  } catch {
    // Nothing to forget.
  }
}

/**
 * The entry this load works with: the fragment's credential (then dropped from the address
 * bar), or the one remembered from an earlier visit.
 */
export function takePageGuestEntry(
  win: Pick<Window, "location" | "history">,
  storage: KeyStorage | null = localStorageOrNull(),
): PageGuestEntry | null {
  const entry = parsePageGuestLocation(
    win.location.pathname,
    win.location.search,
    win.location.hash,
  );
  if (entry === null) return null;
  if (entry.key !== null) {
    rememberPageKey(entry, entry.key, storage);
    win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}`);
    return entry;
  }
  let remembered: string | null = null;
  try {
    remembered = storage?.getItem(credentialSlot(entry)) ?? null;
  } catch {
    remembered = null;
  }
  return { ...entry, key: remembered };
}

const VISITOR_SLOT = "moss-page:visitor";

/** A random id per browser so the owner sees opens counted once, without any account. */
export function pageVisitorId(storage: KeyStorage | null = localStorageOrNull()): string {
  try {
    const existing = storage?.getItem(VISITOR_SLOT);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  } catch {
    // Fall through to a fresh id.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  try {
    storage?.setItem(VISITOR_SLOT, id);
  } catch {
    // An id for this visit only.
  }
  return id;
}

const NAME_SLOT = "moss-page:name";
export function rememberedGuestName(storage: KeyStorage | null = localStorageOrNull()): string {
  try {
    return storage?.getItem(NAME_SLOT) ?? "";
  } catch {
    return "";
  }
}
export function rememberGuestName(name: string, storage: KeyStorage | null = localStorageOrNull()) {
  try {
    storage?.setItem(NAME_SLOT, name);
  } catch {
    // Asked again next time.
  }
}
