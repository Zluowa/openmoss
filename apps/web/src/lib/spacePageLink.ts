// FILE: spacePageLink.ts
// Purpose: Links that open a 资料空间 item: `moss://space-page/<id>` in chat answers (the slides
//          tools hand one back after making a deck) and the `#space-page=<id>` hash the Space
//          reads, which also carries "open in new window". A deck link may end in `#slide-N`
//          (幻灯片 → 拷贝幻灯片链接); the deck then opens on slide N.
// Layer: Web lib

/** `#space-page=<id>` opens that item when the Space mounts or the hash changes. */
export const SPACE_PAGE_HASH_PREFIX = "#space-page=";
export const SPACE_PAGE_LINK_PREFIX = "moss://space-page/";

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const SLIDE_SUFFIX = /#slide-([1-9][0-9]{0,3})$/u;

export function spacePageIdOfLink(href: string | null | undefined): string | null {
  if (!href?.startsWith(SPACE_PAGE_LINK_PREFIX)) return null;
  try {
    const id = decodeURIComponent(
      href.slice(SPACE_PAGE_LINK_PREFIX.length).replace(SLIDE_SUFFIX, ""),
    ).trim();
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

/** The slide number of a `moss://space-page/<id>#slide-N` link (1-based), else null. */
export function spacePageSlideOfLink(href: string | null | undefined): number | null {
  if (!spacePageIdOfLink(href)) return null;
  const match = SLIDE_SUFFIX.exec(href ?? "");
  return match ? Number(match[1]) : null;
}

/** The link 拷贝幻灯片链接 puts on the clipboard. */
export function spacePageSlideLink(pageId: string, slideNumber: number): string {
  return `${SPACE_PAGE_LINK_PREFIX}${encodeURIComponent(pageId)}#slide-${Math.max(1, Math.floor(slideNumber))}`;
}

// The slide a deck should open on, set by a slide link just before the deck opens; the deck
// host takes it on its first load.
const startSlides = new Map<string, number>();
export function rememberStartSlide(pageId: string, slideNumber: number) {
  startSlides.set(pageId, slideNumber);
}
export function takeStartSlide(pageId: string): number | null {
  const slide = startSlides.get(pageId) ?? null;
  startSlides.delete(pageId);
  return slide;
}
