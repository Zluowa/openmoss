// FILE: openUIReferenceTool.ts
// Purpose: The `openui_reference` agent tool — serves Moss's OpenUI chat component
//          catalog (positional signatures, component groups, syntax rules, and
//          curated chat examples) so a model can author first-shot-native `openui`
//          fenced blocks instead of guessing component names and props.
// Layer: Agent gateway tool
// Depends on: openUIChatReference.generated.ts (regenerate from apps/web:
//   bun scripts/generateOpenUIChatReference.ts)

import { Effect } from "effect";

import {
  OPENUI_CHAT_REFERENCE,
  OPENUI_CHAT_REFERENCE_EXAMPLES,
} from "./openUIChatReference.generated.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export const OPENUI_REFERENCE_TOOL_NAME = "openui_reference";

export const OPENUI_REFERENCE_TOOL_DESCRIPTION =
  "Return the single Moss OpenUI Lang 1.0 reference for authoring an `openui` fenced block " +
  "or moss_show_visual source: syntax rules, positional component signatures (each positional signature), working-tool " +
  "$state/@functions guidance, and grouping notes. Call once before authoring your first visual — the catalog is static " +
  "for the session. Use only the components it lists; invented component names do not " +
  'render. Pass { "section": "examples" } for complete worked examples (dashboard, ' +
  "form, cards, table) — the default response omits them to stay within tool-result " +
  "size limits.";

/**
 * The catalog is a static, generated document: no workspace, thread state, or
 * service dependencies, so the tool is callable whenever the caller may read the
 * thread — including before the first turn starts streaming. The worked examples
 * (~21KB) are split out so the default answer stays small enough to survive
 * downstream tool-result truncation; a truncated catalog previously pushed
 * models back to hand-written HTML.
 */
export function makeAgentGatewayOpenUIReferenceTool(): ToolEntry {
  return {
    requiredCapability: "thread:read",
    definition: {
      name: OPENUI_REFERENCE_TOOL_NAME,
      description: OPENUI_REFERENCE_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: ["examples"],
            description:
              'Pass "examples" to fetch the worked examples instead of the core catalog.',
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "OpenUI component reference", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (input) => {
      const section =
        input !== null &&
        typeof input === "object" &&
        (input as { section?: unknown }).section === "examples"
          ? "examples"
          : undefined;
      return Effect.succeed({
        content: [
          {
            type: "text" as const,
            text: section === "examples" ? OPENUI_CHAT_REFERENCE_EXAMPLES : OPENUI_CHAT_REFERENCE,
          },
        ],
      });
    },
  };
}
