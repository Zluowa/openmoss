// FILE: openUIReflow.ts
// Purpose: Turn OpenUI component actions (button clicks, form submissions) into
//          a conversation reflow: either an external URL open or a new composer
//          message seeded with the action's human-readable label + form state.
// Layer: Web chat presentation logic

import type { ActionEvent } from "@openuidev/react-lang";

/** Structural minimum of react-lang's ActionEvent, so tests stay dependency-free. */
export interface OpenUIActionEventLike {
  readonly type: string;
  readonly params?: Record<string, unknown> | undefined;
  readonly humanFriendlyMessage?: string | undefined;
  readonly formState?: Record<string, unknown> | undefined;
  readonly formName?: string | undefined;
}

export type OpenUIActionDispatch =
  | { readonly kind: "open-url"; readonly url: string }
  | { readonly kind: "follow-up"; readonly message: string }
  | { readonly kind: "ignore" };

const OPENUI_BUILTIN_OPEN_URL = "open_url";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_STATE_ENTRIES = 24;

function formatStateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map((item) => formatStateValue(item))
      .filter((item): item is string => item !== null);
    return items.length > 0 ? items.join(", ") : null;
  }
  return null;
}

/**
 * Flattens react-lang's form-state map
 * `{ formName: { fieldName: { value, componentType } }, $var: value }` into
 * `form.field: value` lines for the follow-up prompt. Reactive `$`-bindings and
 * empty values are skipped; anything unrecognized is ignored rather than
 * stringified (raw objects would leak noise into the conversation).
 */
export function summarizeOpenUIFormState(formState: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [scope, fields] of Object.entries(formState)) {
    if (lines.length >= MAX_STATE_ENTRIES) break;
    if (scope.startsWith("$")) continue;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    for (const [fieldName, field] of Object.entries(fields as Record<string, unknown>)) {
      if (lines.length >= MAX_STATE_ENTRIES) break;
      const rawValue =
        field && typeof field === "object" && !Array.isArray(field)
          ? (field as Record<string, unknown>).value
          : field;
      const text = formatStateValue(rawValue);
      if (text === null) continue;
      lines.push(`${scope}.${fieldName}: ${text}`);
    }
  }
  return lines;
}

/** Builds the user-visible follow-up message for an OpenUI action. */
export function buildOpenUIFollowUpMessage(event: OpenUIActionEventLike): string {
  const label = event.humanFriendlyMessage?.trim() || "OpenUI action";
  const stateLines = event.formState ? summarizeOpenUIFormState(event.formState) : [];
  const message = stateLines.length > 0 ? `${label}\n\n${stateLines.join("\n")}` : label;
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : message;
}

/**
 * Routes an OpenUI action event: `open_url` actions leave the app, everything
 * else with a usable label reflows into the conversation as a user message.
 */
export function resolveOpenUIActionDispatch(event: OpenUIActionEventLike): OpenUIActionDispatch {
  if (event.type === OPENUI_BUILTIN_OPEN_URL) {
    const url = event.params?.url;
    if (typeof url === "string" && /^https?:\/\//u.test(url)) {
      return { kind: "open-url", url };
    }
    return { kind: "ignore" };
  }
  if (!event.humanFriendlyMessage?.trim()) {
    return { kind: "ignore" };
  }
  return { kind: "follow-up", message: buildOpenUIFollowUpMessage(event) };
}

export type { ActionEvent };

// --- Composer reflow -------------------------------------------------------

import type { ThreadId } from "@synara/contracts";

import { requestComposerFocus } from "../composerFocusRequestStore";
import { useComposerDraftStore } from "../composerDraftStore";

/**
 * Default interaction reflow, mirroring the plugin "Try in chat" pattern: the
 * action's message lands in the thread's composer draft and the composer takes
 * focus, so the user reviews/edits before sending instead of a component
 * silently spending a turn. An existing draft is preserved by appending.
 */
export function injectOpenUIFollowUpIntoComposer(threadId: ThreadId, message: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.draftsByThreadId[threadId]?.prompt?.trim() ?? "";
  store.setPrompt(threadId, existing ? `${existing}\n\n${message}` : message);
  requestComposerFocus(threadId);
}
