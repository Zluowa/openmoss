import { createHash } from "node:crypto";

import {
  PAGE_DRAFT_LIMITS,
  PageDraftsListInput,
  PageDraftsMutateInput,
  ThreadId,
} from "@moss/contracts";
import { Effect, Schema } from "effect";

import type { PageDraftsServiceShape } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceError, type PagesServiceShape } from "../pages/Services/PagesService";
import { parsePageRichContent } from "@moss/shared/pageRichContent";

import { normalizePageDraftArgs } from "./pageDraftInput";
import { resolveTextReplacements } from "./pageTextEdits";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description: "Optional; omit for the default local domain. Same value as moss_pages_read.",
};
// Clients check arguments against this schema before Moss sees them, so it accepts every shape
// the server repairs (pageDraftInput.ts), not only the canonical one.
const body = {
  markdown: {
    type: "string",
    maxLength: PAGE_DRAFT_LIMITS.blockBytes,
    description: "Proposed blocks as Markdown. Give this or richContent.",
  },
  richContent: {
    anyOf: [{ type: "array", items: { type: "object" } }, { type: "object" }, { type: "string" }],
    description:
      "Proposed blocks as Plate nodes (keeps callouts, tables, columns…). Send the array itself, not an escaped string. Give this or markdown.",
  },
};
const RESEND_HINT =
  'Resend one call with pageId, baseRevision and ops, e.g. "ops": [{"kind":"replace","blockId":"<id>","richContent":[{"type":"p","children":[{"text":"…"}]}]}] (richContent as an array, not a string), or markdown text instead of richContent.';
const errorResult = (error: unknown) =>
  error instanceof PagesServiceError
    ? {
        ...mcpToolResultJson({ error: { code: error.code, message: error.message } }),
        isError: true,
      }
    : mcpToolResultError(errorText(error));
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  args: unknown,
  hint = "",
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(args),
    catch: (error) =>
      new ToolInputError(`Invalid tool input: ${errorText(error)}${hint ? ` ${hint}` : ""}`),
  });

/** Agents propose page edits as drafts; the person reviews them in the page and accepts or discards. */
export function makePageDraftTools({
  drafts,
  pages,
}: {
  readonly drafts: PageDraftsServiceShape;
  /** Fills a baseRevision the model left out with the page's current revision. */
  readonly pages?: PagesServiceShape | undefined;
}): ReadonlyArray<ToolEntry> {
  return [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "moss_pages_drafts",
        description:
          "List a page's unreviewed drafts (yours and others'), so you do not propose the same change twice.",
        inputSchema: {
          type: "object",
          properties: {
            scopeSpaceId: scopeProperty,
            pageId: { type: "string" },
            includeResolved: { type: "boolean" },
          },
          required: ["pageId"],
        },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const input = yield* decode(PageDraftsListInput, {
            scopeSpaceId: null,
            ...(args && typeof args === "object" ? args : {}),
          });
          const result = yield* drafts.list(input, {
            kind: "agent",
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
          });
          return mcpToolResultJson(result);
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "moss_pages_draft",
        description:
          "Propose changes to an existing page body. This is how you edit a page: the changes are shown to the person as a highlighted draft with Accept / Discard, and nothing changes until they accept. Read the page first (moss_pages_read) and anchor changes to block ids from its richContent (each top-level node's `id`), or read moss_pages_outline for just the ids. ops: insert (afterBlockId, or atStart, or neither to append), replace (blockId), delete (blockId), replace-text (find: words quoted exactly as they stand, replacement: the new words, blockId and nth optional; formatting around them is kept — the cheapest way to fix a word, a number or a sentence), replace-all (only when rewriting the whole page). Send richContent as a JSON array of nodes, never as an escaped string. To put a chart into a 可视化 block use moss_app_visualize instead (one call does it). Follow any 助手说明 (assistant instructions) blocks on the page. Give a short summary of what you changed in the person's language.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: {
              type: "string",
              maxLength: 128,
              description: "Optional; reuse it when retrying the same change.",
            },
            scopeSpaceId: scopeProperty,
            pageId: { type: "string" },
            baseRevision: {
              type: "integer",
              minimum: 1,
              description: "The revision you read (moss_pages_read).",
            },
            kind: { type: "string", enum: ["text", "image", "visualization"] },
            summary: { type: "string", maxLength: 500 },
            ops: {
              anyOf: [
                {
                  type: "array",
                  minItems: 1,
                  maxItems: PAGE_DRAFT_LIMITS.ops,
                  items: {
                    type: "object",
                    properties: {
                      kind: {
                        type: "string",
                        enum: ["insert", "replace", "delete", "replace-text", "replace-all"],
                      },
                      afterBlockId: { type: "string" },
                      atStart: { type: "boolean" },
                      blockId: { type: "string" },
                      find: { type: "string", description: "replace-text: the words to change." },
                      replacement: {
                        type: "string",
                        description: 'replace-text: what replaces them ("" deletes them).',
                      },
                      nth: {
                        type: "integer",
                        minimum: 1,
                        description: "replace-text with blockId: which occurrence (default 1).",
                      },
                      ...body,
                    },
                    required: ["kind"],
                  },
                },
                { type: "string" },
              ],
            },
          },
          required: ["pageId", "ops"],
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const normalized = normalizePageDraftArgs(args);
          if ("hint" in normalized)
            return yield* Effect.fail(new ToolInputError(`${normalized.hint} ${RESEND_HINT}`));
          const fields = normalized.args;
          const principal = {
            kind: "agent" as const,
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
          };
          const ops = fields.ops as Record<string, unknown>[];
          if (ops.some((op) => op.kind === "replace-text")) {
            if (!pages)
              return yield* Effect.fail(
                new ToolInputError("replace-text needs the page; send replace ops instead."),
              );
            const read = yield* pages.read(
              {
                scopeSpaceId: fields.scopeSpaceId as never,
                pageId: fields.pageId as never,
              },
              principal,
            );
            const nodes = read.richContent ? parsePageRichContent(read.richContent).nodes : [];
            const resolved = resolveTextReplacements(ops, nodes);
            if ("hint" in resolved)
              return yield* Effect.fail(new ToolInputError(`${resolved.hint} ${RESEND_HINT}`));
            fields.ops = resolved.ops;
            fields.baseRevision ??= read.page.revision;
          }
          if (fields.baseRevision === undefined) {
            if (!pages)
              return yield* Effect.fail(
                new ToolInputError("baseRevision is required: the revision from moss_pages_read."),
              );
            const read = yield* pages.read(
              {
                scopeSpaceId: fields.scopeSpaceId as never,
                pageId: fields.pageId as never,
              },
              principal,
            );
            fields.baseRevision = read.page.revision;
          }
          if (typeof fields.requestId !== "string" || !fields.requestId.trim())
            fields.requestId = `draft:${createHash("sha256")
              .update(JSON.stringify([fields.pageId, fields.baseRevision, fields.ops]))
              .digest("hex")
              .slice(0, 32)}`;
          const input = yield* decode(
            PageDraftsMutateInput,
            { ...fields, op: "create" },
            RESEND_HINT,
          );
          const result = yield* drafts.mutate(input, principal);
          const trimmed =
            input.op === "create" &&
            result.drafts.some((draft) => draft.outdated || draft.ops.length < input.ops.length);
          return mcpToolResultJson({
            ...result,
            note: trimmed
              ? "The person changed part of the page after you read it, so the changes that touched those blocks were left out. The rest waits for review in the page."
              : "The draft is waiting for the person to review it in the page. Do not apply it another way.",
          });
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
  ];
}
