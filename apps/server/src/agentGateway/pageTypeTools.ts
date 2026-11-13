// FILE: pageTypeTools.ts
// Purpose: Agent tools for typed 资料空间 items: list/choose templates, create an item,
//          read it, edit slides, read and edit spreadsheets (the moss_sheet_* protocol:
//          typed reads, applyEdits against a base revision, and its guide), and build
//          数据看板.
// Layer: Agent gateway tool catalog (beside pageTools.ts)

import { PageId, ThreadId, type SpaceId } from "@moss/contracts";
import {
  readSheetRange,
  writeSheetRange,
  parseSheetWorkbook,
} from "@moss/shared/spaceItems/sheetWorkbook";
import {
  applyDashboardSystem,
  applyDashboardWrites,
  builtInSystemRef,
  storedSystemTokens,
  checkDashboard,
  createDashboard,
  dashboardWithDraft,
  isDashboardPayload,
  parseDashboard,
  type DashboardWrite,
} from "@moss/shared/spaceItems/dashboard";
import { parseAppItem } from "@moss/shared/spaceItems/itemData";
import {
  applySheetEdits,
  readSheetWorkbook,
  SheetEditRefusal,
} from "@moss/shared/spaceItems/sheetEdits";
import { sheetGuide, SHEET_GUIDE_TOPICS } from "@moss/shared/spaceItems/sheetGuide";
import { findBuiltInTemplate } from "@moss/shared/spaceItems/templates";
import { Effect } from "effect";

import type { PageAppsServiceShape } from "../pages/apps/PageAppsService";
import { PagesServiceError } from "../pages/Services/PagesService";
import type { PageTypesServiceShape } from "../pages/types/PageTypesService";
import { compileCheck } from "./dashboardCompile";
import { DASHBOARD_STANDARD_LOOK } from "@moss/shared/spaceItems/dashboardFrame";

import { DASHBOARD_GUIDE } from "./dashboardGuide";
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
  error instanceof SheetEditRefusal
    ? {
        ...mcpToolResultJson({
          error: {
            code: "refused",
            refusal: error.refusal,
            detail: error.detail,
            ...(error.editIndex === null ? {} : { editIndex: error.editIndex }),
            ...(error.address === null ? {} : { address: error.address }),
          },
        }),
        isError: true,
      }
    : error instanceof PagesServiceError
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
      error instanceof ToolInputError || error instanceof SheetEditRefusal
        ? error
        : new ToolInputError(errorText(error)),
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
    // 数据看板 templates are typed items, never 应用页.
    if (!data || isDashboardPayload(data)) return null;
    return findBuiltInTemplate(id)?.kind === "app" ? parseAppItem(data) : null;
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

  /** Fills a `system` write's tokens from a built-in system or a 设计 item's own system. */
  const resolveSystemWrite = (
    entry: DashboardWrite,
    scopeSpaceId: SpaceId | null,
    threadId: string,
  ) =>
    Effect.gen(function* () {
      const data = (entry.data ?? {}) as { source?: unknown; tokens?: unknown };
      if (data.tokens !== undefined) return entry;
      const source = typeof data.source === "string" ? data.source : "";
      const copiedAt = new Date().toISOString();
      if (source.startsWith("builtin:")) {
        const ref = builtInSystemRef(source.slice("builtin:".length), copiedAt);
        if (!ref)
          return yield* Effect.fail(new ToolInputError(`No built-in design system ${source}`));
        return { ...entry, data: ref };
      }
      if (source.startsWith("page:")) {
        const item = yield* types.read(
          { scopeSpaceId, pageId: PageId.makeUnsafe(source.slice("page:".length)) },
          principal(threadId),
        );
        const tokens = storedSystemTokens(item.data);
        if (!tokens)
          return yield* Effect.fail(new ToolInputError(`${source} holds no design system`));
        return { ...entry, data: { source, name: item.page.title, tokens, copiedAt } };
      }
      return yield* Effect.fail(
        new ToolInputError('system.source must be "builtin:<id>" or "page:<pageId>"'),
      );
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
      { kind: { type: "string", enum: ["page", "slides", "sheet", "app", "design"] } },
      [],
      (args, threadId) =>
        Effect.gen(function* () {
          const kind = args.kind as "page" | "slides" | "sheet" | "app" | "design" | undefined;
          return yield* types.listTemplates(
            { scopeSpaceId: field.scope(args), ...(kind ? { kind } : {}) },
            principal(threadId),
          );
        }),
    ),
    write(
      "moss_space_create_item",
      "Create a 资料空间 item: page, slides (16:9 deck), sheet (spreadsheet), board (whiteboard), app (runnable app page) or design (a canvas of HTML artboards). For designs use moss_design_create (read moss_design_guide first). For slides decks use moss_slides_create (outlines, templates, themes, .pptx import; read moss_slides_guide). Optionally start from templateId (see moss_space_templates) or pass data: sheet = {version:1,sheets:[{id,name,cells:[{r,c,v,f?}]}]}; app = {version:1,html,capabilities:['db'|'ai'|'downloads'|'user'|'permissions']}. requestId is idempotent.",
      {
        kind: { type: "string", enum: ["page", "slides", "sheet", "board", "app", "design"] },
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
            args.kind === "app" && apps && !(data && isDashboardPayload(data))
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
              kind: args.kind as "page" | "slides" | "sheet" | "board" | "app" | "design",
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
      "moss_dashboard_guide",
      "Read this before building or changing a 数据看板 (data dashboard: KPI tiles, charts, tables, filters over live queries or attached files). Explains the documents, the page API, marks, filters, tokens and how to check and hand over.",
      {},
      [],
      () => Effect.succeed({ guide: DASHBOARD_GUIDE }),
    ),
    write(
      "moss_dashboard_create",
      "Create an empty 数据看板 (data dashboard) in the 资料空间 so the user sees it at once, then fill it with moss_dashboard_write. Read moss_dashboard_guide first. requestId is idempotent.",
      {
        title: { type: "string", maxLength: 256 },
        spaceId: { ...nullableId, description: "Document space id, or null for Personal." },
        parentPageId: nullableId,
        lang: { type: "string", description: "Page language, default zh-CN." },
      },
      ["title", "spaceId", "parentPageId"],
      (args, threadId) =>
        Effect.gen(function* () {
          const title = field.string(args, "title")!;
          const dashboard = createDashboard(title);
          const lang = typeof args.lang === "string" && args.lang ? args.lang : undefined;
          const created = yield* types.create(
            {
              requestId: field.string(args, "requestId")!,
              scopeSpaceId: field.scope(args),
              kind: "app",
              title,
              spaceId: (args.spaceId ?? null) as never,
              parentPageId: (args.parentPageId ?? null) as never,
              data: JSON.stringify(
                lang ? { ...dashboard, meta: { ...dashboard.meta, lang } } : dashboard,
              ),
            },
            principal(threadId),
          );
          return {
            pageId: created.page.id,
            revision: created.page.revision,
            title: created.page.title,
          };
        }),
    ),
    read(
      "moss_dashboard_read",
      "Read a 数据看板: its documents (meta, params, settings, look, datasets, files), a static check, and the last report from the user's open view (faults, how each source loaded, the page as text, and the revision it describes).",
      { pageId: { type: "string" } },
      ["pageId"],
      (args, threadId) =>
        Effect.gen(function* () {
          const pageId = PageId.makeUnsafe(field.string(args, "pageId")!);
          const item = yield* types.read(
            { scopeSpaceId: field.scope(args), pageId },
            principal(threadId),
          );
          if (item.kind !== "app" || !item.data || !isDashboardPayload(item.data)) {
            return yield* Effect.fail(new ToolInputError("This item is not a data dashboard"));
          }
          const dashboard = yield* parseInput(() => parseDashboard(item.data!));
          const report = types.dashboard.lastReport(pageId);
          return {
            pageId,
            revision: item.page.revision,
            title: item.page.title,
            dashboard,
            check: checkDashboard(dashboard, compileCheck),
            ...(dashboard.draft
              ? { draftCheck: checkDashboard(dashboardWithDraft(dashboard), compileCheck) }
              : {}),
            report: report
              ? { ...report, current: report.revision === item.page.revision }
              : {
                  none: "No open view has reported yet. The user may not have the dashboard open.",
                },
          };
        }),
    ),
    write(
      "moss_dashboard_attach_file",
      "Attach a data file (.csv, .tsv, .json or .txt, UTF-8, up to 15 MB) to a 数据看板 as a dataset: the file is copied into the user's 资料库 and the dashboard reads it from there. Use it for files larger than about 1.5 MB; smaller ones can go inline with moss_dashboard_write. Everyone who can open the dashboard can read the whole file. Requires expectedRevision from the last read.",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        datasetId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        path: { type: "string", description: "Absolute path of the file on this computer." },
        title: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 1000 },
        format: { type: "string", enum: ["csv", "tsv", "json", "text"] },
        fixed: { type: "boolean" },
      },
      ["pageId", "expectedRevision", "datasetId", "path", "title"],
      (args, threadId) =>
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
          if (current.kind !== "app" || !current.data || !isDashboardPayload(current.data)) {
            return yield* Effect.fail(new ToolInputError("This item is not a data dashboard"));
          }
          if (current.page.revision !== input.expectedRevision) {
            return yield* Effect.fail(
              new PagesServiceError({
                code: "conflict",
                message: "The dashboard changed since it was read; read it again and retry",
                currentRevision: current.page.revision,
              }),
            );
          }
          const added = yield* types.dashboard.addLibraryFile(field.string(args, "path")!);
          const at = new Date().toISOString();
          const format = typeof args.format === "string" ? args.format : undefined;
          const next = yield* parseInput(() =>
            applyDashboardWrites(parseDashboard(current.data!), [
              {
                op: "set",
                path: `datasets/${field.string(args, "datasetId")!}`,
                data: {
                  title: field.string(args, "title")!,
                  ...(typeof args.description === "string"
                    ? { description: args.description }
                    : {}),
                  source: {
                    kind: "file",
                    name: added.name,
                    ...(format ? { format } : {}),
                    text: "",
                    library: { itemId: added.itemId, size: added.size },
                  },
                  updated: { at, by: "Moss" },
                  ...(args.fixed === true ? { fixed: true } : {}),
                  edit: { via: "moss", at },
                },
              },
            ]),
          );
          const saved = yield* types.save(
            { ...input, data: JSON.stringify(next) },
            principal(threadId),
          );
          return {
            pageId: saved.page.id,
            revision: saved.page.revision,
            libraryItemId: added.itemId,
            size: added.size,
            check: checkDashboard(next, compileCheck),
          };
        }),
    ),
    write(
      "moss_dashboard_write",
      "Write a 数据看板 in one save: writes [{op: set|update|delete, path: meta|params|settings|look|system|datasets/<id>|files/<name>|draft|draft/files/<name>|draft/datasets/<id>|draft/params, data}]. update merges at every depth; {__delete__: true} removes a key. Requires expectedRevision from the last read. Returns the new revision and a static check; then read the dashboard again for the open view's report.",
      {
        pageId: { type: "string" },
        expectedRevision: { type: "integer", minimum: 1 },
        writes: {
          type: "array",
          minItems: 1,
          maxItems: 60,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["set", "update", "delete"] },
              path: { type: "string" },
              data: {},
            },
            required: ["op", "path"],
          },
        },
      },
      ["pageId", "expectedRevision", "writes"],
      (args, threadId) =>
        Effect.gen(function* () {
          const input = yield* parseInput(() => ({
            requestId: field.string(args, "requestId")!,
            scopeSpaceId: field.scope(args),
            pageId: PageId.makeUnsafe(field.string(args, "pageId")!),
            expectedRevision: field.revision(args),
          }));
          if (!Array.isArray(args.writes) || args.writes.length === 0) {
            return yield* Effect.fail(new ToolInputError("writes must be a non-empty array"));
          }
          const current = yield* types.read(
            { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
            principal(threadId),
          );
          if (current.kind !== "app" || !current.data || !isDashboardPayload(current.data)) {
            return yield* Effect.fail(new ToolInputError("This item is not a data dashboard"));
          }
          if (current.page.revision !== input.expectedRevision) {
            return yield* Effect.fail(
              new PagesServiceError({
                code: "conflict",
                message: "The dashboard changed since it was read; read it again and retry",
                currentRevision: current.page.revision,
              }),
            );
          }
          // A design system named by source ("builtin:<id>" or "page:<id>") is copied in here,
          // and the dashboard's look is derived from it.
          const writes = yield* Effect.forEach(args.writes as DashboardWrite[], (entry) =>
            entry.path === "system" && entry.op === "set"
              ? resolveSystemWrite(entry, input.scopeSpaceId, threadId)
              : Effect.succeed(entry),
          );
          const wearsSystem = writes.some((entry) => entry.path === "system");
          const next = yield* parseInput(() => {
            const applied = applyDashboardWrites(parseDashboard(current.data!), writes);
            return wearsSystem
              ? applyDashboardSystem(applied, applied.system ?? null, DASHBOARD_STANDARD_LOOK)
              : applied;
          });
          const saved = yield* types.save(
            {
              ...input,
              data: JSON.stringify(next),
              ...(next.meta.title && next.meta.title !== current.page.title
                ? { title: next.meta.title.slice(0, 256) }
                : {}),
            },
            principal(threadId),
          );
          return {
            pageId: saved.page.id,
            revision: saved.page.revision,
            check: checkDashboard(next, compileCheck),
          };
        }),
    ),
    read(
      "moss_space_item_read",
      "Read a typed 资料空间 item (slides, sheet, board, app, design) with its revision and full JSON payload. For a spreadsheet use moss_sheet_read instead.",
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
      "moss_sheet_guide",
      "How to read and change a 资料空间 spreadsheet (sheet item) with moss_sheet_read and moss_sheet_apply_edits: the read kinds, every edit kind and its keys, what a cell holds, how to build a table, formats, rows and columns, dropdowns, conditional formats, charts and formulas. Read topics core and building before the first call on a sheet.",
      {
        topics: {
          type: "array",
          items: { type: "string", enum: [...SHEET_GUIDE_TOPICS] },
          description: "Defaults to core and building.",
        },
      },
      [],
      (args) =>
        Effect.succeed({
          guide: sheetGuide(
            Array.isArray(args.topics)
              ? args.topics.filter((topic): topic is string => typeof topic === "string")
              : undefined,
          ),
        }),
    ),
    read(
      "moss_sheet_read",
      "Read a 资料空间 spreadsheet the way a person sees it. payload is one of {kind:'readSheets'} (names, sizes, filledRange, freeze, table, chart and rule counts), {kind:'readCells',sheet,range} (typed values; formulas with their worked-out value; merged ranges, dropdowns, checkboxes), {kind:'readCellFormats',sheet,range}, {kind:'readConditionalFormats',sheet} (with the fingerprint a rules update needs) or {kind:'readCharts',sheet}. Every answer has the revision to pass as base to moss_sheet_apply_edits. Read moss_sheet_guide first.",
      { pageId: { type: "string" }, payload: { type: "object" } },
      ["pageId", "payload"],
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
          return yield* parseInput(() =>
            readSheetWorkbook(workbook, item.page.revision, args.payload),
          );
        }),
    ),
    write(
      "moss_sheet_apply_edits",
      "Change a 资料空间 spreadsheet: edits (up to 64, about 2,000 written cells) are made in order and land together as one revision, or none does. base is the revision of your last read or update. Kinds: writeCells, addSheet, renameSheet, deleteSheet, restoreSheet, moveSheets, formatCells, setBorders, mergeCells, unmergeCells, setColumnWidths, fitColumns, setRowHeights, insertRows, insertColumns, deleteRows, deleteColumns, moveRows, moveColumns, sortRows, sortCells, groupRows, groupColumns, ungroupRows, ungroupColumns, setSheetSettings, makeDropdown, setDropdownOptions, setCellTable, replaceConditionalFormats, addChart, setChart, deleteChart, setLocale, setTimeZone, with keys exactly as moss_sheet_guide gives them. A refusal names editIndex and a refusal word; nothing landed. The person sees the change at once and can undo it.",
      {
        pageId: { type: "string" },
        base: { type: "integer", minimum: 1 },
        edits: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } },
      },
      ["pageId", "base", "edits"],
      (args, threadId) =>
        Effect.gen(function* () {
          const base = args.base;
          if (!Number.isInteger(base) || (base as number) < 1) {
            return yield* Effect.fail(
              new ToolInputError("base must be the revision from your last read or update"),
            );
          }
          const current = yield* types.read(
            {
              scopeSpaceId: field.scope(args),
              pageId: PageId.makeUnsafe(field.string(args, "pageId")!),
            },
            principal(threadId),
          );
          if (current.kind !== "sheet" || current.data === null) {
            return yield* Effect.fail(
              new ToolInputError(`This item is a ${current.kind}, not a sheet`),
            );
          }
          if (current.page.revision !== base) {
            return yield* Effect.fail(
              new SheetEditRefusal(
                "baseIsNotTheRevision",
                `The sheet is at revision ${current.page.revision}, not ${String(base)}: someone edited it since your read. Read the cells again, then send the update with the new base.`,
              ),
            );
          }
          const result = yield* parseInput(() =>
            applySheetEdits(parseSheetWorkbook(current.data!), args.edits),
          );
          const saved = yield* types.save(
            {
              requestId: field.string(args, "requestId")!,
              scopeSpaceId: field.scope(args),
              pageId: current.page.id,
              expectedRevision: base as number,
              data: JSON.stringify(result.workbook),
            },
            principal(threadId),
          );
          return {
            revision: saved.page.revision,
            ...(result.changedNothing.length ? { changedNothing: result.changedNothing } : {}),
            ...(result.made.length ? { made: result.made } : {}),
          };
        }),
    ),
    read(
      "moss_sheet_read_range",
      "Older plain read of a spreadsheet range (prefer moss_sheet_read). A1 range, e.g. A1:D20; omit for the used area. Returns values (cached results for formulas) and formulas in the same 2-D shape, plus the sheet names.",
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
      "Older plain write of a 2-D block of values (prefer moss_sheet_apply_edits). Starts at the top-left cell `start` (A1). Strings beginning with = are formulas (e.g. =SUM(B2:B9)); null clears a cell. Requires expectedRevision from the last read.",
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
