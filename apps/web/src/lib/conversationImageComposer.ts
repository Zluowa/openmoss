import { useSyncExternalStore } from "react";

export interface ConversationImageComposerHost {
  readonly target: HTMLElement | null;
  readonly beforeSend: () => Promise<boolean>;
  readonly beforeLeave: () => Promise<boolean>;
}

// The existing ChatView keeps ownership of its composer, provider and turn.
// Only its visual slot moves into the active image tab.
const hosts = new Map<string, ConversationImageComposerHost>();
const leaveGuards = new Map<string, Map<string, () => Promise<boolean>>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function registerConversationImageComposer(
  threadId: string,
  host: ConversationImageComposerHost,
): () => void {
  hosts.set(threadId, host);
  notify();
  return () => {
    if (hosts.get(threadId) !== host) return;
    hosts.delete(threadId);
    notify();
  };
}

export function getConversationImageComposer(threadId: string) {
  return hosts.get(threadId) ?? null;
}

export function registerConversationImageLeaveGuard(
  threadId: string,
  owner: string,
  guard: () => Promise<boolean>,
) {
  const guards = leaveGuards.get(threadId) ?? new Map();
  guards.set(owner, guard);
  leaveGuards.set(threadId, guards);
  return () => {
    if (guards.get(owner) === guard) guards.delete(owner);
    if (guards.size === 0) leaveGuards.delete(threadId);
  };
}

export async function flushConversationImageEditors(
  threadId: string,
  owner?: string,
): Promise<boolean> {
  const guards = leaveGuards.get(threadId);
  const selected = owner
    ? guards?.has(owner)
      ? [guards.get(owner)!]
      : []
    : [...(guards?.values() ?? [])];
  try {
    return (await Promise.all(selected.map((guard) => guard()))).every(Boolean);
  } catch {
    return false;
  }
}

export function useConversationImageComposer(threadId: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getConversationImageComposer(threadId),
    () => null,
  );
}
