// FILE: pageChromeContext.ts
// Purpose: What every page chrome slot receives: the open page, its saved document and the
//          few actions a slot may take on it.
// Layer: Space page chrome (owned by space-ui)
// Why: page-ai, collab and sharing each fill one slot of the page top bar or the bottom
//      composer. They mount against this one shape instead of reaching into the page view, so
//      each stream edits only its own slot file. Add a field here in a small separate commit and
//      tell the lead.

import type { Page, PagesReadResult, SpaceId } from "@moss/contracts";

/** Side panels the page view can show to the right of the document. */
export type PageSidePanel = "history" | "comments" | "activity" | "files" | "navigation";

export interface PageChromeContext {
  /** Signed-in identity key; part of every pages query key. */
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  /** Latest saved metadata (title, revision, pinned, trashedAt…). */
  readonly page: Page;
  /** Latest saved document. Unsaved editor changes are not in here; call `flush` first. */
  readonly document: PagesReadResult;
  /** True for trashed pages and preview mode: slots must not offer edits. */
  readonly readOnly: boolean;
  /** False once the account or Space changed under this page; drop late results. */
  readonly isCurrent: () => boolean;
  /** Saves pending editor and title changes. Resolves false when they could not be saved. */
  readonly flush: () => Promise<boolean>;
  /** Re-reads the page and the Space lists after a change made outside the editor. */
  readonly refresh: () => Promise<void>;
  readonly activePanel: PageSidePanel | null;
  readonly openPanel: (panel: PageSidePanel | null) => void;
  /** Opens the "new subpage" flow under this page. */
  readonly createChildPage: () => void;
}

export interface PageChromeSlotProps {
  readonly context: PageChromeContext;
}
