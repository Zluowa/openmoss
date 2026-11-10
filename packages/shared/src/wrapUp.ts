// FILE: wrapUp.ts
// Purpose: The `moss_wrap_up` turn-end box, shared by the agent gateway (which offers
//   and validates the tool) and the transcript (which draws the box). Mirrors the
//   desktop chat's next-step box: a short recap of what is now true, and, only when
//   the person has a decision or a step to take, one question with 1-2 answer buttons.
// Layer: Shared contract (pure)
// Exports: WRAP_UP_TOOL_NAME, WRAP_UP_LIMITS, WrapUp, parseWrapUp, isWrapUpToolName

export const WRAP_UP_TOOL_NAME = "moss_wrap_up";

export const WRAP_UP_LIMITS = {
  recapChars: 300,
  askChars: 100,
  actionLabelChars: 24,
  maxActions: 2,
} as const;

export interface WrapUp {
  /** Two or three sentences: what is now true, and what is not done or not verified. */
  readonly recap: string;
  /** One short question, present only when the next move is the person's. */
  readonly ask: string | null;
  /** 1-2 answers to `ask`, the recommended one first; each is sent back as a message. */
  readonly actions: readonly string[];
}

/** True for the tool however a provider prefixes MCP names (mcp__moss__moss_wrap_up). */
export function isWrapUpToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === WRAP_UP_TOOL_NAME || name.endsWith(`__${WRAP_UP_TOOL_NAME}`);
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Reads the tool input (an object, or its JSON text) into a box, or null when there
 * is no recap. Over-long fields are clipped rather than refused so a box still shows.
 */
export function parseWrapUp(input: unknown): WrapUp | null {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const recap =
    typeof record.recap === "string" ? clip(record.recap, WRAP_UP_LIMITS.recapChars) : "";
  if (recap === "") return null;
  const ask =
    typeof record.ask === "string" && record.ask.trim() !== ""
      ? clip(record.ask, WRAP_UP_LIMITS.askChars)
      : null;
  const rawActions = Array.isArray(record.actions) ? record.actions : [];
  const actions = ask
    ? rawActions
        .map((action) =>
          typeof action === "string"
            ? action
            : typeof action === "object" && action !== null && "label" in action
              ? String((action as { label: unknown }).label ?? "")
              : "",
        )
        .map((label) => clip(label, WRAP_UP_LIMITS.actionLabelChars))
        .filter((label, index, all) => label !== "" && all.indexOf(label) === index)
        .slice(0, WRAP_UP_LIMITS.maxActions)
    : [];
  return { recap, ask, actions };
}
