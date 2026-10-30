import {
  PagesCommentsInput,
  PagesListInput,
  PagesMutateInput,
  PagesReadInput,
  PagesScopeInput,
  PagesVersionsInput,
  ThreadId,
} from "@synara/contracts";
import { Effect } from "effect";

import { PagesServiceError, type PagesServiceShape } from "../pages/Services/PagesService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";
import { Schema } from "effect";

const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description:
    "Existing project authorization-space id; null is the default local domain. This is not a document-space id.",
};
const nullableId = { anyOf: [{ type: "string" }, { type: "null" }] };
const errorResult = (error: unknown) =>
  error instanceof PagesServiceError
    ? {
        ...mcpToolResultJson({
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentRevision === undefined
              ? {}
              : { currentRevision: error.currentRevision }),
          },
        }),
        isError: true,
      }
    : mcpToolResultError(errorText(error));

/** One catalog for every provider/CLI using the common authenticated gateway. */
export function makePageTools({
  pages,
}: {
  readonly pages: PagesServiceShape;
}): ReadonlyArray<ToolEntry> {
  const readTool = <S extends Schema.Top & { readonly DecodingServices: never }>(
    name: string,
    description: string,
    schema: S,
    fields: Record<string, unknown>,
    required: string[],
    handler: (
      input: S["Type"],
      principal: { kind: "agent"; threadId: ThreadId },
    ) => Effect.Effect<unknown, unknown>,
  ): ToolEntry => ({
    requiredCapability: "thread:read",
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: { scopeSpaceId: scopeProperty, ...fields },
        required: ["scopeSpaceId", ...required],
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(schema)(args),
          catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
        });
        const result = yield* handler(input, {
          kind: "agent",
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
        });
        return mcpToolResultJson(result);
      }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
  });
  return [
    readTool(
      "moss_pages_spaces",
      "List actual local document spaces and their editable root pages. Sharing is local-profile only.",
      PagesScopeInput,
      {},
      [],
      pages.spaces,
    ),
    readTool(
      "moss_pages_list",
      "List Personal pages and document-space page trees in the caller's authorization domain.",
      PagesListInput,
      { includeTrashed: { type: "boolean" } },
      [],
      pages.list,
    ),
    readTool(
      "moss_pages_read",
      "Read a persisted page body and revision. If richContent exists, it is the canonical Plate JSON; content is only its readable Markdown projection. Preserve the rich structure when editing, or explicitly convert to Markdown. Use the revision for conflict-safe edits.",
      PagesReadInput,
      { pageId: { type: "string" }, revision: { type: "integer", minimum: 1 } },
      ["pageId"],
      pages.read,
    ),
    readTool(
      "moss_pages_versions",
      "Read durable page versions. Restoring a version restores title/body, preserving current placement and automation links.",
      PagesVersionsInput,
      {
        pageId: { type: "string" },
        beforeRevision: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["pageId"],
      pages.versions,
    ),
    readTool(
      "moss_pages_comments",
      "Read a page's persisted comments with server-derived authorship.",
      PagesCommentsInput,
      { pageId: { type: "string" } },
      ["pageId"],
      pages.comments,
    ),
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "moss_pages_mutate",
        description:
          "Create a real page/document space, edit, move, pin, trash/restore, comment, or restore a version. requestId is idempotent. Existing-page actions require the last read expectedRevision. spaceId identifies a document space (null Personal); scopeSpaceId is the caller's project authorization domain. Attaching an existing automation never creates/enables/runs it. The caller cannot spoof owner/author or cross authorization spaces.",
        inputSchema: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "create-space",
                "create",
                "update",
                "move",
                "pin",
                "trash",
                "restore",
                "trash-space",
                "restore-space",
                "restore-version",
                "comment",
              ],
            },
            requestId: { type: "string", maxLength: 128 },
            scopeSpaceId: scopeProperty,
            pageId: { type: "string" },
            expectedRevision: { type: "integer", minimum: 1 },
            title: { type: "string", maxLength: 256 },
            content: { type: "string", maxLength: 2_000_000 },
            richContent: {
              anyOf: [{ type: "string", maxLength: 2_000_000 }, { type: "null" }],
              description:
                "Canonical Plate JSON node array, including empty arrays. String sets rich mode and server derives content projection. Omit to preserve mode; null explicitly converts to plain Markdown. Existing rich pages reject content-only edits. Known link/media URLs must be durable HTTP(S) or relative paths (mailto is link-only), without credentials or control characters; temporary blob/data/file URLs are rejected. Preserve unknown legal node structure.",
            },
            spaceId: nullableId,
            parentPageId: nullableId,
            sourceThreadId: nullableId,
            assetIds: { type: "array", items: { type: "string" }, maxItems: 256 },
            automationIds: { type: "array", items: { type: "string" }, maxItems: 256 },
            pinned: { type: "boolean" },
            revision: { type: "integer", minimum: 1 },
          },
          required: ["op", "requestId", "scopeSpaceId"],
          allOf: [
            {
              if: { properties: { op: { enum: ["create-space", "create"] } } },
              then: { required: ["title"] },
              else: { required: ["pageId", "expectedRevision"] },
            },
            {
              if: { properties: { op: { enum: ["create", "move"] } } },
              then: { required: ["spaceId", "parentPageId"] },
            },
            { if: { properties: { op: { const: "comment" } } }, then: { required: ["content"] } },
            { if: { properties: { op: { const: "pin" } } }, then: { required: ["pinned"] } },
            {
              if: { properties: { op: { const: "restore-version" } } },
              then: { required: ["revision"] },
            },
          ],
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          // This also protects direct dispatch; the shared gateway independently
          // applies capability, active-turn, approval and audit policies.
          yield* context.assertCallerTurnActive();
          const input = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(PagesMutateInput)(args),
            catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
          });
          const result = yield* pages.mutate(input, {
            kind: "agent",
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
          });
          return mcpToolResultJson(result);
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
  ];
}
