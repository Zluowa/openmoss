import {
  PagesCommentsInput,
  PagesListInput,
  PagesMutateInput,
  PagesReadInput,
  PagesScopeInput,
  PagesVersionsInput,
  ThreadId,
} from "@moss/contracts";
import { Effect } from "effect";

import { pageAssistantInstructions } from "@moss/shared/pageAi";
import { parsePageRichContent } from "@moss/shared/pageRichContent";

import type { PageDraftsServiceShape } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceError, type PagesServiceShape } from "../pages/Services/PagesService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";
import { Schema } from "effect";

// Everything a model can leave out is optional in the advertised schema: some
// clients validate arguments against it before Moss sees the call, so a
// required-but-defaultable field fails there with no way to recover.
const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description:
    "Optional. Omit (or null) for the default local domain. A project authorization-space id, not a document-space id.",
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

const MUTATION_OPS = new Set([
  "update",
  "move",
  "pin",
  "trash",
  "restore",
  "trash-space",
  "restore-space",
  "restore-version",
  "comment",
]);

function withDefaultScope(args: Record<string, unknown>): Record<string, unknown> {
  return args.scopeSpaceId === undefined ? { ...args, scopeSpaceId: null } : args;
}

/**
 * A page with no placement goes to Personal, under the named space's root, or
 * beside its parent in the parent's own space.
 */
function placement(args: Record<string, unknown>): {
  readonly args: Record<string, unknown>;
  readonly spaceFromParent?: string;
} {
  if (args.parentPageId === undefined) args.parentPageId = null;
  if (args.spaceId !== undefined) return { args };
  if (typeof args.parentPageId === "string") return { args, spaceFromParent: args.parentPageId };
  args.spaceId = null;
  return { args };
}

/**
 * Fill what a model may reasonably leave out and accept the obvious alias, so
 * a sensible call succeeds the first time. What cannot be inferred gets a
 * one-line hint naming the field and how to get it.
 */
export function normalizePagesMutateArgs(raw: Record<string, unknown>):
  | {
      readonly args: Record<string, unknown>;
      /** spaceId was left out beside a parentPageId: take the parent's space. */
      readonly spaceFromParent?: string;
    }
  | { readonly hint: string } {
  const args: Record<string, unknown> = withDefaultScope(raw);
  const op = args.op;
  if (typeof op !== "string")
    return {
      hint: 'op is required: "create-space", "create", "update", "move", "pin", "trash", "restore", "trash-space", "restore-space", "restore-version" or "comment".',
    };
  if (typeof args.requestId !== "string" || !args.requestId.trim())
    return { hint: "requestId is required: any unique string for this change, reused on retry." };
  if (op === "create-space" || op === "create") {
    if (typeof args.title !== "string" || !args.title.trim())
      return { hint: `title is required for op=${op}.` };
    if (op === "create") return placement(args);
    return { args };
  }
  if (!MUTATION_OPS.has(op)) return { hint: `Unknown op "${op}".` };
  if (typeof args.pageId !== "string" || !args.pageId.trim())
    return {
      hint: `pageId is required for op=${op}: list pages with moss_pages_list or moss_pages_spaces.`,
    };
  // `revision` is the page's current revision everywhere except restore-version,
  // where it names the version to restore.
  if (
    args.expectedRevision === undefined &&
    op !== "restore-version" &&
    args.revision !== undefined
  ) {
    const { revision, ...rest } = args;
    return normalizePagesMutateArgs({ ...rest, expectedRevision: revision });
  }
  if (args.expectedRevision === undefined)
    return {
      hint: `expectedRevision is required for op=${op}: pass the page's current revision from moss_pages_read.`,
    };
  if (op === "move" && args.spaceId === undefined && args.parentPageId === undefined)
    return {
      hint: "op=move needs a destination: spaceId (null for Personal) and/or parentPageId.",
    };
  if (op === "move") {
    const placed = placement(args);
    if ("spaceFromParent" in placed) return placed;
  }
  if (op === "pin" && typeof args.pinned !== "boolean")
    return { hint: "pinned (true or false) is required for op=pin." };
  if (op === "comment" && (typeof args.content !== "string" || !args.content.trim()))
    return { hint: "content (the comment text) is required for op=comment." };
  if (op === "restore-version" && args.revision === undefined)
    return { hint: "revision (the version to restore, from moss_pages_versions) is required." };
  return { args };
}

/** One catalog for every provider/CLI using the common authenticated gateway. */
export function makePageTools({
  pages,
  drafts,
}: {
  readonly pages: PagesServiceShape;
  /** When present, an agent's body edit to an existing page becomes a reviewable draft. */
  readonly drafts?: PageDraftsServiceShape | undefined;
}): ReadonlyArray<ToolEntry> {
  // 助手说明 blocks are standing instructions for agents; surface them beside the body.
  const readWithInstructions: PagesServiceShape["read"] = (input, principal) =>
    pages.read(input, principal).pipe(
      Effect.map((result) => {
        if (result.richContent === undefined) return result;
        try {
          const instructions = pageAssistantInstructions(
            parsePageRichContent(result.richContent).nodes,
          );
          return instructions.length ? { ...result, assistantInstructions: instructions } : result;
        } catch {
          return result;
        }
      }),
    );
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
        ...(required.length ? { required } : {}),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(schema)(withDefaultScope(args)),
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
      "List the local document spaces (资料空间) and their editable root pages. Document spaces hold pages of text; they are not Moss Canvas (画布), which is opened with moss_canvas_open. Sharing is local-profile only.",
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
      "Read a persisted page body and revision. assistantInstructions, when present, are the page owner's standing instructions for agents: follow them. If richContent exists, it is the canonical Plate JSON; content is only its readable Markdown projection. Preserve the rich structure when editing, or explicitly convert to Markdown. Use the revision for conflict-safe edits.",
      PagesReadInput,
      { pageId: { type: "string" }, revision: { type: "integer", minimum: 1 } },
      ["pageId"],
      readWithInstructions,
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
          "Create a document space (资料空间) or page, edit, move, pin, trash/restore, comment, or restore a version. Pages are text documents, not Moss Canvas (画布). requestId is idempotent. create-space and create need title; create without spaceId/parentPageId makes a Personal page, with spaceId alone it goes under that space's root page. Every other op needs pageId and expectedRevision (the page's current revision from moss_pages_read). Attaching an existing automation never creates/enables/runs it. The caller cannot spoof owner/author or cross authorization spaces. spaceId identifies a document space (null Personal); scopeSpaceId is the caller's project authorization domain. Body edits (content/richContent) from an agent become a draft the person accepts; title and metadata apply directly.",
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
            requestId: {
              type: "string",
              maxLength: 128,
              description: "Unique id for this change; reuse it when retrying the same change.",
            },
            scopeSpaceId: scopeProperty,
            pageId: {
              type: "string",
              description: "Required for every op except create/create-space.",
            },
            expectedRevision: {
              type: "integer",
              minimum: 1,
              description:
                "The page's current revision from moss_pages_read. Required for every op except create/create-space.",
            },
            title: {
              type: "string",
              maxLength: 256,
              description: "Required for create/create-space.",
            },
            content: { type: "string", maxLength: 2_000_000 },
            richContent: {
              anyOf: [{ type: "string", maxLength: 2_000_000 }, { type: "null" }],
              description:
                "Canonical Plate JSON node array, including empty arrays. String sets rich mode and server derives content projection. Omit to preserve mode; null explicitly converts to plain Markdown. Existing rich pages reject content-only edits. Known link/media URLs must be durable HTTP(S) or relative paths (mailto is link-only), without credentials or control characters; temporary blob/data/file URLs are rejected. Preserve unknown legal node structure.",
            },
            spaceId: {
              ...nullableId,
              description: "Document space for create/move; omit or null for Personal.",
            },
            parentPageId: {
              ...nullableId,
              description: "Parent page for create/move; omit for the space's root.",
            },
            sourceThreadId: nullableId,
            assetIds: { type: "array", items: { type: "string" }, maxItems: 256 },
            automationIds: { type: "array", items: { type: "string" }, maxItems: 256 },
            pinned: { type: "boolean", description: "Required for op=pin." },
            revision: {
              type: "integer",
              minimum: 1,
              description: "The version to restore, for op=restore-version.",
            },
          },
          required: ["op", "requestId"],
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          // This also protects direct dispatch; the shared gateway independently
          // applies capability, active-turn, approval and audit policies.
          yield* context.assertCallerTurnActive();
          const normalized = normalizePagesMutateArgs(args);
          if ("hint" in normalized) return yield* Effect.fail(new ToolInputError(normalized.hint));
          const principal = {
            kind: "agent" as const,
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
          };
          const parentRead = normalized.spaceFromParent
            ? yield* Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(PagesReadInput)({
                    scopeSpaceId: normalized.args.scopeSpaceId,
                    pageId: normalized.spaceFromParent,
                  }),
                catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
              })
            : null;
          const resolved = parentRead
            ? {
                ...normalized.args,
                spaceId: (yield* pages.read(parentRead, principal)).page.spaceId,
              }
            : normalized.args;
          const input = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(PagesMutateInput)(resolved),
            catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
          });
          if (
            drafts &&
            input.op === "update" &&
            (input.content !== undefined || input.richContent !== undefined)
          ) {
            // Agent body edits are never applied silently: they become a draft the person
            // accepts or discards in the page. Title and metadata still apply directly.
            const { content, richContent, ...rest } = input;
            const draft = yield* drafts.mutate(
              {
                op: "create",
                requestId: `mutate:${input.requestId}`,
                scopeSpaceId: input.scopeSpaceId,
                pageId: input.pageId,
                baseRevision: input.expectedRevision,
                summary: "整页修改",
                ops: [
                  typeof richContent === "string"
                    ? { kind: "replace-all", richContent }
                    : { kind: "replace-all", markdown: content ?? "" },
                ],
              },
              principal,
            );
            const metadataChanged = Object.keys(rest).some(
              (field) =>
                !["op", "requestId", "scopeSpaceId", "pageId", "expectedRevision"].includes(field),
            );
            const result = metadataChanged ? yield* pages.mutate(rest, principal) : undefined;
            return mcpToolResultJson({
              ...(result ?? {}),
              drafts: draft.drafts,
              note: "Body changes were saved as a draft for the person to review; the page body is unchanged until they accept. Prefer moss_pages_draft for targeted edits.",
            });
          }
          const result = yield* pages.mutate(input, principal);
          return mcpToolResultJson(result);
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
  ];
}
