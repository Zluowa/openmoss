// FILE: dockRuntimeResidency.ts
// Purpose: Decide, across every conversation in this window, which heavy side-panel runtimes stay
//          loaded while hidden: Canvas, slides, HTML renders and the apps a conversation opened.
// Layer: Web runtime registry (module state) + React hook
// Exports: registerResidentRuntime, useResidentRuntime, residentRuntimeSnapshot,
//          RESIDENT_RUNTIME_SAVE_RETRY_MS
// Depends on: @moss/shared/runtimeResidency (the policy the desktop browser uses too)
//
// Each runtime registers once and reports whether it is shown and whether it is in use. The
// registry applies the shared policy for its class: a hidden runtime stays warm, so switching
// back is instant; after the class's delay, or when its conversation or the app holds too many,
// the least recently used one is asked to save and is then unloaded. Shown again, it loads from
// what it saved.
//
//   loaded ──hidden past delay or over budget──▶ saving ──saved──▶ suspended
//     ▲                                            │ not saved          │
//     │                                            ▼                    │
//     └──────── shown ◀──────── loaded (pinned until the retry) ◀───────┘ shown: loads again
//
// A runtime that cannot save keeps its work: it stays loaded and is asked again later.

import {
  planRuntimeResidency,
  RUNTIME_RESIDENCY_POLICIES,
  type ResidentRuntimeState,
  type RuntimeResidencyClass,
} from "@moss/shared/runtimeResidency";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** A save that did not finish is tried again after this long. */
export const RESIDENT_RUNTIME_SAVE_RETRY_MS = 10_000;

export type ResidentRuntimePhase = "loaded" | "saving" | "suspended";
type WebRuntimeClass = Extract<RuntimeResidencyClass, "dockFrame" | "appWidget">;

interface Entry {
  readonly key: string;
  readonly owner: string;
  readonly runtimeClass: WebRuntimeClass;
  suspend: () => Promise<boolean>;
  visible: boolean;
  pinned: boolean;
  lastActiveAt: number;
  hiddenSince: number | null;
  phase: ResidentRuntimePhase;
  retryAt: number;
  readonly listeners: Set<() => void>;
}

export interface ResidentRuntimeHandle {
  /** Report whether the runtime is shown and whether it is in use (never suspended then). */
  update(input: { readonly visible: boolean; readonly pinned?: boolean }): void;
  /** Replace the save step (it may close over newer state). */
  setSuspend(suspend: () => Promise<boolean>): void;
  getPhase(): ResidentRuntimePhase;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify(entry: Entry) {
  for (const listener of entry.listeners) listener();
}

function setPhase(entry: Entry, phase: ResidentRuntimePhase) {
  if (entry.phase === phase) return;
  entry.phase = phase;
  notify(entry);
}

/** One timer for the whole registry, always set to the earliest moment something is due. */
function schedule(at: number | null) {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (at === null) return;
  timer = setTimeout(
    () => {
      timer = null;
      reconcile();
    },
    Math.max(0, at - Date.now()),
  );
}

function stateOf(entry: Entry, now: number): ResidentRuntimeState {
  return {
    key: entry.key,
    owner: entry.owner,
    visible: entry.visible,
    // Saving, or waiting to retry a save that failed: leave it alone for now.
    pinned: entry.pinned || entry.phase === "saving" || entry.retryAt > now,
    lastActiveAt: entry.lastActiveAt,
    hiddenSince: entry.hiddenSince,
  };
}

function suspendEntry(entry: Entry) {
  setPhase(entry, "saving");
  void entry
    .suspend()
    .catch(() => false)
    .then((saved) => {
      if (entries.get(entry.key) !== entry || entry.phase !== "saving") return;
      if (saved && !entry.visible) {
        setPhase(entry, "suspended");
        return;
      }
      // Shown again while saving: stay loaded. Not saved: keep the work and ask again later.
      if (!saved) entry.retryAt = Date.now() + RESIDENT_RUNTIME_SAVE_RETRY_MS;
      setPhase(entry, "loaded");
      reconcile();
    });
}

function reconcile() {
  const now = Date.now();
  let next: number | null = null;
  for (const runtimeClass of ["dockFrame", "appWidget"] as const) {
    const loaded = [...entries.values()].filter(
      (entry) => entry.runtimeClass === runtimeClass && entry.phase !== "suspended",
    );
    if (loaded.length === 0) continue;
    const plan = planRuntimeResidency({
      runtimes: loaded.map((entry) => stateOf(entry, now)),
      now,
      policy: RUNTIME_RESIDENCY_POLICIES[runtimeClass],
    });
    for (const key of plan.suspend) {
      const entry = entries.get(key);
      if (entry?.phase === "loaded") suspendEntry(entry);
    }
    for (const at of [
      plan.nextCheckAt,
      ...loaded.filter((entry) => entry.retryAt > now).map((entry) => entry.retryAt),
    ]) {
      if (at !== null && (next === null || at < next)) next = at;
    }
  }
  schedule(next);
}

/** Register one runtime. Keys are unique in the window; a second registration replaces the first. */
export function registerResidentRuntime(input: {
  readonly key: string;
  readonly owner: string;
  readonly runtimeClass: WebRuntimeClass;
  readonly visible: boolean;
  readonly pinned?: boolean;
  readonly suspend: () => Promise<boolean>;
}): ResidentRuntimeHandle {
  const now = Date.now();
  const entry: Entry = {
    key: input.key,
    owner: input.owner,
    runtimeClass: input.runtimeClass,
    suspend: input.suspend,
    visible: input.visible,
    pinned: input.pinned ?? false,
    lastActiveAt: now,
    hiddenSince: input.visible ? null : now,
    phase: "loaded",
    retryAt: 0,
    listeners: new Set(),
  };
  entries.set(entry.key, entry);
  reconcile();
  return {
    update({ visible, pinned }) {
      if (entries.get(entry.key) !== entry) return;
      const changed = visible !== entry.visible || (pinned ?? false) !== entry.pinned;
      if (!changed) return;
      const time = Date.now();
      if (visible) {
        entry.hiddenSince = null;
        entry.retryAt = 0;
        if (entry.phase === "suspended") setPhase(entry, "loaded");
      } else if (entry.visible) {
        entry.hiddenSince = time;
      }
      if (visible || entry.visible) entry.lastActiveAt = time;
      entry.visible = visible;
      entry.pinned = pinned ?? false;
      reconcile();
    },
    setSuspend(suspend) {
      entry.suspend = suspend;
    },
    getPhase: () => entry.phase,
    subscribe(listener) {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    dispose() {
      if (entries.get(entry.key) !== entry) return;
      entries.delete(entry.key);
      entry.listeners.clear();
      reconcile();
    },
  };
}

/** What is registered right now (diagnostics and tests). */
export function residentRuntimeSnapshot(): ReadonlyArray<{
  readonly key: string;
  readonly runtimeClass: WebRuntimeClass;
  readonly phase: ResidentRuntimePhase;
  readonly visible: boolean;
}> {
  return [...entries.values()].map(({ key, runtimeClass, phase, visible }) => ({
    key,
    runtimeClass,
    phase,
    visible,
  }));
}

const noopSubscribe = () => () => undefined;

/**
 * Keep a heavy runtime loaded while it is shown or in use, and let the shared policy unload it
 * (after `suspend` saved it) while hidden. `loaded` is false once it has been unloaded; render a
 * placeholder then. Showing it again sets `loaded` back to true.
 */
export function useResidentRuntime(input: {
  /** False while there is nothing heavy to hold (it is then not registered and counts for nothing). */
  readonly active?: boolean;
  readonly key: string;
  readonly owner: string;
  readonly runtimeClass: WebRuntimeClass;
  readonly visible: boolean;
  readonly pinned?: boolean;
  /** Save what must survive the unload; resolve false to stay loaded and be asked again. */
  readonly suspend: () => Promise<boolean>;
}): { readonly phase: ResidentRuntimePhase; readonly loaded: boolean } {
  const suspend = useRef(input.suspend);
  suspend.current = input.suspend;
  const latest = useRef({ visible: input.visible, pinned: input.pinned ?? false });
  latest.current = { visible: input.visible, pinned: input.pinned ?? false };
  const [handle, setHandle] = useState<ResidentRuntimeHandle | null>(null);
  const { key, owner, runtimeClass } = input;
  const active = input.active ?? true;
  useEffect(() => {
    if (!active) return;
    const created = registerResidentRuntime({
      key,
      owner,
      runtimeClass,
      ...latest.current,
      suspend: () => suspend.current(),
    });
    setHandle(created);
    return () => {
      created.dispose();
      setHandle(null);
    };
  }, [active, key, owner, runtimeClass]);
  const pinned = input.pinned ?? false;
  useEffect(() => {
    handle?.update({ visible: input.visible, pinned });
  }, [handle, input.visible, pinned]);
  const phase = useSyncExternalStore(
    handle?.subscribe ?? noopSubscribe,
    () => handle?.getPhase() ?? "loaded",
    () => "loaded" as const,
  );
  return { phase, loaded: phase !== "suspended" };
}
