// FILE: shellTabStore.ts
// Purpose: Codex-style multi-tab model for the shell top strip — extra tabs that sit
//          next to the conversation tab (new-chat drafts today) plus the strip's
//          collapsed state. The conversation tab itself stays route-derived.
// Layer: Web client state
// Depends on: zustand, localStorage persistence.

import { create } from "zustand";

export type ShellExtraTabKind = "draft";

export type ShellExtraTab = {
  readonly id: string;
  readonly kind: ShellExtraTabKind;
  readonly title: string;
};

export type ShellConversationTab = {
  readonly id: string;
  readonly title: string;
};

export type ShellTabStripState = {
  /** The most recent started thread — Codex's conversation tab. Null on a fresh shell. */
  readonly conversation: ShellConversationTab | null;
  readonly extraTabs: readonly ShellExtraTab[];
  readonly stripCollapsed: boolean;
  readonly setConversation: (conversation: ShellConversationTab) => void;
  readonly openExtraTab: (tab: ShellExtraTab) => void;
  readonly closeExtraTab: (id: string) => void;
  readonly removeExtraTabs: (ids: ReadonlySet<string>) => void;
  readonly toggleStripCollapsed: () => void;
};

const STORAGE_KEY = "moss:shell-tabs:v1";

function readPersisted(): Pick<
  ShellTabStripState,
  "conversation" | "extraTabs" | "stripCollapsed"
> {
  if (typeof window === "undefined") {
    return { conversation: null, extraTabs: [], stripCollapsed: false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { conversation: null, extraTabs: [], stripCollapsed: false };
    const parsed = JSON.parse(raw) as {
      extraTabs?: unknown;
      stripCollapsed?: unknown;
    };
    const extraTabs = Array.isArray(parsed.extraTabs)
      ? parsed.extraTabs.filter(
          (tab): tab is ShellExtraTab =>
            typeof tab === "object" &&
            tab !== null &&
            typeof (tab as { id?: unknown }).id === "string" &&
            typeof (tab as { title?: unknown }).title === "string" &&
            (tab as { kind?: unknown }).kind === "draft",
        )
      : [];
    const conversationRaw = (parsed as { conversation?: unknown }).conversation;
    const conversation =
      typeof conversationRaw === "object" &&
      conversationRaw !== null &&
      typeof (conversationRaw as { id?: unknown }).id === "string" &&
      typeof (conversationRaw as { title?: unknown }).title === "string"
        ? (conversationRaw as ShellConversationTab)
        : null;
    return { conversation, extraTabs, stripCollapsed: parsed.stripCollapsed === true };
  } catch {
    return { conversation: null, extraTabs: [], stripCollapsed: false };
  }
}

function persist(
  state: Pick<ShellTabStripState, "conversation" | "extraTabs" | "stripCollapsed">,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence; the strip keeps working without it.
  }
}

export const useShellTabStripStore = create<ShellTabStripState>((set, get) => ({
  ...readPersisted(),
  setConversation: (conversation) =>
    set(() => {
      persist({
        conversation,
        extraTabs: get().extraTabs,
        stripCollapsed: get().stripCollapsed,
      });
      return { conversation };
    }),
  openExtraTab: (tab) =>
    set(() => {
      const existing = get().extraTabs;
      const extraTabs = existing.some((entry) => entry.id === tab.id)
        ? existing
        : [...existing, tab];
      persist({
        conversation: get().conversation,
        extraTabs,
        stripCollapsed: get().stripCollapsed,
      });
      return { extraTabs };
    }),
  closeExtraTab: (id) =>
    set(() => {
      const extraTabs = get().extraTabs.filter((tab) => tab.id !== id);
      persist({
        conversation: get().conversation,
        extraTabs,
        stripCollapsed: get().stripCollapsed,
      });
      return { extraTabs };
    }),
  removeExtraTabs: (ids) =>
    set(() => {
      const extraTabs = get().extraTabs.filter((tab) => !ids.has(tab.id));
      persist({
        conversation: get().conversation,
        extraTabs,
        stripCollapsed: get().stripCollapsed,
      });
      return { extraTabs };
    }),
  toggleStripCollapsed: () =>
    set(() => {
      const stripCollapsed = !get().stripCollapsed;
      persist({
        conversation: get().conversation,
        extraTabs: get().extraTabs,
        stripCollapsed,
      });
      return { stripCollapsed };
    }),
}));

/** The strip shows tabs only when there is something beyond the clean new-chat state. */
export function shouldShowShellTabStrip(input: {
  readonly hasConversationTab: boolean;
  readonly extraTabCount: number;
}): boolean {
  return input.hasConversationTab || input.extraTabCount > 0;
}

/** Codex packs everything left once a second tab exists; a lone conversation tab pins
 *  its actions to the content column's right edge. */
export function isMultiTabStrip(input: {
  readonly hasConversationTab: boolean;
  readonly extraTabCount: number;
}): boolean {
  return (input.hasConversationTab ? 1 : 0) + input.extraTabCount >= 2;
}
