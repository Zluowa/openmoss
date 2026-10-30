// FILE: quickChatEvents.ts
// Purpose: Route-independent request channel for toggling the retained Quick Chat window.
// Layer: Web UI event bridge

export const QUICK_CHAT_TOGGLE_EVENT = "moss:quick-chat-toggle";

export function requestQuickChatToggle(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(QUICK_CHAT_TOGGLE_EVENT));
}
