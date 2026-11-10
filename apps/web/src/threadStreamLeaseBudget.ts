// FILE: threadStreamLeaseBudget.ts
// Purpose: How many retained (not visible) chats may keep a live thread stream on this connection.
// Layer: Web subscription utility
// Exports: budget read/subscribe hooks, the refusal and reset signals the transport sends.
//
// The thread-stream cap (`WS_STREAM_LIMITS.threadPerClient`) is a ceiling, not a promise: every
// thread lease also takes a slot in the connection's total budget, which app-wide streams share.
// When the server refuses a thread stream for capacity, retained chats give their slots up
// one at a time (the lease resolver drops the least recently used first) so the chat on screen
// gets in. Visible chats never count against this budget. A new connection starts at the cap.

import { WS_STREAM_LIMITS } from "@moss/contracts";
import { useSyncExternalStore } from "react";

const MAX_RETAINED_THREAD_STREAM_BUDGET = WS_STREAM_LIMITS.threadPerClient;

let retainedThreadStreamBudget: number = MAX_RETAINED_THREAD_STREAM_BUDGET;
const listeners = new Set<() => void>();

function setBudget(next: number): void {
  if (next === retainedThreadStreamBudget) return;
  retainedThreadStreamBudget = next;
  for (const listener of listeners) listener();
}

export function getRetainedThreadStreamBudget(): number {
  return retainedThreadStreamBudget;
}

/**
 * The server refused a thread stream for capacity while `leasedThreadCount` thread streams were
 * wanted. Shrink the retained share by one below what is leased now, so the next lease set frees
 * a slot. Repeated refusals keep shrinking it until no retained chat holds a stream.
 */
export function noteThreadStreamCapacityRefused(leasedThreadCount: number): void {
  const current = Math.min(retainedThreadStreamBudget, Math.max(0, leasedThreadCount));
  setBudget(Math.max(0, current - 1));
}

/** A fresh connection has a fresh admission ledger, so retained chats may warm up again. */
export function resetRetainedThreadStreamBudget(): void {
  setBudget(MAX_RETAINED_THREAD_STREAM_BUDGET);
}

export function subscribeRetainedThreadStreamBudget(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRetainedThreadStreamBudget(): number {
  return useSyncExternalStore(
    subscribeRetainedThreadStreamBudget,
    getRetainedThreadStreamBudget,
    getRetainedThreadStreamBudget,
  );
}
