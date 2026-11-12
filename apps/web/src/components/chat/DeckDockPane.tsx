// FILE: DeckDockPane.tsx
// Purpose: A slides deck in the deck editor beside the chat, opened from its card in the
//          transcript, and opened once by itself when the agent has just created it.
// Layer: Chat right-dock pane
// Exports: DeckDockPane, useAgentDeckAutoOpen
// Why: Like the Canvas, the deck an agent makes in a conversation opens in that conversation's
//      side panel, so the person sees it without leaving the chat (see moss-canvas-lifecycle.md).

import type { PageId, SpaceId, ThreadId } from "@moss/contracts";
import { slidesDeckFromActivity, type SlidesDeckArtifact } from "@moss/shared/chatArtifactActivity";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useResidentRuntime } from "~/lib/dockRuntimeResidency";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import { readNativeApi } from "~/nativeApi";
import type { RightDockDeckReference } from "~/rightDockStore.logic";
import { SpaceTypedItemView } from "../spaceTypes/SpaceTypedItemView";
import { pageTypesQueryKeys } from "../spaceTypes/spaceItemTypes";
import { openDeckInSidePanel } from "./ChatArtifactCards";
import { PanelStateMessage } from "./PanelStateMessage";

/** Calls `listener` with each deck the agent records in this conversation, live only. */
function useThreadDeckEvents(threadId: string, listener: (deck: SlidesDeckArtifact) => void) {
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.orchestration.onDomainEvent((event) => {
      if (event.type !== "thread.activity-appended" || event.payload.threadId !== threadId) return;
      const deck = slidesDeckFromActivity(event.payload.activity);
      if (deck) listener(deck);
    });
  }, [threadId, listener]);
}

export function DeckDockPane(props: {
  threadId: ThreadId;
  deck: RightDockDeckReference;
  /** The pane's residency key and whether it is shown (the side panel's shared policy). */
  residency?: { readonly key: string; readonly visible: boolean };
}) {
  const boundary = useMossImagesAccountBoundary();
  const client = useQueryClient();
  const [epoch, setEpoch] = useState(0);
  const { pageId, scopeSpaceId } = props.deck;
  const account = boundary.identityKey;
  const latest = useRef({ pageId, scopeSpaceId, account });
  latest.current = { pageId, scopeSpaceId, account };
  // The agent wrote a newer version of this deck while it is open: load it. The editor
  // saves the person's pending edits as it closes, so nothing typed is lost.
  const onDeckEvent = useCallback(
    (deck: SlidesDeckArtifact) => {
      const shown = latest.current;
      if (deck.pageId !== shown.pageId || deck.change === "proposed") return;
      void client
        .invalidateQueries({
          queryKey: pageTypesQueryKeys.item(
            shown.account,
            shown.scopeSpaceId as SpaceId | null,
            shown.pageId as PageId,
          ),
        })
        .then(() => setEpoch((value) => value + 1));
    },
    [client],
  );
  useThreadDeckEvents(props.threadId, onDeckEvent);
  // The editor saves pending edits as it closes, so unloading it while hidden loses nothing.
  const runtime = useResidentRuntime({
    active: props.residency !== undefined,
    key: props.residency?.key ?? "",
    owner: props.threadId,
    runtimeClass: "dockFrame",
    visible: props.residency?.visible ?? true,
    suspend: async () => true,
  });

  if (boundary.transitioning) return <PanelStateMessage>正在切换账号…</PanelStateMessage>;
  if (!runtime.loaded) {
    // Unloaded while out of sight; it loads again when shown.
    return (
      <div className="h-full w-full" data-deck-dock-pane={pageId} data-suspended aria-hidden />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-deck-dock-pane={pageId}>
      <SpaceTypedItemView
        key={`${account}:${scopeSpaceId ?? ""}:${pageId}:${epoch}`}
        account={account}
        scopeSpaceId={scopeSpaceId as SpaceId | null}
        pageId={pageId as PageId}
      />
    </div>
  );
}

/**
 * Opens a deck the agent has just created in this conversation's side panel, once: only for
 * the live event (never when the chat is reloaded), and only for a deck it created.
 */
export function useAgentDeckAutoOpen(threadId: ThreadId) {
  const opened = useRef(new Set<string>());
  const onDeckEvent = useCallback(
    (deck: SlidesDeckArtifact) => {
      if (deck.change !== "created" || opened.current.has(deck.pageId)) return;
      opened.current.add(deck.pageId);
      openDeckInSidePanel(threadId, deck);
    },
    [threadId],
  );
  useThreadDeckEvents(threadId, onDeckEvent);
}
