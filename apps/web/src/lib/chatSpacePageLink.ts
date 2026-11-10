// FILE: chatSpacePageLink.ts
// Purpose: What a 资料空间 link (`moss://space-page/<id>`) in a chat answer does. A deck has one
//          entry per answer and it opens beside the chat, like Claude: when the turn already
//          shows the deck's card the link is not drawn; otherwise a slides link opens the deck
//          tab in the right panel. Other page types, and links outside a chat, open 资料空间.
// Layer: Web lib
// Exports: ChatDeckCardPagesContext, openSpacePageFromChat

import type { PageId, PagesReadResult, SpaceId } from "@moss/contracts";
import { createContext } from "react";

/** Pages that already have a deck card under the answer being rendered. */
export const ChatDeckCardPagesContext = createContext<ReadonlySet<string>>(new Set());

export interface OpenSpacePageFromChatDeps {
  readonly readPage: (input: {
    readonly scopeSpaceId: SpaceId | null;
    readonly pageId: PageId;
  }) => Promise<Pick<PagesReadResult, "page">>;
  /** The 资料空间 scopes to look the page up in, in order (the local default first). */
  readonly scopes: ReadonlyArray<SpaceId | null>;
  readonly openDeck: (deck: {
    readonly pageId: string;
    readonly scopeSpaceId: string | null;
    readonly title: string;
  }) => void;
  readonly openSpacePage: (pageId: string) => void;
}

/** Opens a 资料空间 link clicked in a chat answer. */
export async function openSpacePageFromChat(
  pageId: string,
  threadId: string | undefined,
  deps: OpenSpacePageFromChatDeps,
): Promise<void> {
  if (!threadId) {
    deps.openSpacePage(pageId);
    return;
  }
  for (const scopeSpaceId of new Set(deps.scopes)) {
    try {
      const { page } = await deps.readPage({ scopeSpaceId, pageId: pageId as PageId });
      if (page.kind === "slides") {
        deps.openDeck({
          pageId,
          scopeSpaceId: page.scopeSpaceId ?? scopeSpaceId,
          title: page.title,
        });
      } else {
        deps.openSpacePage(pageId);
      }
      return;
    } catch {
      // Not in this scope; try the next one.
    }
  }
  deps.openSpacePage(pageId);
}
