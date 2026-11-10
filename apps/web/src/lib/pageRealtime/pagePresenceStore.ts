// FILE: pagePresenceStore.ts
// Purpose: Who is on each open Page right now, as reported by that Page's live editor, for the
//          page chrome to draw without reaching into the editor.
// Layer: Web page realtime (collab)

import { useSyncExternalStore } from "react";

export interface PagePresencePeer {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
  readonly kind: "person" | "agent";
  readonly self: boolean;
  readonly typing: boolean;
}

export interface PagePresence {
  readonly peers: readonly PagePresencePeer[];
  readonly link: "connecting" | "online" | "offline" | "rejected";
  /** Local edits not yet confirmed stored by the server. They are kept on this device. */
  readonly pending: boolean;
}

const COLOR = /^#[0-9a-f]{6}$/iu;
const presence = new Map<string, PagePresence>();
const listeners = new Set<() => void>();

/** Accepts the editor's report only in its documented shape. */
export function parsePagePresence(value: unknown): PagePresence | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    !Array.isArray(input.peers) ||
    input.peers.length > 200 ||
    !["connecting", "online", "offline", "rejected"].includes(String(input.link))
  )
    return null;
  const peers: PagePresencePeer[] = [];
  for (const item of input.peers as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const peer = item as Record<string, unknown>;
    if (
      typeof peer.clientId !== "number" ||
      typeof peer.name !== "string" ||
      typeof peer.color !== "string" ||
      (peer.kind !== "person" && peer.kind !== "agent")
    )
      return null;
    peers.push({
      clientId: peer.clientId,
      name: peer.name.slice(0, 80),
      color: COLOR.test(peer.color) ? peer.color : "#7c7c7c",
      kind: peer.kind,
      self: peer.self === true,
      typing: peer.typing === true,
    });
  }
  return { peers, link: input.link as PagePresence["link"], pending: input.pending === true };
}

export function setPagePresence(pageId: string, value: PagePresence | null) {
  if (value) presence.set(pageId, value);
  else presence.delete(pageId);
  for (const listener of listeners) listener();
}

export function usePagePresence(pageId: string): PagePresence | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => presence.get(pageId) ?? null,
  );
}

/** A short label for this window's device, shown to the other windows on the Page. */
export function localDeviceLabel(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
) {
  if (/iPhone/iu.test(userAgent)) return "iPhone";
  if (/iPad/iu.test(userAgent)) return "iPad";
  if (/Android/iu.test(userAgent)) return "Android 设备";
  if (/Mac OS X|Macintosh/iu.test(userAgent)) return "Mac";
  if (/Windows/iu.test(userAgent)) return "Windows 设备";
  if (/Linux/iu.test(userAgent)) return "Linux 设备";
  return "Moss 设备";
}

const PALETTE = [
  "#d9534f",
  "#e8833a",
  "#c9a227",
  "#3f9b5a",
  "#2e8ab8",
  "#5b6bd6",
  "#a05ad1",
  "#d1508f",
];

/** One color per window for its cursor and avatar, kept across reloads of that tab. */
export function localPresenceColor(): string {
  try {
    const saved = sessionStorage.getItem("moss-page-presence-color");
    if (saved && COLOR.test(saved)) return saved;
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)]!;
    sessionStorage.setItem("moss-page-presence-color", color);
    return color;
  } catch {
    return PALETTE[0]!;
  }
}
