import type { ThreadId } from "@moss/contracts";
import type { GroupSettingsSection } from "../group/groupSettingsDialog.logic";

/** UI-only requests; execution and permission decisions stay with the runtime. */
export const CONVERSATION_PANEL_REQUEST = "moss:conversation-panel-request";
export type ConversationPanelRequest = {
  threadId: ThreadId;
} & ({ action: "overview" | "find" } | { action: "settings"; section: GroupSettingsSection });

export function requestConversationPanel(request: ConversationPanelRequest): void {
  window.dispatchEvent(new CustomEvent(CONVERSATION_PANEL_REQUEST, { detail: request }));
}
