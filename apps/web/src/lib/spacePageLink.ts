// FILE: spacePageLink.ts
// Purpose: Links that open a 资料空间 item: `moss://space-page/<id>` in chat answers (the slides
//          tools hand one back after making a deck) and the `#space-page=<id>` hash the Space
//          reads, which also carries "open in new window".
// Layer: Web lib

/** `#space-page=<id>` opens that item when the Space mounts or the hash changes. */
export const SPACE_PAGE_HASH_PREFIX = "#space-page=";
export const SPACE_PAGE_LINK_PREFIX = "moss://space-page/";

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function spacePageIdOfLink(href: string | null | undefined): string | null {
  if (!href?.startsWith(SPACE_PAGE_LINK_PREFIX)) return null;
  try {
    const id = decodeURIComponent(href.slice(SPACE_PAGE_LINK_PREFIX.length)).trim();
    return PAGE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function readSpacePageHash(hash = window.location.hash): string | null {
  if (!hash.startsWith(SPACE_PAGE_HASH_PREFIX)) return null;
  try {
    const id = decodeURIComponent(hash.slice(SPACE_PAGE_HASH_PREFIX.length)).trim();
    return PAGE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function clearSpacePageHash() {
  if (readSpacePageHash())
    history.replaceState(null, "", window.location.pathname + window.location.search);
}

/** Switches to 资料空间 and opens the item; the shell and the Space both listen for the hash. */
export function openSpacePage(pageId: string) {
  window.location.hash = `${SPACE_PAGE_HASH_PREFIX}${encodeURIComponent(pageId)}`;
}
