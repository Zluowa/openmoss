// FILE: pageAiSession.ts
// Purpose: Per-page state shared by the page AI pieces that live in different places: the page
//          composer and quick actions (page chrome slots), and the editor bridge inside the
//          page editor host. Holds the AI runs started from a page and how to reach its editor.
// Layer: Web lib (page AI)

import type { PageDraftOp, ThreadId, TurnId } from "@moss/contracts";
import { useSyncExternalStore } from "react";

export type PageAiRunMode = "compose" | "generate" | "visualize" | "image" | "prompt";
export interface PageAiRun {
  readonly id: string;
  readonly mode: PageAiRunMode;
  readonly prompt: string;
  readonly threadId: ThreadId | null;
  /**
   * The chat's latest turn before this run was sent. The page's assistant chat is reused,
   * so this run's turn and reply are the ones after it.
   */
  readonly baselineTurnId?: TurnId | null;
  /** Where a 生成 result lands: after this block, or at the end. */
  readonly anchorBlockId: string | null;
  readonly baseRevision: number;
  readonly status: "starting" | "running" | "drafted" | "done" | "failed";
  readonly error?: string;
  /** Text streamed so far for runs that write straight into the page. */
  readonly streamed?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/** Commands the page editor bridge registers so chrome slots can drive the editor. */
export interface PageAiEditorCommands {
  /** "insert" opens the page's insert menu on a new line (the top bar's ＋). */
  readonly openAiInput: (mode: "generate" | "visualize" | "image" | "insert") => void;
  readonly runInsertItem: (value: string) => void;
  /** The person is about to ask the page's assistant: start its agent. */
  readonly prepare: () => void;
  readonly startRun: (input: {
    mode: PageAiRunMode;
    prompt: string;
    anchorBlockId: string | null;
  }) => Promise<void>;
}

interface PageAiPageState {
  readonly runs: readonly PageAiRun[];
  readonly editor: PageAiEditorCommands | null;
  /** The inline AI card open in the editor, shown as a pressed quick action. */
  readonly openCard: "generate" | "visualize" | "image" | null;
}

const EMPTY: PageAiPageState = { runs: [], editor: null, openCard: null };
const pages = new Map<string, PageAiPageState>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export const pageAiKey = (account: string, scopeSpaceId: string | null, pageId: string) =>
  `${account}:${scopeSpaceId ?? "local"}:${pageId}`;

export const pageAiSession = {
  get: (key: string): PageAiPageState => pages.get(key) ?? EMPTY,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  registerEditor: (key: string, editor: PageAiEditorCommands | null) => {
    pages.set(key, { ...pageAiSession.get(key), editor });
    notify();
  },
  setOpenCard: (key: string, openCard: PageAiPageState["openCard"]) => {
    if (pageAiSession.get(key).openCard === openCard) return;
    pages.set(key, { ...pageAiSession.get(key), openCard });
    notify();
  },
  addRun: (key: string, run: PageAiRun) => {
    const state = pageAiSession.get(key);
    // Keep the recent history short; finished runs only feed the composer's status line.
    pages.set(key, { ...state, runs: [...state.runs, run].slice(-12) });
    notify();
  },
  updateRun: (key: string, id: string, patch: Partial<PageAiRun>) => {
    const state = pageAiSession.get(key);
    if (!state.runs.some((run) => run.id === id)) return;
    pages.set(key, {
      ...state,
      runs: state.runs.map((run) => (run.id === id ? { ...run, ...patch } : run)),
    });
    notify();
  },
};

export function usePageAiSession(key: string): PageAiPageState {
  return useSyncExternalStore(
    pageAiSession.subscribe,
    () => pageAiSession.get(key),
    () => EMPTY,
  );
}

export const isActiveRun = (run: PageAiRun) =>
  run.status === "starting" || run.status === "running";

/** A run that streams into the page shows as a draft while the agent is still writing. */
export function streamingDraftOps(run: PageAiRun): PageDraftOp[] {
  const markdown = run.streamed ?? "";
  return run.anchorBlockId
    ? [{ kind: "insert", afterBlockId: run.anchorBlockId, markdown }]
    : [{ kind: "insert", markdown }];
}
