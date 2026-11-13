// FILE: pageTypes.ts
// Purpose: Wire contract for typed 资料空间 items (幻灯片 / 电子表格 / 白板 / 应用页 payloads)
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
export const TypedSpaceItemKind = Schema.Literals(["slides", "sheet", "board", "app"]);
export type TypedSpaceItemKind = typeof TypedSpaceItemKind.Type;
/** Kinds a template can create. */
export const SpaceTemplateKind = Schema.Literals(["page", "slides", "sheet", "app"]);
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
  kind: Schema.Literals(["page", "slides", "sheet", "board", "app"]),
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

export const PAGE_TYPES_WS_METHODS = {
  read: "pageTypes.read",
  create: "pageTypes.create",
  save: "pageTypes.save",
  templatesList: "pageTemplates.list",
  templatesSave: "pageTemplates.save",
  templatesDelete: "pageTemplates.delete",
} as const;

export const WsPageTypesRpcGroup = RpcGroup.make(
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
  readonly templates: {
    readonly list: (input: PageTemplatesListInput) => Promise<PageTemplatesListResult>;
    readonly save: (input: PageTemplatesSaveInput) => Promise<SpaceTemplate>;
    readonly delete: (input: PageTemplatesDeleteInput) => Promise<PageTemplatesDeleteResult>;
  };
}
