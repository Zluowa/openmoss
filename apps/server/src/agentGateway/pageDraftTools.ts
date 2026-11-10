import {
  PAGE_DRAFT_LIMITS,
  PageDraftsListInput,
  PageDraftsMutateInput,
  ThreadId,
} from "@moss/contracts";
import { Effect, Schema } from "effect";

import type { PageDraftsServiceShape } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceError } from "../pages/Services/PagesService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description:
    "Existing project authorization-space id; null is the default local domain. Same value as moss_pages_read.",
};
const body = {
  markdown: {
    type: "string",
    maxLength: PAGE_DRAFT_LIMITS.blockBytes,
    description: "Proposed blocks as Markdown. Give this or richContent.",
  },
  richContent: {
    type: "string",
    maxLength: PAGE_DRAFT_LIMITS.blockBytes,
    description:
      "Proposed blocks as a Plate JSON node array (keeps callouts, tables, columns…). Give this or markdown.",
  },
};
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
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(args),
    catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
  });

/** Agents propose page edits as drafts; the person reviews them in the page and accepts or discards. */
export function makePageDraftTools({
  drafts,
}: {
  readonly drafts: PageDraftsServiceShape;
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
          required: ["scopeSpaceId", "pageId"],
        },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const input = yield* decode(PageDraftsListInput, args);
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
          "Propose changes to an existing page body. This is how you edit a page: the changes are shown to the person as a highlighted draft with Accept / Discard, and nothing changes until they accept. Read the page first (moss_pages_read) and anchor changes to block ids from its richContent (each top-level node's `id`). ops: insert (afterBlockId, or atStart, or neither to append), replace (blockId), delete (blockId), replace-all (only when rewriting the whole page). Follow any 助手说明 (assistant instructions) blocks on the page. requestId is idempotent. Give a short summary of what you changed in the person's language.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string", maxLength: 128 },
            scopeSpaceId: scopeProperty,
            pageId: { type: "string" },
            baseRevision: {
              type: "integer",
              minimum: 1,
              description: "The revision you read.",
            },
            kind: { type: "string", enum: ["text", "image", "visualization"] },
            summary: { type: "string", maxLength: 500 },
            ops: {
              type: "array",
              minItems: 1,
              maxItems: PAGE_DRAFT_LIMITS.ops,
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["insert", "replace", "delete", "replace-all"] },
                  afterBlockId: { type: "string" },
                  atStart: { type: "boolean" },
                  blockId: { type: "string" },
                  ...body,
                },
                required: ["kind"],
              },
            },
          },
          required: ["requestId", "scopeSpaceId", "pageId", "baseRevision", "ops"],
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const input = yield* decode(PageDraftsMutateInput, {
            ...(args && typeof args === "object" ? args : {}),
            op: "create",
          });
          const result = yield* drafts.mutate(input, {
            kind: "agent",
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
          });
          return mcpToolResultJson({
            ...result,
            note: "The draft is waiting for the person to review it in the page. Do not apply it another way.",
          });
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
  ];
}
