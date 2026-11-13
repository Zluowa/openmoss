// FILE: pageTypes.ts
// Purpose: Wire contract for typed 资料空间 items (幻灯片 / 电子表格 / 白板 / 应用页 / 设计 payloads)
//          and for 从模板开始 templates (built-in and personal).
// Layer: Contracts
// Why: A typed item is an ordinary page row (title, placement, trash, versions) plus a payload
//      the page body cannot hold. These calls read and save that payload against the page's
//      revision so the two never drift.

import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { Page, PageId, PageScopeSpaceId, PageSpaceId, PagesRpcError, SpaceItemKind } from "./pages";

/** Kinds whose content lives in a typed payload rather than in the page body. */
export const TypedSpaceItemKind = Schema.Literals(["slides", "sheet", "board", "app", "design"]);
export type TypedSpaceItemKind = typeof TypedSpaceItemKind.Type;
/** Kinds a template can create. */
export const SpaceTemplateKind = Schema.Literals(["page", "slides", "sheet", "app", "design"]);
export type SpaceTemplateKind = typeof SpaceTemplateKind.Type;

const ItemData = Schema.String.check(Schema.isMaxLength(2_000_000));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const TemplateId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const PageTypesReadInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  /** An earlier page revision: the payload as it was then (数据看板 history). */
  revision: Schema.optional(PositiveInt),
});
export type PageTypesReadInput = typeof PageTypesReadInput.Type;
export const PageTypedItem = Schema.Struct({
  page: Page,
  kind: SpaceItemKind,
  /** Normalized payload JSON; null for a plain page. */
  data: Schema.NullOr(ItemData),
  /** The page revision this payload was saved with. */
  dataRevision: Schema.NullOr(PositiveInt),
});
export type PageTypedItem = typeof PageTypedItem.Type;

export const PageTypesCreateInput = Schema.Struct({
  requestId: RequestId,
  scopeSpaceId: PageScopeSpaceId,
  /** `page` creates a plain page (only useful with a page template). */
  kind: Schema.Literals(["page", "slides", "sheet", "board", "app", "design"]),
  title: Title,
  spaceId: Schema.NullOr(PageSpaceId),
  parentPageId: Schema.NullOr(PageId),
  /** Starting payload; omit for an empty item or when `templateId` is given. */
  data: Schema.optional(ItemData),
  templateId: Schema.optional(TemplateId),
});
export type PageTypesCreateInput = typeof PageTypesCreateInput.Type;

export const PageTypesSaveInput = Schema.Struct({
  requestId: RequestId,
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  expectedRevision: PositiveInt,
  title: Schema.optional(Title),
  data: ItemData,
});
export type PageTypesSaveInput = typeof PageTypesSaveInput.Type;

export const SpaceTemplate = Schema.Struct({
  id: TemplateId,
  kind: SpaceTemplateKind,
  title: Title,
  description: Schema.String.check(Schema.isMaxLength(1_000)),
  category: Schema.String.check(Schema.isMaxLength(40)),
  builtIn: Schema.Boolean,
  sourcePageId: Schema.NullOr(PageId),
  createdAt: Schema.NullOr(IsoDateTime),
});
export type SpaceTemplate = typeof SpaceTemplate.Type;

export const PageTemplatesListInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  kind: Schema.optional(SpaceTemplateKind),
});
export type PageTemplatesListInput = typeof PageTemplatesListInput.Type;
export const PageTemplatesListResult = Schema.Struct({ templates: Schema.Array(SpaceTemplate) });
export type PageTemplatesListResult = typeof PageTemplatesListResult.Type;

/** Saves the current state of any page or typed item as a personal template. */
export const PageTemplatesSaveInput = Schema.Struct({
  requestId: RequestId,
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  title: Title,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
});
export type PageTemplatesSaveInput = typeof PageTemplatesSaveInput.Type;

export const PageTemplatesDeleteInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  templateId: TemplateId,
});
export type PageTemplatesDeleteInput = typeof PageTemplatesDeleteInput.Type;
export const PageTemplatesDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type PageTemplatesDeleteResult = typeof PageTemplatesDeleteResult.Type;

/** 数据看板: runs one live-query dataset with this view's filter values. */
export const PageTypesDashboardQueryInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  datasetId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  params: Schema.Record(Schema.String, Schema.Unknown),
  /** 测试，不保存: the stored connector and tool with these arguments instead of the stored ones. */
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** Run the source as the open draft has it (a new or changed call in a remix). */
  draft: Schema.optional(Schema.Boolean),
  /** A loader's further call (next page, a running query) on the dataset's own connector. */
  call: Schema.optional(
    Schema.Struct({
      tool: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      args: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});
export type PageTypesDashboardQueryInput = typeof PageTypesDashboardQueryInput.Type;
export const PageTypesDashboardQueryResult = Schema.Struct({
  status: Schema.Literals(["ok", "error", "connect", "declined"]),
  /** The tool's answer: structured content, else parsed JSON text, else the text. */
  answer: Schema.optional(Schema.Json),
  /** Why it did not run, one plain sentence. */
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  at: IsoDateTime,
});
export type PageTypesDashboardQueryResult = typeof PageTypesDashboardQueryResult.Type;

const ReportLine = Schema.String.check(Schema.isMaxLength(600));
/** 数据看板: what the open page showed and what went wrong, for Moss to read back. */
export const PageTypesDashboardReportInput = Schema.Struct({
  scopeSpaceId: PageScopeSpaceId,
  pageId: PageId,
  revision: PositiveInt,
  faults: Schema.Array(Schema.Struct({ where: ReportLine, message: ReportLine })).check(
    Schema.isMaxLength(50),
  ),
  sources: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
      status: Schema.String.check(Schema.isMaxLength(20)),
      message: ReportLine,
      rows: Schema.Number,
    }),
  ).check(Schema.isMaxLength(120)),
  page: Schema.String.check(Schema.isMaxLength(60_000)),
  width: Schema.Number,
  /** The view showed the draft, so the report describes the draft. */
  draft: Schema.optional(Schema.Boolean),
});
export type PageTypesDashboardReportInput = typeof PageTypesDashboardReportInput.Type;
export const PageTypesDashboardReportResult = Schema.Struct({ stored: Schema.Boolean });
export type PageTypesDashboardReportResult = typeof PageTypesDashboardReportResult.Type;

export const PAGE_TYPES_WS_METHODS = {
  dashboardQuery: "pageTypes.dashboardQuery",
  dashboardReport: "pageTypes.dashboardReport",
  read: "pageTypes.read",
  create: "pageTypes.create",
  save: "pageTypes.save",
  templatesList: "pageTemplates.list",
  templatesSave: "pageTemplates.save",
  templatesDelete: "pageTemplates.delete",
} as const;

export const WsPageTypesRpcGroup = RpcGroup.make(
  Rpc.make(PAGE_TYPES_WS_METHODS.dashboardQuery, {
    payload: PageTypesDashboardQueryInput,
    success: PageTypesDashboardQueryResult,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.dashboardReport, {
    payload: PageTypesDashboardReportInput,
    success: PageTypesDashboardReportResult,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.read, {
    payload: PageTypesReadInput,
    success: PageTypedItem,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.create, {
    payload: PageTypesCreateInput,
    success: PageTypedItem,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.save, {
    payload: PageTypesSaveInput,
    success: PageTypedItem,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.templatesList, {
    payload: PageTemplatesListInput,
    success: PageTemplatesListResult,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.templatesSave, {
    payload: PageTemplatesSaveInput,
    success: SpaceTemplate,
    error: PagesRpcError,
  }),
  Rpc.make(PAGE_TYPES_WS_METHODS.templatesDelete, {
    payload: PageTemplatesDeleteInput,
    success: PageTemplatesDeleteResult,
    error: PagesRpcError,
  }),
);

/** The `pageTypes` namespace of the renderer's NativeApi. */
export interface PageTypesNativeApi {
  readonly read: (input: PageTypesReadInput) => Promise<PageTypedItem>;
  readonly create: (input: PageTypesCreateInput) => Promise<PageTypedItem>;
  readonly save: (input: PageTypesSaveInput) => Promise<PageTypedItem>;
  readonly dashboard: {
    readonly query: (input: PageTypesDashboardQueryInput) => Promise<PageTypesDashboardQueryResult>;
    readonly report: (
      input: PageTypesDashboardReportInput,
    ) => Promise<PageTypesDashboardReportResult>;
  };
  readonly templates: {
    readonly list: (input: PageTemplatesListInput) => Promise<PageTemplatesListResult>;
    readonly save: (input: PageTemplatesSaveInput) => Promise<SpaceTemplate>;
    readonly delete: (input: PageTemplatesDeleteInput) => Promise<PageTemplatesDeleteResult>;
  };
}
