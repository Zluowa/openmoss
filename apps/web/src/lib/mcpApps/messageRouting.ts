// FILE: messageRouting.ts
// Purpose: What a widget's `ui/message` does (SPEC §7): it fills the composer when empty, asks
//          before replacing a draft (6.5 s), drops repeats within 5.25 s, and sends on its own
//          only for Moss's first-party tools after a real click in the widget.
// Layer: Web MCP App host policy
// Exports: createMcpAppMessageRouter, joinMcpAppMessageText

import type {
  McpUiMessageRequest,
  McpUiMessageResult,
} from "@modelcontextprotocol/ext-apps/app-bridge";

import { MCP_APP_MESSAGE_DEDUPE_MS, MCP_APP_MESSAGE_REPLACE_TOAST_MS } from "./constants";

export interface McpAppMessageRouterDeps {
  readonly isFirstParty: boolean;
  readonly serverLabel: string;
  readonly readComposer: () => string;
  /** Put text in the composer without focusing it. */
  readonly writeComposer: (text: string) => void;
  /** Resolves true when the person chose to replace their draft before the timeout. */
  readonly askReplace: (serverLabel: string, timeoutMs: number) => Promise<boolean>;
  /** Sends a user turn right away; null when this thread cannot send from here. */
  readonly sendNow: ((text: string) => Promise<boolean>) | null;
  readonly notifySent: (serverLabel: string) => void;
  readonly now?: () => number;
}

export function joinMcpAppMessageText(params: McpUiMessageRequest["params"]): string {
  const content = Array.isArray(params?.content) ? params.content : [];
  return content
    .flatMap((block) =>
      block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

export function createMcpAppMessageRouter(deps: McpAppMessageRouterDeps) {
  const now = deps.now ?? Date.now;
  let lastText: string | null = null;
  let lastAt = -Infinity;

  return async function routeMessage(
    params: McpUiMessageRequest["params"],
    userActivation: boolean,
  ): Promise<McpUiMessageResult> {
    const text = joinMcpAppMessageText(params);
    if (text.trim().length === 0) return { isError: true };
    const at = now();
    if (lastText === text && at - lastAt < MCP_APP_MESSAGE_DEDUPE_MS) return {};
    lastText = text;
    lastAt = at;

    if (deps.isFirstParty && userActivation && deps.sendNow) {
      const sent = await deps.sendNow(text).catch(() => false);
      if (sent) {
        deps.notifySent(deps.serverLabel);
        return {};
      }
    }
    const draft = deps.readComposer();
    if (draft.trim().length === 0) {
      deps.writeComposer(text);
      return {};
    }
    const replace = await deps
      .askReplace(deps.serverLabel, MCP_APP_MESSAGE_REPLACE_TOAST_MS)
      .catch(() => false);
    if (!replace) return { isError: true };
    deps.writeComposer(text);
    return {};
  };
}
