// FILE: chatArtifactActivity.ts
// Purpose: The thread activities for what an agent made in a turn that the chat shows as cards:
//          a slides deck it created or changed, and a file it exported into the conversation.
// Layer: Shared runtime utility
// Exports: SLIDES_DECK_ACTIVITY_KIND, THREAD_OUTPUT_FILE_ACTIVITY_KIND, slidesDeckActivityPayload,
//          slidesDeckFromActivity, threadOutputFileActivityPayload, threadOutputFileFromActivity,
//          readThreadOutputHref, threadOutputFilesLinkedIn
// Why: Provider tool results do not share one shape across Moss's adapters (Codex, Claude, Grok…),
//      so the gateway records each deck and exported file as its own activity, like html_render.
//      Clients read cards from these activities, never from tool output.

import { THREAD_OUTPUT_ROUTE } from "./threadWorkspace";

export const SLIDES_DECK_ACTIVITY_KIND = "slides.deck.updated";
export const THREAD_OUTPUT_FILE_ACTIVITY_KIND = "thread-output.published";

/** What the agent did to the deck in this call. */
export type SlidesDeckChange = "created" | "edited" | "proposed";

export interface SlidesDeckArtifact {
  readonly pageId: string;
  /** The 资料空间 scope the deck lives in; null is the local default. */
  readonly scopeSpaceId: string | null;
  readonly title: string;
  readonly slideCount: number;
  /** The cover slide's words (title, then subtitle), for the card's second line. */
  readonly coverText: string | null;
  readonly change: SlidesDeckChange;
}

export interface ThreadOutputFileArtifact {
  /** Workspace-relative path, as the thread-output download route expects it. */
  readonly file: string;
  readonly name: string;
  /** Absolute path on the device that ran the agent, for opening in the side panel. */
  readonly path: string | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
}

const MAX_TITLE = 256;
const MAX_COVER_TEXT = 200;
const MAX_PATH = 4096;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || trimmed.includes("\u0000")) return null;
  return trimmed;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One line of the cover's words, bounded for an activity payload. */
export function slidesCoverText(lines: ReadonlyArray<string>): string | null {
  const joined = lines
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join(" · ");
  if (joined.length === 0) return null;
  return joined.length > MAX_COVER_TEXT ? `${joined.slice(0, MAX_COVER_TEXT - 1)}…` : joined;
}

export function slidesDeckActivityPayload(deck: SlidesDeckArtifact) {
  return {
    slidesDeck: {
      pageId: deck.pageId,
      scopeSpaceId: deck.scopeSpaceId,
      title: deck.title.slice(0, MAX_TITLE),
      slideCount: deck.slideCount,
      coverText: deck.coverText,
      change: deck.change,
    },
  };
}

export function slidesDeckFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): SlidesDeckArtifact | undefined {
  if (activity.kind !== SLIDES_DECK_ACTIVITY_KIND) return undefined;
  const deck = record(record(activity.payload)?.slidesDeck);
  const pageId = text(deck?.pageId, 256);
  const title = text(deck?.title, MAX_TITLE);
  const slideCount = count(deck?.slideCount);
  const change = deck?.change;
  if (
    !deck ||
    pageId === null ||
    title === null ||
    slideCount === null ||
    (change !== "created" && change !== "edited" && change !== "proposed")
  )
    return undefined;
  return {
    pageId,
    scopeSpaceId: text(deck.scopeSpaceId, 256),
    title,
    slideCount,
    coverText: text(deck.coverText, MAX_COVER_TEXT + 1),
    change,
  };
}

export function threadOutputFileActivityPayload(file: ThreadOutputFileArtifact) {
  return {
    threadOutput: {
      file: file.file,
      name: file.name,
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    },
  };
}

export function threadOutputFileFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): ThreadOutputFileArtifact | undefined {
  if (activity.kind !== THREAD_OUTPUT_FILE_ACTIVITY_KIND) return undefined;
  const output = record(record(activity.payload)?.threadOutput);
  const file = text(output?.file, MAX_PATH);
  const name = text(output?.name, MAX_TITLE);
  if (!output || file === null || name === null) return undefined;
  const sha256 = text(output.sha256, 128);
  return {
    file,
    name,
    path: text(output.path, MAX_PATH),
    bytes: count(output.bytes),
    sha256: sha256 !== null && /^[a-f\d]{16,128}$/iu.test(sha256) ? sha256 : null,
  };
}

export interface ThreadOutputLink {
  readonly threadId: string;
  readonly file: string;
  readonly sha256: string | null;
}

/** Reads a Moss download link (`/api/thread-output?threadId=…&file=…`), or null. */
export function readThreadOutputHref(href: string | null | undefined): ThreadOutputLink | null {
  if (!href?.startsWith(`${THREAD_OUTPUT_ROUTE}?`)) return null;
  let params: URLSearchParams;
  try {
    params = new URL(href, "http://moss.invalid").searchParams;
  } catch {
    return null;
  }
  const threadId = text(params.get("threadId"), 256);
  const file = text(params.get("file"), MAX_PATH);
  if (threadId === null || file === null) return null;
  return { threadId, file, sha256: text(params.get("sha256"), 128) };
}

const THREAD_OUTPUT_LINK_PATTERN = new RegExp(
  `${THREAD_OUTPUT_ROUTE.replaceAll("/", "\\/")}\\?[^\\s)\\]"'<>]+`,
  "gu",
);

/**
 * The thread-output files a message links to. The chat draws a linked file as a card in the
 * text, so the same file's exported-file card under the answer is not drawn twice.
 */
export function threadOutputFilesLinkedIn(markdown: string): ReadonlySet<string> {
  const files = new Set<string>();
  if (!markdown.includes(THREAD_OUTPUT_ROUTE)) return files;
  for (const match of markdown.matchAll(THREAD_OUTPUT_LINK_PATTERN)) {
    const link = readThreadOutputHref(match[0].replaceAll("&amp;", "&"));
    if (link) files.add(link.file);
  }
  return files;
}
