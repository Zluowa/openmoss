// FILE: chatArtifacts.ts
// Purpose: What an agent made in a turn that the chat shows as cards under its answer: the
//          slides decks it created or changed and the files it exported.
// Layer: Web chat logic (pure)
// Exports: ChatArtifact, TurnChatArtifact, chatArtifactFromActivity, collectTurnChatArtifacts,
//          visibleChatArtifacts, chatArtifactsEqual

import {
  pageAppFromActivity,
  slidesDeckFromActivity,
  threadOutputFileFromActivity,
  threadOutputFilesLinkedIn,
  type PageAppArtifact,
  type SlidesDeckArtifact,
  type ThreadOutputFileArtifact,
} from "@moss/shared/chatArtifactActivity";

export type ChatArtifact =
  | { readonly kind: "deck"; readonly deck: SlidesDeckArtifact }
  | { readonly kind: "pageApp"; readonly pageApp: PageAppArtifact }
  | { readonly kind: "file"; readonly file: ThreadOutputFileArtifact };

export interface TurnChatArtifact {
  /** The activity that recorded it; stable across renders. */
  readonly id: string;
  readonly artifact: ChatArtifact;
}

export function chatArtifactFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): ChatArtifact | undefined {
  const deck = slidesDeckFromActivity(activity);
  if (deck) return { kind: "deck", deck };
  const pageApp = pageAppFromActivity(activity);
  if (pageApp) return { kind: "pageApp", pageApp };
  const file = threadOutputFileFromActivity(activity);
  return file ? { kind: "file", file } : undefined;
}

function artifactKey(artifact: ChatArtifact): string {
  if (artifact.kind === "deck") {
    return `deck:${artifact.deck.scopeSpaceId ?? ""}:${artifact.deck.pageId}`;
  }
  if (artifact.kind === "pageApp") {
    return `pageApp:${artifact.pageApp.appId}`;
  }
  return `file:${artifact.file.file}`;
}

/**
 * Groups a thread's artifacts by turn. One card per deck and per file: a deck the agent
 * created and then edited three times is one card that shows its newest state, in the place
 * the deck first appeared. A deck the agent created stays "created" after later edits.
 */
export function collectTurnChatArtifacts(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly turnId?: string | null | undefined;
    readonly chatArtifact?: ChatArtifact | undefined;
  }>,
): Map<string, TurnChatArtifact[]> {
  const byTurn = new Map<string, TurnChatArtifact[]>();
  for (const entry of entries) {
    const artifact = entry.chatArtifact;
    if (!artifact || !entry.turnId) continue;
    const turnId = String(entry.turnId);
    const list = byTurn.get(turnId) ?? [];
    const key = artifactKey(artifact);
    const index = list.findIndex((item) => artifactKey(item.artifact) === key);
    if (index === -1) {
      list.push({ id: entry.id, artifact });
    } else {
      const previous = list[index]!;
      const merged: ChatArtifact =
        artifact.kind === "deck" &&
        previous.artifact.kind === "deck" &&
        previous.artifact.deck.change === "created"
          ? { kind: "deck", deck: { ...artifact.deck, change: "created" } }
          : artifact.kind === "pageApp" &&
              previous.artifact.kind === "pageApp" &&
              previous.artifact.pageApp.change === "created"
            ? { kind: "pageApp", pageApp: { ...artifact.pageApp, change: "created" } }
            : artifact;
      list[index] = { id: previous.id, artifact: merged };
    }
    byTurn.set(turnId, list);
  }
  return byTurn;
}

/** Drops exported-file cards for files the answer already links to (drawn as cards in the text). */
export function visibleChatArtifacts(
  artifacts: ReadonlyArray<TurnChatArtifact> | undefined,
  answerMarkdown: string,
): ReadonlyArray<TurnChatArtifact> {
  if (!artifacts || artifacts.length === 0) return [];
  const linked = threadOutputFilesLinkedIn(answerMarkdown);
  if (linked.size === 0) return artifacts;
  return artifacts.filter(
    (item) => item.artifact.kind !== "file" || !linked.has(item.artifact.file.file),
  );
}

function artifactsEqual(left: ChatArtifact, right: ChatArtifact): boolean {
  if (left.kind === "deck" && right.kind === "deck") {
    const a = left.deck;
    const b = right.deck;
    return (
      a.pageId === b.pageId &&
      a.scopeSpaceId === b.scopeSpaceId &&
      a.title === b.title &&
      a.slideCount === b.slideCount &&
      a.coverText === b.coverText &&
      a.change === b.change
    );
  }
  if (left.kind === "pageApp" && right.kind === "pageApp") {
    const a = left.pageApp;
    const b = right.pageApp;
    return (
      a.appId === b.appId &&
      a.title === b.title &&
      a.description === b.description &&
      a.revision === b.revision &&
      a.change === b.change
    );
  }
  if (left.kind === "file" && right.kind === "file") {
    const a = left.file;
    const b = right.file;
    return (
      a.file === b.file &&
      a.name === b.name &&
      a.path === b.path &&
      a.bytes === b.bytes &&
      a.sha256 === b.sha256
    );
  }
  return false;
}

export function chatArtifactsEqual(
  left: ReadonlyArray<TurnChatArtifact> | undefined,
  right: ReadonlyArray<TurnChatArtifact> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.id === right[index]!.id && artifactsEqual(item.artifact, right[index]!.artifact),
  );
}

const NO_DECK_CARDS: ReadonlySet<string> = new Set();
const deckCardPageIdsCache = new WeakMap<ReadonlyArray<TurnChatArtifact>, ReadonlySet<string>>();

/** The decks that have a card under an answer; their `moss://space-page/` links are not drawn. */
export function deckCardPageIds(
  artifacts: ReadonlyArray<TurnChatArtifact> | undefined,
): ReadonlySet<string> {
  if (!artifacts || artifacts.length === 0) return NO_DECK_CARDS;
  let ids = deckCardPageIdsCache.get(artifacts);
  if (!ids) {
    ids = new Set(
      artifacts.flatMap((item) =>
        item.artifact.kind === "deck" ? [item.artifact.deck.pageId] : [],
      ),
    );
    deckCardPageIdsCache.set(artifacts, ids);
  }
  return ids;
}
