// FILE: spaceItemTypes.ts
// Purpose: Web type registry for typed 资料空间 items: which kinds open a typed editor, how a
//          new one is made, its default title, and the client calls that create and convert.
// Layer: 资料空间 types stream. space-ui's create menu and cards call into this; labels and
//        glyphs of every kind stay in space-ui's spaceKinds.ts.

import type {
  NativeApi,
  PageApp,
  PageId,
  PageSpaceId,
  PageTypedItem,
  SpaceId,
  SpaceTemplateKind,
} from "@moss/contracts";
import { isTypedItemKind, type TypedItemKind } from "@moss/shared/spaceItems/itemData";

export interface SpaceTypedKindDefinition {
  readonly kind: TypedItemKind;
  /** Title a new item gets before the user renames it. */
  readonly defaultTitle: string;
  /** Short line for create menus and the template gallery. */
  readonly description: string;
  /** Whether 从模板开始 offers templates of this kind. */
  readonly templates: boolean;
}

export const SPACE_TYPED_KINDS: Record<TypedItemKind, SpaceTypedKindDefinition> = {
  slides: {
    kind: "slides",
    defaultTitle: "未命名幻灯片",
    description: "16:9 演示文稿，可演示和导出",
    templates: true,
  },
  sheet: {
    kind: "sheet",
    defaultTitle: "未命名电子表格",
    description: "公式、格式和多张工作表",
    templates: true,
  },
  board: {
    kind: "board",
    defaultTitle: "未命名白板",
    description: "在 Moss 画布中自由绘制",
    templates: false,
  },
  app: {
    kind: "app",
    defaultTitle: "未命名应用页",
    description: "仪表盘、跟踪表、投票等可运行页面",
    templates: true,
  },
  design: {
    kind: "design",
    defaultTitle: "未命名设计",
    description: "网页、应用界面、海报：在画布上排画板",
    templates: true,
  },
};

/** True for kinds whose content is a typed payload (opened by SpaceTypedItemView). */
export const isTypedSpaceKind = (kind: string | undefined): kind is TypedItemKind =>
  isTypedItemKind(kind);

export const TEMPLATE_KIND_LABELS: Record<SpaceTemplateKind, string> = {
  page: "页面",
  slides: "幻灯片",
  sheet: "电子表格",
  app: "仪表盘与应用页",
  design: "设计",
};

export const pageTypesQueryKeys = {
  item: (account: string, scope: SpaceId | null, pageId: PageId) =>
    ["pageTypes", "item", account, scope, pageId] as const,
  templates: (account: string, scope: SpaceId | null) =>
    ["pageTypes", "templates", account, scope] as const,
};

function requestId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export interface CreateSpaceItemInput {
  readonly scopeSpaceId: SpaceId | null;
  readonly kind: TypedItemKind | "page";
  readonly title?: string;
  readonly spaceId?: PageSpaceId | null;
  readonly parentPageId?: PageId | null;
  readonly templateId?: string;
  readonly data?: string;
}

/** Creates a typed item (or a page from a page template). Resolves with the saved item. */
export function createSpaceItem(
  api: Pick<NativeApi, "pageTypes">,
  input: CreateSpaceItemInput,
): Promise<PageTypedItem> {
  const title =
    input.title?.trim() ||
    (input.kind === "page" ? "未命名页面" : SPACE_TYPED_KINDS[input.kind].defaultTitle);
  return api.pageTypes.create({
    requestId: requestId(`space-create-${input.kind}`),
    scopeSpaceId: input.scopeSpaceId,
    kind: input.kind,
    title,
    spaceId: input.spaceId ?? null,
    parentPageId: input.parentPageId ?? null,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.data ? { data: input.data } : {}),
  });
}

/**
 * "转换为可编辑的幻灯片": reads a .pptx and creates an editable 幻灯片 item from it.
 * `skipped` counts charts, tables, groups and oversized pictures that were left out.
 */
export async function convertPptxToSlides(
  api: Pick<NativeApi, "pageTypes">,
  input: {
    scopeSpaceId: SpaceId | null;
    bytes: ArrayBuffer;
    fileName: string;
    spaceId?: PageSpaceId | null;
  },
): Promise<{ item: PageTypedItem; skipped: number }> {
  const { importPptxToDeck } = await import("./slides/slidesPptx");
  const { deck, skipped } = await importPptxToDeck(input.bytes);
  const item = await createSpaceItem(api, {
    scopeSpaceId: input.scopeSpaceId,
    kind: "slides",
    title: input.fileName.replace(/\.pptx?$/iu, "").slice(0, 200) || "导入的幻灯片",
    spaceId: input.spaceId ?? null,
    data: JSON.stringify(deck),
  });
  return { item, skipped };
}

/** Same as convertPptxToSlides for .xlsx / .csv into an editable 电子表格. */
export async function convertSpreadsheetToSheet(
  api: Pick<NativeApi, "pageTypes">,
  input: { scopeSpaceId: SpaceId | null; file: File; spaceId?: PageSpaceId | null },
): Promise<PageTypedItem> {
  const { xlsxToWorkbook, csvToWorkbook } = await import("./sheet/sheetXlsx");
  const csv = /\.csv$/iu.test(input.file.name);
  const workbook = csv
    ? csvToWorkbook(await input.file.text())
    : await xlsxToWorkbook(await input.file.arrayBuffer());
  return createSpaceItem(api, {
    scopeSpaceId: input.scopeSpaceId,
    kind: "sheet",
    title: input.file.name.replace(/\.(xlsx|csv)$/iu, "").slice(0, 200) || "导入的表格",
    spaceId: input.spaceId ?? null,
    data: JSON.stringify(workbook),
  });
}

/**
 * Saves a dashboard template as a real 应用页 (apps-runtime), filed in `spaceId`, with the
 * capabilities the template declares. The 资料空间 lists it beside pages.
 */
export async function createAppPageFromTemplate(input: {
  scopeSpaceId: SpaceId | null;
  spaceId?: PageSpaceId | null;
  title: string;
  html: string;
  capabilities: readonly string[];
}): Promise<PageApp> {
  const { pageAppsClient } = await import("../pageApps/pageAppsClient");
  const result = await pageAppsClient.mutate({
    op: "create",
    requestId: requestId("space-create-app"),
    scopeSpaceId: input.scopeSpaceId,
    spaceId: input.spaceId ?? null,
    title: input.title.trim().slice(0, 256) || "未命名应用页",
    html: input.html,
    capabilities: Object.fromEntries(input.capabilities.map((name) => [name, {}])),
    sourceThreadId: null,
  });
  return result.app;
}
