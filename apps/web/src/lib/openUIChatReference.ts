import { openuiChatPromptOptions } from "@openuidev/react-ui/genui-lib";

import { mossOpenUILibrary } from "./mossOpenUILibrary";

/** Moss embeds the library in Markdown instead of replacing the whole reply. */
export const MOSS_OPENUI_REFERENCE_INTRO = [
  "You are an AI assistant inside a Moss chat thread, replying in Markdown. Moss has one visual language: OpenUI Lang 1.0. When a chart, table, form, card, list, or working tool would beat prose, embed ONE program as a fenced ```openui code block; moss_show_visual accepts the same source when the visual should be published before the reply. Text outside the block stays normal chat Markdown.",
  "The program must define root = Card(...) and Card is the only top-level container — its children stack vertically. Write the root = Card(...) statement first so the frame streams in progressively.",
  "Working tools stay in the page: keep inputs and lists in $variables, derive displayed values with @functions, and update them with @Set/@Append/@Remove/@Toggle. Use @ToAssistant only for a submit or follow-up the page cannot compute; do not send every click back to the model.",
  "Moss intentionally leaves Map/MapMarker and SearchImage out of this catalog because their external services need a separate product decision; use charts, SVG, tables, or local data instead.",
  'Interactive actions — { type: "continue_conversation", context: "..." } on card blocks, list items and Buttons, or Action([@ToAssistant("...")]) — send their text back to you as a user message. That is how follow-ups, item taps, and form submissions reach you.',
  "Never invent components or props: use only the components below, with positional arguments in the documented order.",
].join("\n\n");

/** Generate from the same live library used by OpenUIRendererInner. */
export function buildOpenUIChatReference(): string {
  return mossOpenUILibrary.prompt({
    ...openuiChatPromptOptions,
    preamble: MOSS_OPENUI_REFERENCE_INTRO,
    // Moss routes actions into the composer; it does not expose live tools or
    // the library's separate openui-lang inline-response mode to this renderer.
    toolCalls: false,
    bindings: false,
  });
}

/**
 * Collapse the schema-derived `(A | B | … | Z)[]` child-union dumps (1.2-1.5KB
 * each, repeated across Card/SectionItem/TabItem/AccordionItem/Carousel/Modal)
 * into the named alias `ContentBlock[]`, with a legend defining it once. Quoted
 * enum alternations ("small" | "default") are untouched — only bare component
 * name unions collapse.
 */
function collapseContentUnions(text: string): string {
  const collapsed = text.replace(/\(([A-Za-z]+( \| [A-Za-z]+){5,})\]/g, "ContentBlock]");
  return collapsed.replace(
    "## Component Signatures\n",
    "## Component Signatures\n\n`ContentBlock` stands for any chat content component (text, callout, image, code, separator, every chart, table, form, buttons, list, tag, entity, steps, inline header, and every card block); `ContentBlock[][]` in Carousel means an array of slides, each an array of content.\n",
  );
}

const EXAMPLES_HEADING = "## Examples";
const EXAMPLES_END_HEADING = "## Important Rules";

/**
 * Core catalog without the worked examples: intro, syntax, all component
 * signatures (unions collapsed), action/streaming rules. Small enough to fit
 * tool-result limits that truncate the full document.
 */
export function buildOpenUIChatReferenceCore(): string {
  // Keep the catalog signatures complete while dropping prose descriptions from
  // the bounded default tool result; the on-demand examples retain the full copy.
  const raw = collapseContentUnions(buildOpenUIChatReference());
  const signatureAt = raw.indexOf("## Component Signatures");
  const examplesAtRaw = raw.indexOf(EXAMPLES_HEADING);
  const full =
    signatureAt >= 0 && examplesAtRaw > signatureAt
      ? raw.slice(0, signatureAt) +
        raw.slice(signatureAt, examplesAtRaw).replace(/\s—[^\n]*/g, "") +
        raw.slice(examplesAtRaw)
      : raw;
  const examplesAt = full.indexOf(EXAMPLES_HEADING);
  const rulesAt = full.indexOf(EXAMPLES_END_HEADING);
  if (examplesAt === -1 || rulesAt === -1 || rulesAt < examplesAt) {
    throw new Error(
      "openui-chat-reference: upstream prompt structure changed (## Examples / ## Important Rules); update the section split in apps/web/src/lib/openUIChatReference.ts",
    );
  }
  const pointer = `${EXAMPLES_HEADING}\nWorked examples (explainer card, analytics dashboard, trip-planner form, recommendations, table with follow-ups) are served separately — call openui_reference again with { "section": "examples" } if you want them.\n\n`;
  return full.slice(0, examplesAt) + pointer + full.slice(rulesAt);
}

/** The worked-examples block, served on demand via { section: "examples" }. */
export function buildOpenUIChatExamples(): string {
  const full = buildOpenUIChatReference();
  const examplesAt = full.indexOf(EXAMPLES_HEADING);
  const rulesAt = full.indexOf(EXAMPLES_END_HEADING);
  if (examplesAt === -1 || rulesAt === -1 || rulesAt < examplesAt) {
    throw new Error(
      "openui-chat-reference: upstream prompt structure changed (## Examples / ## Important Rules); update the section split in apps/web/src/lib/openUIChatReference.ts",
    );
  }
  return full.slice(examplesAt, rulesAt).trimEnd();
}

/** Component names the Moss library exposes — the closed set a program may call. */
export function openUIChatComponentNames(): ReadonlySet<string> {
  return new Set(Object.keys(mossOpenUILibrary.components));
}
