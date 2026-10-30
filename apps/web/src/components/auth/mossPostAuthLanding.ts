// FILE: mossPostAuthLanding.ts
// Purpose: Clears remembered route-restoration metadata after authentication so
//          an old thread or navigation target cannot win the post-login `/`
//          landing.

import { persistSidebarUiState, readSidebarUiState } from "~/components/Sidebar.uiState";

export const MOSS_POST_AUTH_CHAT_SEARCH = { fresh: true } as const;

/**
 * Authentication starts a new product session, so an old thread route must not
 * win the subsequent `/` landing. This only clears route restoration metadata;
 * thread history, drafts, and split views remain intact and visible from the
 * sidebar. Upstream dropped `safeMainNavigationTarget` from the sidebar state,
 * so only the last thread route is reset here.
 */
export function prepareMossPostAuthChatLanding(): void {
  const current = readSidebarUiState();
  persistSidebarUiState({
    ...current,
    lastThreadRoute: null,
  });
}
