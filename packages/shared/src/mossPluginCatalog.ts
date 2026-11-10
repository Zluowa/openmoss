// FILE: mossPluginCatalog.ts
// Purpose: The Moss plugin catalog: open-source skill and MCP plugins that work
//          with a Moss account (no ChatGPT sign-in), listed by Moss's own local
//          marketplace ("moss-catalog") and installed by the CLI from it. The
//          listing is compiled in, so the directory is complete offline and in
//          mainland China; each plugin's files come from Moss's domestic mirror
//          on first install and are checked against the hash pinned here.
// Layer: Shared runtime data (server writes the marketplace and verifies
//        downloads; web overlays the Chinese copy and icons)
// Exports: catalog entries, marketplace identity, mirror URL helpers

import {
  MOSS_PLUGIN_CATALOG_PACKAGES,
  MOSS_PLUGIN_CATALOG_SOURCE,
  type MossPluginCatalogPackage,
} from "./mossPluginCatalogPackages";

export { MOSS_PLUGIN_CATALOG_SOURCE, type MossPluginCatalogPackage };

export const MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME = "moss-catalog";
export const MOSS_PLUGIN_CATALOG_MARKETPLACE_DISPLAY_NAME = "Moss Plugin Catalog";
/** Moss's domestic CDN (the update mirror's host), reachable from mainland China and abroad. */
export const MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL =
  "https://moss-update.comiction.cn/plugin-catalog/v1/";
/** Developers and tests point the server at another copy of the mirror. */
export const MOSS_PLUGIN_CATALOG_URL_ENV = "MOSS_PLUGIN_CATALOG_URL";

/** The directory's own categories (`CODEX_DIRECTORY_CATEGORY_ORDER`). */
export type MossPluginCatalogCategory = "Developer Tools" | "Creativity" | "Education & Research";

/** What Moss writes for a plugin: its section and its one-line Chinese description. */
interface MossPluginCatalogCopy {
  readonly name: string;
  readonly category: MossPluginCatalogCategory;
  readonly zhDescription: string;
}

export interface MossPluginCatalogEntry extends MossPluginCatalogPackage {
  readonly category: MossPluginCatalogCategory;
  readonly zhDescription: string;
}

/**
 * In directory order. Only plugins that run without a ChatGPT sign-in and
 * whose license allows redistribution (MIT, Apache-2.0) are listed; the
 * upstream catalog's ChatGPT apps and proprietary plugins are left out.
 */
const CATALOG_COPY: readonly MossPluginCatalogCopy[] = [
  {
    name: "superpowers",
    category: "Developer Tools",
    zhDescription: "头脑风暴、写计划、测试驱动开发和系统化排错，按步骤把活干完",
  },
  {
    name: "build-web-apps",
    category: "Developer Tools",
    zhDescription: "搭建网页应用：前端界面、shadcn/ui 组件、Stripe 支付和 Supabase 数据",
  },
  {
    name: "build-ios-apps",
    category: "Developer Tools",
    zhDescription: "开发 iOS 应用：SwiftUI 界面、App Intents、性能分析和模拟器调试",
  },
  {
    name: "build-macos-apps",
    category: "Developer Tools",
    zhDescription: "开发 macOS 应用：SwiftUI 与 AppKit、构建运行、签名公证和排错",
  },
  {
    name: "test-android-apps",
    category: "Developer Tools",
    zhDescription: "在安卓模拟器上复现问题、查看界面、截图并收集日志和性能数据",
  },
  {
    name: "expo",
    category: "Developer Tools",
    zhDescription: "用 Expo 和 React Native 开发、升级、调试并发布手机应用",
  },
  {
    name: "cloudflare",
    category: "Developer Tools",
    zhDescription: "Cloudflare 平台指南：Workers、Wrangler、Agents SDK 和官方 API 工具",
  },
  {
    name: "render",
    category: "Developer Tools",
    zhDescription: "在 Render 上部署应用、排查失败的部署、查看服务状态和指标",
  },
  {
    name: "sentry",
    category: "Developer Tools",
    zhDescription: "查看 Sentry 里最近的报错和事件，汇总线上问题",
  },
  {
    name: "temporal",
    category: "Developer Tools",
    zhDescription: "用 Temporal 编写工作流、活动和 Worker，并管理本地与云端服务",
  },
  {
    name: "circleci",
    category: "Developer Tools",
    zhDescription: "配置 CircleCI 流水线，查看构建结果并修复失败的测试",
  },
  {
    name: "coderabbit",
    category: "Developer Tools",
    zhDescription: "用 CodeRabbit 审查当前改动，列出问题并跟进修复",
  },
  {
    name: "game-studio",
    category: "Creativity",
    zhDescription: "策划、原型和开发网页游戏，涵盖 2D、3D、界面和美术资源",
  },
  {
    name: "remotion",
    category: "Creativity",
    zhDescription: "用 React 和 Remotion 写代码做视频：动画、字幕、音频和转场",
  },
  {
    name: "hyperframes",
    category: "Creativity",
    zhDescription: "用 HTML 和 CSS 做视频，也能把网站变成一段视频",
  },
  {
    name: "zotero",
    category: "Education & Research",
    zhDescription: "连接本机 Zotero 文献库：找论文、导出 BibTeX、插入引用",
  },
];

/** Shown first, in the directory's Featured row. */
const FEATURED: readonly string[] = [
  "superpowers",
  "build-web-apps",
  "game-studio",
  "remotion",
  "expo",
  "hyperframes",
];

/** The upstream plugin folders the catalog build packs, in directory order. */
export const MOSS_PLUGIN_CATALOG_SELECTION: readonly string[] = CATALOG_COPY.map(
  (copy) => copy.name,
);

/** Every selected plugin that has a built package (the build script keeps them in step). */
export const MOSS_PLUGIN_CATALOG: readonly MossPluginCatalogEntry[] = CATALOG_COPY.flatMap(
  (copy) => {
    const built = MOSS_PLUGIN_CATALOG_PACKAGES.find((entry) => entry.name === copy.name);
    return built ? [{ ...built, ...copy }] : [];
  },
);

export function findMossPluginCatalogEntry(name: string): MossPluginCatalogEntry | undefined {
  return MOSS_PLUGIN_CATALOG.find((entry) => entry.name === name);
}

export function mossPluginCatalogPluginId(name: string): string {
  return `${name}@${MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME}`;
}

/** The catalog entry behind a plugin id ("superpowers@moss-catalog"); undefined otherwise. */
export function mossPluginCatalogEntryForPluginId(
  pluginId: string,
): MossPluginCatalogEntry | undefined {
  const suffix = `@${MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME}`;
  return pluginId.endsWith(suffix)
    ? findMossPluginCatalogEntry(pluginId.slice(0, -suffix.length))
    : undefined;
}

/** The mirror's base URL, with exactly one trailing slash; only https (or loopback http for tests). */
export function normalizeMossPluginCatalogBaseUrl(value: string | undefined): string {
  const url = new URL(value?.trim() || MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The Moss plugin catalog must be served over HTTPS.");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

export function mossPluginCatalogPackageUrl(
  baseUrl: string,
  entry: Pick<MossPluginCatalogPackage, "package">,
): string {
  return new URL(entry.package.file, normalizeMossPluginCatalogBaseUrl(baseUrl)).toString();
}

/** The listing icon on the mirror, shown before the plugin's own files are on disk. */
export function mossPluginCatalogIconUrl(
  baseUrl: string,
  entry: Pick<MossPluginCatalogPackage, "icon">,
): string | null {
  return entry.icon
    ? new URL(entry.icon, normalizeMossPluginCatalogBaseUrl(baseUrl)).toString()
    : null;
}

/** Plugin ids of the catalog's featured picks, for the directory's Featured row. */
export const MOSS_PLUGIN_CATALOG_FEATURED_PLUGIN_IDS: readonly string[] = FEATURED.filter((name) =>
  MOSS_PLUGIN_CATALOG.some((entry) => entry.name === name),
).map(mossPluginCatalogPluginId);
