// FILE: pageTypeTools.ts
// Purpose: Agent tools for typed 资料空间 items: list/choose templates, create an item,
//          read it, edit slides, and read/write spreadsheet ranges.
// Layer: Agent gateway tool catalog (beside pageTools.ts)

import { PageId, ThreadId, type SpaceId } from "@moss/contracts";
import {
  readSheetRange,
  writeSheetRange,
  parseSheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";
import { parseAppItem } from "@moss/shared/spaceItems/itemData";
import { findBuiltInTemplate } from "@moss/shared/spaceItems/templates";
import { Effect } from "effect";

import type { PageAppsServiceShape } from "../pages/apps/PageAppsService";
import { PagesServiceError } from "../pages/Services/PagesService";
import type { PageTypesServiceShape } from "../pages/types/PageTypesService";
import { mcpToolResultError, mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

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

type Args = Record<string, unknown>;
const field = {
  string(args: Args, name: string, optional = false): string | undefined {
    const value = args[name];
    if (value === undefined && optional) return undefined;
    if (typeof value !== "string" || !value.trim())
      throw new ToolInputError(`${name} must be a non-empty string`);
    return value;
  },
  scope(args: Args): SpaceId | null {
    const value = args.scopeSpaceId;
    if (value === null || value === undefined) return null;
    if (typeof value !== "string")
      throw new ToolInputError("scopeSpaceId must be a string or null");
    return value as SpaceId;
  },
  revision(args: Args): number {
    const value = args.expectedRevision;
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new ToolInputError("expectedRevision must be the revision from the last read");
    }
    return value as number;
  },
};
const parseInput = <A>(build: () => A) =>
  Effect.try({
    try: build,
    catch: (error) =>
      error instanceof ToolInputError ? error : new ToolInputError(errorText(error)),
  });

/** One catalog for every provider/CLI using the common authenticated gateway. */
export function makePageTypeTools({
  types,
  apps,
}: {
  readonly types: PageTypesServiceShape;
  /** apps-runtime's service; app items are then created as real 应用页. */
  readonly apps?: PageAppsServiceShape;
}): ReadonlyArray<ToolEntry> {
  const appTemplate = (id: string) => {
    const data = findBuiltInTemplate(id)?.data;
    return data && findBuiltInTemplate(id)?.kind === "app" ? parseAppItem(data) : null;
  };
  const principal = (callerThreadId: string) => ({
    kind: "agent" as const,
    threadId: ThreadId.makeUnsafe(callerThreadId),
  });
  const read = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: Args, threadId: string) => Effect.Effect<unknown, unknown>,
  ): ToolEntry => ({
    requiredCapability: "thread:read",
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: { scopeSpaceId: scopeProperty, ...properties },
        required: ["scopeSpaceId", ...required],
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handler: (args, context) =>
      handler(args as Args, context.callerThreadId).pipe(
        Effect.map(mcpToolResultJson),
        Effect.catch((error) => Effect.succeed(errorResult(error))),
      ),
  });
  const write = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: Args, threadId: string) => Effect.Effect<unknown, unknown>,
  ): ToolEntry => ({
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 128 },
          scopeSpaceId: scopeProperty,
          ...properties,
        },
        required: ["requestId", "scopeSpaceId", ...required],
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        // Direct dispatch is protected too; the gateway applies capability and approval policy.
        yield* context.assertCallerTurnActive();
        return mcpToolResultJson(yield* handler(args as Args, context.callerThreadId));
      }).pipe(Effect.catch((error) => Effect.succeed(errorResult(error)))),
  });

  /** Reads a typed item, then saves `next(data)` against the revision the caller last read. */
  const edit = (
    args: Args,
    threadId: string,
    kind: "slides" | "sheet",
    next: (data: string) => { data: string; extra?: object },
  ) =>
    Effect.gen(function* () {
      const input = yield* parseInput(() => ({
        requestId: field.string(args, "requestId")!,
        scopeSpaceId: field.scope(args),
        pageId: PageId.makeUnsafe(field.string(args, "pageId")!),
        expectedRevision: field.revision(args),
      }));
      const current = yield* types.read(
        { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
        principal(threadId),
      );
      if (current.kind !== kind || current.data === null) {
        return yield* Effect.fail(
          new ToolInputError(`This item is a ${current.kind}, not a ${kind}`),
        );
      }
      if (current.page.revision !== input.expectedRevision) {
        return yield* Effect.fail(
          new PagesServiceError({
            code: "conflict",
            message: "The item changed since it was read; read it again and retry",
            currentRevision: current.page.revision,
          }),
        );
      }
      const changed = yield* parseInput(() => next(current.data!));
      const saved = yield* types.save({ ...input, data: changed.data }, principal(threadId));
      return { pageId: saved.page.id, revision: saved.page.revision, ...changed.extra };
    });

  return [
    read(
      "moss_space_templates",
      "List 从模板开始 templates (built-in Moss templates and the user's saved ones) for creating a page, slides deck, spreadsheet or app page (dashboards, trackers, polls). Pass the chosen id to moss_space_create_item.",
      { kind: { type: "string", enum: ["page", "slides", "sheet", "app"] } },
      [],
      (args, threadId) =>
        Effect.gen(function* () {
          const kind = args.kind as "page" | "slides" | "sheet" | "app" | undefined;
          return yield* types.listTemplates(
            { scopeSpaceId: field.scope(args), ...(kind ? { kind } : {}) },
            principal(threadId),
          );
        }),
    ),
    write(
      "moss_space_create_item",
      "Create a 资料空间 item: page, slides (16:9 deck), sheet (spreadsheet), board (whiteboard) or app (runnable app page). For slides decks use moss_slides_create (outlines, templates, themes, .pptx import; read moss_slides_guide). Optionally start from templateId (see moss_space_templates) or pass data: sheet = {version:1,sheets:[{id,name,cells:[{r,c,v,f?}]}]}; app = {version:1,html,capabilities:['db'|'ai'|'downloads'|'user'|'permissions']}. requestId is idempotent.",
      {
        kind: { type: "string", enum: ["page", "slides", "sheet", "board", "app"] },
        title: { type: "string", maxLength: 256 },
        spaceId: { ...nullableId, description: "Document space id, or null for Personal." },
        parentPageId: nullableId,
        templateId: { type: "string" },
        data: {
          type: "string",
          maxLength: 2_000_000,
          description: "Item JSON for the kind (not for page).",
        },
      },
      ["kind", "title", "spaceId", "parentPageId"],
      (args, threadId) =>
        Effect.gen(function* () {
          const templateId = field.string(args, "templateId", true);
          const data = typeof args.data === "string" ? args.data : undefined;
          // Dashboards and other app pages are real 应用页 (apps-runtime) when the build has them.
          const appSource =
            args.kind === "app" && apps
              ? data
                ? yield* parseInput(() => parseAppItem(data))
                : templateId
                  ? appTemplate(templateId)
                  : null
              : null;
          if (appSource && apps) {
            const result = yield* apps.mutate(
              {
                op: "create",
                requestId: field.string(args, "requestId")!,
                scopeSpaceId: field.scope(args),
                spaceId: (args.spaceId ?? null) as never,
                title: field.string(args, "title")!,
                html: appSource.html,
                capabilities: Object.fromEntries(appSource.capabilities.map((name) => [name, {}])),
                sourceThreadId: ThreadId.makeUnsafe(threadId),
              },
              principal(threadId),
            );
            return {
              appId: result.app.id,
              kind: "app",
              revision: result.app.revision,
              title: result.app.title,
            };
          }
          const created = yield* types.create(
            {
              requestId: field.string(args, "requestId")!,
              scopeSpaceId: field.scope(args),
              kind: args.kind as "page" | "slides" | "sheet" | "board" | "app",
              title: field.string(args, "title")!,
              spaceId: (args.spaceId ?? null) as never,
              parentPageId: (args.parentPageId ?? null) as never,
              ...(templateId ? { templateId } : {}),
              ...(data ? { data } : {}),
            },
            principal(threadId),
          );
          return {
            pageId: created.page.id,
            kind: created.kind,
            revision: created.page.revision,
            title: created.page.title,
          };
        }),
    ),
    read(
      "moss_space_item_read",
      "Read a typed 资料空间 item (slides, sheet, board, app) with its revision and full JSON payload. For a large spreadsheet prefer moss_sheet_read_range.",
      { pageId: { type: "string" } },
      ["pageId"],
      (args, threadId) =>
        types.read(
          {
            scopeSpaceId: field.scope(args),
            pageId: PageId.makeUnsafe(field.string(args, "pageId")!),
          },
          principal(threadId),
        ),
    ),
    read(
      "moss_sheet_read_range",
      "Read a spreadsheet range in A1 notation (e.g. A1:D20; omit for the used area) from a sheet item. Returns values (cached results for formulas) and formulas in the same 2-D shape, plus the sheet names.",
      { pageId: { type: "string" }, sheet: { type: "string" }, range: { type: "string" } },
      ["pageId"],
      (args, threadId) =>
        Effect.gen(function* () {
          const item = yield* types.read(
            {
              scopeSpaceId: field.scope(args),
              pageId: PageId.makeUnsafe(field.string(args, "pageId")!),
            },
            principal(threadId),
          );
          if (item.kind !== "sheet" || item.data === null) {
            return yield* Effect.fail(
              new ToolInputError(`This item is a ${item.kind}, not a sheet`),
            );
          }
          const workbook = yield* parseInput(() => parseSheetWorkbook(item.data!));
          const result = yield* parseInput(() =>
            readSheetRange(
              workbook,
              field.string(args, "sheet", true),
              field.string(args, "range", true),
            ),
          );
          return {
            revision: item.page.revision,
            sheets: workbook.sheets.map((sheet) => sheet.name),
            ...result,
          };
        }),
    ),
    write(
      "moss_sheet_write_range",
      "Write a 2-D block of values into a sheet item starting at the top-left cell `start` (A1). Strings beginning with = are formulas (e.g. =SUM(B2:B9)); null clears a cell. Formula results are recalculated when the sheet is next opened. Requires expectedRevision from the last read.",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        sheet: { type: "string" },
        start: { type: "string" },
        values: {
          type: "array",
          maxItems: 5_000,
          items: {
            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
          },
        },
      },
      ["pageId", "expectedRevision", "start", "values"],
      (args, threadId) =>
        edit(args, threadId, "sheet", (data) => {
          if (!Array.isArray(args.values) || !args.values.every(Array.isArray)) {
            throw new ToolInputError("values must be an array of rows");
          }
          const written = writeSheetRange(
            parseSheetWorkbook(data),
            field.string(args, "sheet", true),
            field.string(args, "start")!,
            args.values as unknown[][],
          );
          return { data: JSON.stringify(written.workbook), extra: { range: written.range } };
        }),
    ),
  ];
}
