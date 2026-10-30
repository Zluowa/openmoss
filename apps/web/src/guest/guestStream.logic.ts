// FILE: guestStream.logic.ts
// Purpose: Applies the guest stream to the app's thread store and derives what the page shows
//          around the transcript: the guest's own waiting messages, the expiry, the locale.
// Layer: Guest page
// Why: As in T3, the owner's thread stream items go through the owner's own store reducers
//      (snapshot → `syncServerThreadDetailHotPath`, events → `applyOrchestrationEventsHotPath`),
//      so the shared timeline renders the thread exactly as the owner sees it.

import type {
  GuestShareEndReason,
  GuestShareView,
  GuestStreamEvent,
  OrchestrationThreadDetailSnapshot,
  ThreadGuestMessage,
  ThreadId,
} from "@synara/contracts";

import { parseGuestMessageAttribution } from "@synara/shared/guestShareAttribution";
import type { useStore } from "~/store";
import type { ChatMessage } from "~/types";
import type { MossLocaleCode } from "~/uiLocale";

export interface GuestStreamState {
  readonly protocolVersion: number | null;
  readonly view: GuestShareView | null;
  /** The shared thread's id once a snapshot arrived; the thread itself lives in the store. */
  readonly threadId: ThreadId | null;
  /** The snapshot was a window of a longer history. */
  readonly truncated: boolean;
  readonly ended: GuestShareEndReason | null;
}

export const initialGuestStreamState: GuestStreamState = {
  protocolVersion: null,
  view: null,
  threadId: null,
  truncated: false,
  ended: null,
};

/** The two store actions the stream drives; `useStore.getState()` provides them. */
export type GuestThreadStore = Pick<
  ReturnType<typeof useStore.getState>,
  "syncServerThreadDetailHotPath" | "applyOrchestrationEventsHotPath"
>;

function snapshotIsTruncated(snapshot: OrchestrationThreadDetailSnapshot): boolean {
  const history = snapshot.history;
  if (!history) return false;
  return (
    history.olderCursor !== null || history.totalMessageCount > snapshot.thread.messages.length
  );
}

/**
 * Applies one frame. Thread items reach the store the way the owner's subscription delivers
 * them; the snapshot's history metadata stays out, since the guest routes have no history
 * pagination and the store would otherwise offer to load older messages.
 */
export function applyGuestStreamEvent(
  state: GuestStreamState,
  event: GuestStreamEvent,
  store: GuestThreadStore,
): GuestStreamState {
  switch (event.type) {
    case "hello":
      return { ...state, protocolVersion: event.protocolVersion };
    case "view":
      // The page follows the share it opened; a view of another one means the link changed.
      if (state.view !== null && state.view.shareId !== event.view.shareId) {
        return { ...state, ended: state.ended ?? "replaced" };
      }
      return { ...state, view: event.view };
    case "thread": {
      const item = event.item;
      if (item.kind === "snapshot") {
        const { snapshot } = item;
        store.syncServerThreadDetailHotPath(
          snapshot.thread,
          snapshot.snapshotSequence,
          undefined,
          snapshot.historyRevisionSequence,
        );
        return {
          ...state,
          threadId: snapshot.thread.id,
          truncated: snapshotIsTruncated(snapshot),
        };
      }
      // Events before the first snapshot have nothing to apply to.
      if (state.threadId === null) return state;
      store.applyOrchestrationEventsHotPath(item.kind === "event" ? [item.event] : item.events);
      return state;
    }
    case "ended":
      return { ...state, ended: event.reason };
    default:
      return state;
  }
}

const timeOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/** Whether a thread message is one the owner sent for this guest. */
export const isGuestAttributedMessage = (text: string, guestName: string): boolean =>
  parseGuestMessageAttribution(text)?.guestName === guestName;

/**
 * The guest's own messages to show above the composer. Every waiting one shows. A sent or
 * dismissed one shows only while this page saw it wait (`seenPendingIds`, kept per tab), so a
 * reload does not replay old receipts; a sent one leaves once the thread shows a message from
 * this guest created after it was submitted.
 */
export function unplacedGuestMessages(
  ownMessages: ReadonlyArray<ThreadGuestMessage>,
  threadMessages: ReadonlyArray<Pick<ChatMessage, "role" | "text" | "createdAt">>,
  guestName: string,
  seenPendingIds: ReadonlySet<string>,
): ReadonlyArray<ThreadGuestMessage> {
  const landedAt = threadMessages
    .filter(
      (message) => message.role === "user" && isGuestAttributedMessage(message.text, guestName),
    )
    .map((message) => timeOf(message.createdAt));
  return ownMessages
    .filter((message) => {
      if (message.status === "pending") return true;
      if (!seenPendingIds.has(message.id)) return false;
      if (message.status === "dismissed") return true;
      const submittedAt = timeOf(message.submittedAt);
      return !landedAt.some((at) => at >= submittedAt);
    })
    .toSorted((a, b) => timeOf(a.submittedAt) - timeOf(b.submittedAt));
}

/** Hours or minutes until the share expires, rounded down; null once it has. */
export function expiryRemaining(
  expiresAt: string,
  nowMs: number,
): { readonly unit: "hours" | "minutes"; readonly value: number } | null {
  const minutes = Math.floor((timeOf(expiresAt) - nowMs) / 60_000);
  if (minutes <= 0) return null;
  return minutes >= 60
    ? { unit: "hours", value: Math.floor(minutes / 60) }
    : { unit: "minutes", value: minutes };
}

/**
 * Chinese for any `zh*` tag (zh, zh-CN, zh-Hans, zh-TW, …), English for everything else. The
 * app's own resolver defaults to Chinese for unknown languages because its users chose Moss;
 * a guest only followed a link, so an unknown language falls back to English.
 */
export function resolveGuestLocale(languages: ReadonlyArray<string>): MossLocaleCode {
  for (const language of languages) {
    const tag = language.trim().toLowerCase();
    if (tag === "") continue;
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}
