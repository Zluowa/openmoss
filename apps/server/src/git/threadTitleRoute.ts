// FILE: threadTitleRoute.ts
// Purpose: The pure decisions behind a chat's generated title: which text-generation route
//          writes it, at what effort, and how Codex's native fork is asked for one when no
//          isolated route can serve the chat on this platform.
// Layer: Server domain logic (no IO)
// Exports: resolveThreadTitleRoute, withLowTitleEffort, buildThreadTitleForkPrompt,
//          parseThreadTitleForkReply, THREAD_TITLE_FORK_EFFORT_FALLBACK

import type { ModelSelection, ProviderKind } from "@moss/contracts";
import {
  isUsableGeneratedThreadTitle,
  sanitizeGeneratedThreadTitle,
} from "@moss/shared/chatThreads";
import { EMPTY_MODEL_CAPABILITIES, getModelCapabilities } from "@moss/shared/model";

import type { IsolatedTextGenerationSupport } from "./Services/TextGeneration.ts";
import { buildThreadTitlePrompt } from "./textGenerationShared.ts";
import type { TextGenerationProviderInput } from "./textGenerationSelection.ts";

/** Option key each provider reads its effort from; OpenCode's variants are never invented. */
const TITLE_EFFORT_OPTION_KEY: Partial<Record<ProviderKind, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
  cursor: "reasoningEffort",
  droid: "reasoningEffort",
};

/** Ladder order across providers; a level outside it ranks after every known one. */
const EFFORT_ORDER = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Every Codex reasoning model takes it; used for a model the catalog does not list yet. */
export const THREAD_TITLE_FORK_EFFORT_FALLBACK = "low";

function lowestCatalogEffort(provider: ProviderKind, model: string): string | null | undefined {
  const capabilities = getModelCapabilities(provider, model);
  if (capabilities === EMPTY_MODEL_CAPABILITIES) return undefined;
  const levels = capabilities.reasoningEffortLevels
    .filter((level) => level.controlSource === undefined || level.controlSource === "api-effort")
    .map((level, index) => {
      const rank = EFFORT_ORDER.indexOf(level.value);
      return { value: level.value, rank: rank >= 0 ? rank : EFFORT_ORDER.length + index };
    });
  if (levels.length === 0) return null;
  return levels.reduce((lowest, level) => (level.rank < lowest.rank ? level : lowest)).value;
}

/**
 * The effort a title is written at: the lowest the catalog lists for the model; `low` for a
 * Codex model the catalog does not know yet; null to leave the selection's own (a known model
 * without effort levels, or a provider whose levels Moss does not name).
 */
export function resolveTitleEffort(provider: ProviderKind, model: string): string | null {
  const lowest = lowestCatalogEffort(provider, model);
  if (lowest === undefined) return provider === "codex" ? THREAD_TITLE_FORK_EFFORT_FALLBACK : null;
  return lowest;
}

/**
 * A five-word title gains nothing from reasoning: the selection at its lowest effort, whatever
 * effort the chat itself runs at. Options travel as a record or as a list of `{ id, value }`.
 */
export function withLowTitleEffort(selection: ModelSelection): ModelSelection {
  const key = TITLE_EFFORT_OPTION_KEY[selection.provider];
  const effort = resolveTitleEffort(selection.provider, selection.model);
  if (key === undefined || effort === null) return selection;
  const options: unknown = selection.options;
  if (Array.isArray(options)) {
    return {
      ...selection,
      options: [
        ...options.filter((option: { readonly id?: unknown }) => option?.id !== key),
        { id: key, value: effort },
      ],
    } as ModelSelection;
  }
  return {
    ...selection,
    options: { ...(options as Record<string, unknown> | undefined), [key]: effort },
  } as ModelSelection;
}

/** One candidate route with what the isolated path says about it here. */
export interface ThreadTitleCandidate {
  readonly input: TextGenerationProviderInput;
  readonly support: IsolatedTextGenerationSupport;
}

/**
 * - `isolated`: the isolated text-generation path writes the title now.
 * - `native`: no isolated route serves this chat here (on Windows, a person's own Codex
 *   account that is not a direct endpoint with a key), so Codex's native fork of the live
 *   thread writes it once the first turn settles.
 * - `none`: nothing can write it; the prompt-derived title stays.
 */
export type ThreadTitleRoute =
  | {
      readonly kind: "isolated";
      readonly input: TextGenerationProviderInput;
      readonly source: "chat" | "configured";
    }
  | { readonly kind: "native" }
  | { readonly kind: "none" };

/**
 * The chat's own route first, then the configured text-generation model, each only where the
 * isolated path serves it on this platform. A Codex chat that neither serves falls back to the
 * native fork. Never a third account.
 */
export function resolveThreadTitleRoute(input: {
  readonly chat: ThreadTitleCandidate | null;
  readonly configured: ThreadTitleCandidate | null;
  readonly chatDriver: ProviderKind | undefined;
}): ThreadTitleRoute {
  if (input.chat && input.chat.support.kind === "supported") {
    return { kind: "isolated", input: input.chat.input, source: "chat" };
  }
  if (input.configured && input.configured.support.kind === "supported") {
    return { kind: "isolated", input: input.configured.input, source: "configured" };
  }
  return input.chatDriver === "codex" ? { kind: "native" } : { kind: "none" };
}

/**
 * The prompt of a title turn on Codex's native fork, with the same rules as the isolated
 * prompt. The fork holds the conversation; `message` is the first request, or the
 * conversation context when a person asks for a new title.
 */
export function buildThreadTitleForkPrompt(message: string, context?: "conversation"): string {
  return [
    "This message only asks for a title for this chat: do not run commands, call tools, or change anything, and do not continue the work.",
    buildThreadTitlePrompt({ message, ...(context ? { context } : {}) }).prompt,
    "",
    'Return only JSON matching this schema: {"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}.',
  ].join("\n");
}

function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text.trim());
  return fenced?.[1] ?? text.trim();
}

/** The title in a fork's reply, sanitized like every generated title; null when unusable. */
export function parseThreadTitleForkReply(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
  const title =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).title
      : undefined;
  if (typeof title !== "string") return null;
  const sanitized = sanitizeGeneratedThreadTitle(title);
  return isUsableGeneratedThreadTitle(sanitized) ? sanitized : null;
}
