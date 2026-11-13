// FILE: PageTypesService.ts
// Purpose: Typed 资料空间 items (幻灯片, 电子表格, 白板, 应用页) and 从模板开始 templates.
// Layer: Server pages stream `types`
// Why: A typed item is an ordinary page (placement, trash, history, comments all come from
//      PagesService) plus a payload stored per page revision in pages_item_data. Saving goes
//      through PagesService first, so authorization, idempotency and revision conflicts are
//      decided in one place, and the payload row is written in the same transaction.

import {
  PageTemplatesDeleteInput,
  PageTemplatesListInput,
  PageTemplatesSaveInput,
  PageTypesCreateInput,
  PageTypesReadInput,
  PageTypesSaveInput,
  SpaceTemplate,
  type Page,
  type PageId,
  type PageTemplatesDeleteResult,
  type PageTemplatesListResult,
  type PageTypedItem,
  type SpaceId,
  type SpaceTemplateKind,
} from "@moss/contracts";
import {
  emptyItemData,
  isTypedItemKind,
  parseItemData,
  type TypedItemKind,
} from "@moss/shared/spaceItems/itemData";
import { BUILT_IN_TEMPLATES, findBuiltInTemplate } from "@moss/shared/spaceItems/templates";
import { readFile } from "node:fs/promises";

import { DASHBOARD_LIBRARY_FILE_MAX_BYTES } from "@moss/shared/spaceItems/dashboard";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { stableGatewayDigest } from "../../agentGateway/creationUtils";
import { ServerConfig } from "../../config";
import { McpConnectors } from "../../mcpConnectors/Services/McpConnectors";
import { makePageAppMcpSources, type PageAppMcpSources } from "../apps/extensions/mcpSources";
import { LibraryService } from "../../library/Services/LibraryService";
import {
  makeDashboardRuntime,
  readLibraryDataFile,
  type DashboardLibraryFiles,
  type DashboardRuntime,
} from "./dashboardRuntime";
import {
  PagesService,
  PagesServiceError,
  type PagesPrincipal,
  type PagesServiceShape,
} from "../Services/PagesService";

export interface PageTypesServiceShape {
  readonly read: (
    input: PageTypesReadInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageTypedItem, PagesServiceError>;
  readonly create: (
    input: PageTypesCreateInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageTypedItem, PagesServiceError>;
  readonly save: (
    input: PageTypesSaveInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageTypedItem, PagesServiceError>;
  readonly listTemplates: (
    input: PageTemplatesListInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageTemplatesListResult, PagesServiceError>;
  readonly saveTemplate: (
    input: PageTemplatesSaveInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<SpaceTemplate, PagesServiceError>;
  readonly deleteTemplate: (
    input: PageTemplatesDeleteInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageTemplatesDeleteResult, PagesServiceError>;
  /**
   * Who wrote the payload of the page's latest data revision. Server-only: the slides tools
   * let an agent edit its own untouched deck directly and turn every other edit into a draft.
   */
  /** 数据看板 live queries and the last report of an open dashboard. */
  readonly dashboard: DashboardRuntime;
  readonly dataAuthor: (
    pageId: PageId,
  ) => Effect.Effect<
    { readonly revision: number; readonly author: string; readonly threadId: string | null } | null,
    PagesServiceError
  >;
}

export class PageTypesService extends ServiceMap.Service<PageTypesService, PageTypesServiceShape>()(
  "moss/pages/types/PageTypesService",
) {}

type Scope = SpaceId | null;
type DataRow = { revision: number; kind: string; data: string };
type TemplateRow = {
  template_id: string;
  kind: string;
  title: string;
  description: string;
  content: string;
  rich_content: string | null;
  data: string | null;
  source_page_id: string | null;
  created_at: string;
};

const scopeKey = (scope: Scope) => (scope === null ? "local-default" : `project-space:${scope}`);
const failure = (code: PagesServiceError["code"], message: string) =>
  new PagesServiceError({ code, message });
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) => new PagesServiceError({ code: "invalid", message: "Invalid input", cause }),
  });
const parse = (kind: TypedItemKind, data: string, title?: string) =>
  Effect.try({
    try: () => parseItemData(kind, data, title),
    catch: (cause) =>
      failure("invalid", cause instanceof Error ? cause.message : "Invalid item data"),
  });
const templateFromRow = (row: TemplateRow): SpaceTemplate =>
  Schema.decodeUnknownSync(SpaceTemplate)({
    id: row.template_id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    category: "我的模板",
    builtIn: false,
    sourcePageId: row.source_page_id,
    createdAt: row.created_at,
  });

export const makePageTypesServiceShape = (
  pages: PagesServiceShape,
  options: {
    readonly now?: () => string;
    readonly mcpSources?: PageAppMcpSources | null;
    readonly libraryFiles?: DashboardLibraryFiles | null;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = options.now ?? (() => new Date().toISOString());
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof PagesServiceError
            ? cause
            : new PagesServiceError({ code: "storage", message: "Item storage failed", cause }),
        ),
      );

    const latestData = (pageId: PageId, revision: number) =>
      sql<DataRow>`SELECT revision, kind, data FROM pages_item_data
        WHERE page_id = ${pageId} AND revision <= ${revision}
        ORDER BY revision DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0] ?? null));

    const itemFrom = (page: Page, row: DataRow | null): PageTypedItem => ({
      page,
      kind: row && isTypedItemKind(row.kind) ? row.kind : (page.kind ?? "page"),
      data: row?.data ?? null,
      dataRevision: row?.revision ?? null,
    });

    const writeData = (page: Page, kind: TypedItemKind, data: string, principal: PagesPrincipal) =>
      // A retried request returns the same page revision; the payload is the same too.
      sql`INSERT OR IGNORE INTO pages_item_data (page_id, revision, kind, data, author, author_thread_id, created_at)
        VALUES (${page.id}, ${page.revision}, ${kind}, ${data}, ${principal.kind},
          ${principal.kind === "agent" ? principal.threadId : null}, ${now()})`;

    const read: PageTypesServiceShape["read"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageTypesReadInput, raw);
          const result = yield* pages.read(
            { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
            principal,
          );
          // An earlier revision reads the payload as it was then; the page row stays current.
          const at =
            input.revision === undefined
              ? result.page.revision
              : Math.min(input.revision, result.page.revision);
          return itemFrom(result.page, yield* latestData(result.page.id, at));
        }),
      );

    /** Template body for a create: built-in, or a personal one from this scope. */
    const templateSource = (scope: Scope, templateId: string) =>
      Effect.gen(function* () {
        const builtIn = findBuiltInTemplate(templateId);
        if (builtIn) {
          return {
            kind: builtIn.kind as SpaceTemplateKind,
            content: builtIn.content ?? "",
            richContent: undefined as string | undefined,
            data: builtIn.data,
          };
        }
        const rows = yield* sql<TemplateRow>`SELECT * FROM pages_templates
          WHERE template_id = ${templateId} AND scope_key = ${scopeKey(scope)}`;
        const row = rows[0];
        if (!row) return yield* Effect.fail(failure("not-found", "That template does not exist"));
        return {
          kind: row.kind as SpaceTemplateKind,
          content: row.content,
          richContent: row.rich_content ?? undefined,
          data: row.data ?? undefined,
        };
      });

    const create: PageTypesServiceShape["create"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageTypesCreateInput, raw);
          const template = input.templateId
            ? yield* templateSource(input.scopeSpaceId, input.templateId)
            : null;
          if (template && template.kind !== input.kind) {
            return yield* Effect.fail(
              failure(
                "invalid",
                `Template ${input.templateId} makes a ${template.kind}, not a ${input.kind}`,
              ),
            );
          }
          if (input.kind === "page") {
            if (input.data !== undefined) {
              return yield* Effect.fail(failure("invalid", "A page takes content, not item data"));
            }
            const created = yield* pages.mutate(
              {
                op: "create",
                requestId: input.requestId,
                scopeSpaceId: input.scopeSpaceId,
                title: input.title,
                content: template?.content ?? "",
                ...(template?.richContent ? { richContent: template.richContent } : {}),
                spaceId: input.spaceId,
                parentPageId: input.parentPageId,
              },
              principal,
            );
            return itemFrom(created.page, null);
          }
          const kind = input.kind;
          // Validate before creating so a bad payload never leaves an empty page behind.
          const supplied = input.data ?? template?.data;
          const parsed = supplied === undefined ? null : yield* parse(kind, supplied, input.title);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const created = yield* pages.mutate(
                {
                  op: "create",
                  requestId: input.requestId,
                  scopeSpaceId: input.scopeSpaceId,
                  title: input.title,
                  kind,
                  content: parsed?.content ?? "",
                  spaceId: input.spaceId,
                  parentPageId: input.parentPageId,
                },
                principal,
              );
              const existing = yield* latestData(created.page.id, created.page.revision);
              if (existing) return itemFrom(created.page, existing);
              const data =
                parsed?.data ??
                (yield* parse(
                  kind,
                  emptyItemData(kind, { title: input.title, pageKey: created.page.id }),
                  input.title,
                )).data;
              yield* writeData(created.page, kind, data, principal);
              return itemFrom(created.page, { revision: created.page.revision, kind, data });
            }),
          );
        }),
      );

    const save: PageTypesServiceShape["save"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageTypesSaveInput, raw);
          const current = yield* read(
            { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
            principal,
          );
          if (!isTypedItemKind(current.kind)) {
            return yield* Effect.fail(
              failure("invalid", "This item has no typed payload; edit it as a page"),
            );
          }
          const kind = current.kind;
          const parsed = yield* parse(kind, input.data, input.title ?? current.page.title);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const updated = yield* pages.mutate(
                {
                  op: "update",
                  requestId: input.requestId,
                  scopeSpaceId: input.scopeSpaceId,
                  pageId: input.pageId,
                  expectedRevision: input.expectedRevision,
                  ...(input.title ? { title: input.title } : {}),
                  content: parsed.content,
                },
                principal,
              );
              yield* writeData(updated.page, kind, parsed.data, principal);
              return itemFrom(updated.page, {
                revision: updated.page.revision,
                kind,
                data: parsed.data,
              });
            }),
          );
        }),
      );

    const listTemplates: PageTypesServiceShape["listTemplates"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageTemplatesListInput, raw);
          // Listing pages authorizes the caller for this scope.
          yield* pages.spaces({ scopeSpaceId: input.scopeSpaceId }, principal);
          const rows = yield* sql<TemplateRow>`SELECT * FROM pages_templates
            WHERE scope_key = ${scopeKey(input.scopeSpaceId)} ORDER BY created_at DESC`;
          const builtIn = BUILT_IN_TEMPLATES.map((template) =>
            Schema.decodeUnknownSync(SpaceTemplate)({
              id: template.id,
              kind: template.kind,
              title: template.title,
              description: template.description,
              category: template.category,
              builtIn: true,
              sourcePageId: null,
              createdAt: null,
            }),
          );
          const templates = [...rows.map(templateFromRow), ...builtIn];
          return {
            templates: input.kind
              ? templates.filter((template) => template.kind === input.kind)
              : templates,
          };
        }),
      );

    const saveTemplate: PageTypesServiceShape["saveTemplate"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageTemplatesSaveInput, raw);
          const source = yield* pages.read(
            { scopeSpaceId: input.scopeSpaceId, pageId: input.pageId },
            principal,
          );
          const typed = itemFrom(
            source.page,
            yield* latestData(source.page.id, source.page.revision),
          );
          if (typed.kind !== "page" && !isTypedItemKind(typed.kind)) {
            return yield* Effect.fail(
              failure("invalid", `A ${typed.kind} item cannot become a template`),
            );
          }
          if (typed.kind === "board") {
            return yield* Effect.fail(
              failure("invalid", "Boards cannot be saved as templates yet"),
            );
          }
          const actor =
            principal.kind === "local-user" ? "local-user" : `thread:${principal.threadId}`;
          const templateId = `tpl_${stableGatewayDigest([scopeKey(input.scopeSpaceId), actor, input.requestId], 24)}`;
          const existing =
            yield* sql<TemplateRow>`SELECT * FROM pages_templates WHERE template_id = ${templateId}`;
          if (existing[0]) return templateFromRow(existing[0]);
          yield* sql`INSERT INTO pages_templates (template_id, scope_key, kind, title, description, content, rich_content, data, source_page_id, created_at)
            VALUES (${templateId}, ${scopeKey(input.scopeSpaceId)}, ${typed.kind}, ${input.title},
              ${input.description ?? ""}, ${source.content}, ${source.richContent ?? null}, ${typed.data},
              ${source.page.id}, ${now()})`;
          const rows =
            yield* sql<TemplateRow>`SELECT * FROM pages_templates WHERE template_id = ${templateId}`;
          return templateFromRow(rows[0]!);
        }),
      );

    const deleteTemplate: PageTypesServiceShape["deleteTemplate"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageTemplatesDeleteInput, raw);
          if (findBuiltInTemplate(input.templateId)) {
            return yield* Effect.fail(failure("forbidden", "Built-in templates cannot be deleted"));
          }
          yield* pages.spaces({ scopeSpaceId: input.scopeSpaceId }, principal);
          const rows = yield* sql<{ template_id: string }>`DELETE FROM pages_templates
            WHERE template_id = ${input.templateId} AND scope_key = ${scopeKey(input.scopeSpaceId)}
            RETURNING template_id`;
          return { deleted: rows.length > 0 };
        }),
      );

    const dataAuthor: PageTypesServiceShape["dataAuthor"] = (pageId) =>
      protect(
        sql<{
          revision: number;
          author: string;
          author_thread_id: string | null;
        }>`SELECT revision, author, author_thread_id
          FROM pages_item_data WHERE page_id = ${pageId} ORDER BY revision DESC LIMIT 1`.pipe(
          Effect.map((rows) =>
            rows[0]
              ? {
                  revision: rows[0].revision,
                  author: rows[0].author,
                  threadId: rows[0].author_thread_id,
                }
              : null,
          ),
        ),
      );

    return {
      read,
      create,
      save,
      listTemplates,
      saveTemplate,
      deleteTemplate,
      dashboard: makeDashboardRuntime({
        types: { read },
        sources: options.mcpSources ?? null,
        library: options.libraryFiles ?? null,
        now,
      }),
      dataAuthor,
    } satisfies PageTypesServiceShape;
  });

export const PageTypesServiceLive = Layer.effect(
  PageTypesService,
  Effect.gen(function* () {
    const pages = yield* PagesService;
    // Optional so test layers without config or connectors still build; live queries then
    // answer that this build cannot run them.
    const config = Option.getOrNull(yield* Effect.serviceOption(ServerConfig));
    const connectors = yield* Effect.serviceOption(McpConnectors);
    const mcpSources = config
      ? makePageAppMcpSources({ connectors: Option.getOrNull(connectors), baseDir: config.baseDir })
      : null;
    if (mcpSources) yield* Effect.addFinalizer(() => Effect.promise(() => mcpSources.dispose()));
    // 数据看板 files larger than the item can hold live in the 资料库.
    const library = Option.getOrNull(yield* Effect.serviceOption(LibraryService));
    const libraryFiles: DashboardLibraryFiles | null = library
      ? {
          read: async (itemId) => {
            const listed = await Effect.runPromise(library.list({ includeTrashed: false }));
            return readLibraryDataFile(listed.items.find((item) => item.id === itemId));
          },
          add: async (path) => {
            const bytes = await readFile(path);
            if (bytes.length > DASHBOARD_LIBRARY_FILE_MAX_BYTES)
              throw new Error("文件超过 15 MB，看板载不下");
            const name = path.split(/[\\/]/u).pop() || "data.csv";
            const result = await Effect.runPromise(
              library.importFiles({ files: [{ name, dataBase64: bytes.toString("base64") }] }),
            );
            const item = result.items[0];
            if (!item) throw new Error("文件放不进资料库");
            return { itemId: item.id, size: bytes.length, name };
          },
        }
      : null;
    return yield* makePageTypesServiceShape(pages, { mcpSources, libraryFiles });
  }),
);
