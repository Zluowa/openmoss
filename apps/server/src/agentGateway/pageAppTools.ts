// FILE: pageAppTools.ts
// Purpose: Agent tools for 应用页: read the author guide, list/read pages,
// publish or update a page with declared capabilities, and read/write its db.
// Agents act for the owner; the gateway's own approval/audit applies.
// Layer: Server agent gateway

import {
  PageAppId,
  PageAppsMutateInput,
  ThreadId,
  type PageAppCapabilities,
} from "@moss/contracts";
import { Effect, Schema } from "effect";

import {
  LOCAL_OWNER_VIEWER,
  PageAppsServiceError,
  type PageAppsServiceShape,
} from "../pages/apps/PageAppsService";
import { PAGE_APP_AUTHOR_GUIDE } from "./pageAppAuthorGuide";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

const scopeProperty = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description: "Existing project authorization-space id; null is the default local domain.",
};

const errorResult = (error: unknown) =>
  error instanceof PageAppsServiceError
    ? {
        ...mcpToolResultJson({ error: { code: error.code, message: error.message } }),
        isError: true,
      }
    : mcpToolResultError(errorText(error));

const record = (args: unknown): Record<string, unknown> =>
  args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

const DbArgs = Schema.Struct({
  appId: PageAppId,
  op: Schema.Literals(["get", "set", "update", "delete", "query"]),
  path: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  query: Schema.optional(Schema.Unknown),
});

export function makePageAppTools({
  apps,
}: {
  readonly apps: PageAppsServiceShape;
}): ReadonlyArray<ToolEntry> {
  const agent = (threadId: string) => ({
    kind: "agent" as const,
    threadId: ThreadId.makeUnsafe(threadId),
  });
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
  ) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(value),
      catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
    });
  const summary = (app: {
    id: string;
    title: string;
    revision: number;
    capabilities: PageAppCapabilities;
  }) => ({
    appId: app.id,
    title: app.title,
    revision: app.revision,
    capabilities: Object.keys(app.capabilities),
    link: `/apps/${app.id}`,
  });

  return [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "moss_app_guide",
        description:
          "Read before writing your first 应用页 (runnable HTML page kept in the user's 资料空间): the sandbox rules and the moss.use() runtime API (db, ai, downloads, user, permissions, page).",
        inputSchema: { type: "object", properties: {} },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: () =>
        Effect.succeed({ content: [{ type: "text" as const, text: PAGE_APP_AUTHOR_GUIDE }] }),
    },
    {
      requiredCapability: "thread:read",
      definition: {
        name: "moss_app_list",
        description:
          "List the user's 应用页 (runnable pages) in the caller's authorization domain.",
        inputSchema: {
          type: "object",
          properties: { scopeSpaceId: scopeProperty, includeTrashed: { type: "boolean" } },
          required: ["scopeSpaceId"],
        },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        apps.list(record(args) as never, agent(context.callerThreadId)).pipe(
          Effect.map((result) => mcpToolResultJson({ apps: result.apps.map(summary) })),
          Effect.catch((error) => Effect.succeed(errorResult(error))),
        ),
    },
    {
      requiredCapability: "thread:read",
      definition: {
        name: "moss_app_read",
        description:
          "Read an 应用页's HTML, declared capabilities and revision. Use the revision as expectedRevision when updating it.",
        inputSchema: {
          type: "object",
          properties: { appId: { type: "string" }, revision: { type: "integer", minimum: 1 } },
          required: ["appId"],
        },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        apps.read(record(args) as never, agent(context.callerThreadId)).pipe(
          Effect.map((result) =>
            mcpToolResultJson({
              ...summary(result.app),
              revision: result.revision,
              html: result.html,
              capabilities: result.capabilities,
            }),
          ),
          Effect.catch((error) => Effect.succeed(errorResult(error))),
        ),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "moss_app_publish",
        description:
          "Publish a runnable HTML page as an 应用页 in the user's 资料空间, or a new version of one (pass appId + expectedRevision). Declare every capability the page calls through moss.use(); undeclared ones resolve null. Call moss_app_guide first. requestId is idempotent.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string", maxLength: 128 },
            scopeSpaceId: scopeProperty,
            appId: { type: "string", description: "Omit to create a new 应用页." },
            expectedRevision: { type: "integer", minimum: 1 },
            html: {
              type: "string",
              maxLength: 2_000_000,
              description: "One complete <!doctype html> document.",
            },
            title: { type: "string", maxLength: 256 },
            description: { type: "string", maxLength: 2_000 },
            capabilities: {
              type: "object",
              description:
                'Keys among db, ai, downloads, user, page; values are each capability\'s config, {} for none. db may carry {"rules":[...]}.',
              additionalProperties: { type: "object" },
            },
            spaceId: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "Document space; null or omitted is 个人.",
            },
          },
          required: ["requestId", "scopeSpaceId", "html"],
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const input = record(args);
          const mutation =
            typeof input.appId === "string"
              ? {
                  op: "update",
                  requestId: input.requestId,
                  appId: input.appId,
                  expectedRevision: input.expectedRevision,
                  html: input.html,
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.description === undefined ? {} : { description: input.description }),
                  ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
                }
              : {
                  op: "create",
                  requestId: input.requestId,
                  scopeSpaceId: input.scopeSpaceId ?? null,
                  html: input.html,
                  sourceThreadId: context.callerThreadId,
                  ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.description === undefined ? {} : { description: input.description }),
                  ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
                };
          const decoded = yield* decode(PageAppsMutateInput, mutation);
          const result = yield* apps.mutate(decoded, agent(context.callerThreadId));
          return mcpToolResultJson(summary(result.app));
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "moss_app_db",
        description:
          "Read or write an 应用页's db as its owner (seed data, inspect what viewers saved, fix records). The page must declare db. op get/delete need a document path (collection/doc); set/update need path + data; query needs query {collection, where?:[{field,op,value}], orderBy?:{field,dir}, limit?}.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string" },
            op: { type: "string", enum: ["get", "set", "update", "delete", "query"] },
            path: { type: "string" },
            data: { type: "object" },
            query: { type: "object" },
          },
          required: ["appId", "op"],
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          yield* context.assertCallerTurnActive();
          const input = yield* decode(DbArgs, args);
          const principal = agent(context.callerThreadId);
          const current = yield* apps.read({ appId: input.appId }, principal);
          const result = yield* apps.call(
            {
              appId: input.appId,
              revision: current.revision,
              capability: "db",
              method: input.op,
              args: input.op === "query" ? input.query : { path: input.path, data: input.data },
            },
            principal,
            LOCAL_OWNER_VIEWER,
          );
          return mcpToolResultJson({ result: result.value });
        }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
    },
  ];
}
