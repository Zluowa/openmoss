// FILE: usePageAssistantThreadIds.ts
// Purpose: The threads that are a 资料空间 item's own chat, kept current as items bind them.
// Layer: Web hook over the page-assistant registry
// Exports: usePageAssistantThreadIds

import { useSyncExternalStore } from "react";

import { pageAssistantThreads } from "../lib/pageAi/pageAssistantThread";

export function usePageAssistantThreadIds(): ReadonlySet<string> {
  useSyncExternalStore(pageAssistantThreads.subscribe, pageAssistantThreads.version);
  return pageAssistantThreads.threadIds();
}
