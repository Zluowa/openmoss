// FILE: pageGuestTextThreads.ts
// Purpose: Comment threads on words, as a shared page's guests see them, and the threads and
//          replies guests add. The owner's Moss stores each thread as the web app's thread JSON
//          (pages_text_comments); this reads that shape defensively and writes guest messages
//          in it, so the owner's page shows them like its own.
// Layer: Page sharing (guest side)
// Exports: guestTextThreadOf, newGuestTextThread, withGuestReply, GUEST_TEXT_THREAD_ID

import type { PageGuestTextThread } from "@moss/contracts";

/** Ids guests mint for new threads; the editor's own start with `c`. */
export const GUEST_TEXT_THREAD_ID = /^g[a-z0-9]{8,64}$/u;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

type GuestKind = "member" | "guest";

function authorOf(value: unknown): { kind: "owner" | GuestKind; name: string } {
  const author = isObject(value) ? value : {};
  const kind =
    author.authorKind === "member" || author.authorKind === "guest" ? author.authorKind : "owner";
  const name = text(author.name, 128);
  // The owner's own fallback name ("我" / "Me") means nothing to a guest: they see 所有者.
  return { kind, name: kind === "owner" && (name === "我" || name === "Me") ? "" : name };
}

/** A stored thread as guests see it; null when it is not a thread or has nothing to show. */
export function guestTextThreadOf(raw: string): PageGuestTextThread | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.id !== "string" || !isObject(value.anchor)) return null;
  const anchor = value.anchor;
  const first = authorOf(value.author);
  const body = text(value.body, 4_000).trim();
  if (!body) return null;
  const messages: PageGuestTextThread["messages"][number][] = [
    {
      id: value.id,
      authorKind: first.kind,
      authorName: first.name,
      body,
      createdAt: text(value.createdAt, 64),
    },
  ];
  for (const reply of Array.isArray(value.replies) ? value.replies : []) {
    if (!isObject(reply) || typeof reply.id !== "string") continue;
    // Moss's answers show once they are written; a reply still being worked on is not shown.
    if (reply.kind === "agent" && reply.status !== "done") continue;
    const replyBody = text(reply.body, 8_000).trim();
    if (!replyBody) continue;
    const author =
      reply.kind === "agent" ? { kind: "agent" as const, name: "Moss" } : authorOf(reply.author);
    messages.push({
      id: reply.id,
      authorKind: author.kind,
      authorName: author.name,
      body: replyBody,
      createdAt: text(reply.createdAt, 64),
    });
  }
  return {
    id: value.id,
    // A sheet's cell comment has no quoted words: its cell label (表1!B3) stands in.
    anchor: {
      blockId: text(anchor.selector, 256),
      quote: text(anchor.text, 400) || text(anchor.label, 400),
    },
    resolved: value.resolved === true,
    messages,
  };
}

const initialOf = (name: string) => Array.from(name.trim())[0] ?? "?";

/** A new thread a guest starts on words, in the shape the owner's Moss stores. */
export function newGuestTextThread(input: {
  id: string;
  pageId: string;
  anchor: { blockId: string; quote: string };
  author: { kind: GuestKind; name: string };
  body: string;
  createdAt: string;
}): string {
  return JSON.stringify({
    id: input.id,
    threadId: "",
    anchor: {
      selector: input.anchor.blockId,
      label: input.anchor.quote.slice(0, 60),
      text: input.anchor.quote,
    },
    author: {
      name: input.author.name,
      initials: initialOf(input.author.name),
      authorKind: input.author.kind,
    },
    body: input.body,
    createdAt: input.createdAt,
    sentToAgentAt: null,
    replies: [],
    resolved: false,
  });
}

/** The stored thread with a guest's reply added (and reopened); null when it is not a thread. */
export function withGuestReply(
  raw: string,
  reply: { id: string; author: { kind: GuestKind; name: string }; body: string; createdAt: string },
): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.id !== "string") return null;
  const replies = Array.isArray(value.replies) ? value.replies : [];
  if (replies.length >= 200) return null;
  return JSON.stringify({
    ...value,
    resolved: false,
    read: false,
    replies: [
      ...replies,
      {
        id: reply.id,
        kind: "person",
        author: {
          name: reply.author.name,
          initials: initialOf(reply.author.name),
          authorKind: reply.author.kind,
        },
        body: reply.body,
        createdAt: reply.createdAt,
        status: "done",
      },
    ],
  });
}
