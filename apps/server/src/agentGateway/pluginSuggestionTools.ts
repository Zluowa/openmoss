// FILE: pluginSuggestionTools.ts
// Purpose: `moss_search_plugins` and `moss_suggest_plugins` gateway tools backing
//          proactive plugin discovery and 1:1 in-chat install/auth suggestion cards.
//          Dynamically gated on whether the `moss-guide` official plugin is installed.
// Layer: Agent Gateway tool (provider-neutral)
// Exports: makeAgentGatewayPluginSuggestionTools, searchMossPluginsCatalog

import { randomBytes } from "node:crypto";

import {
  CommandId,
  EventId,
  PLUGIN_SEARCH_TOOL_NAME,
  PLUGIN_SUGGESTION_ACTIVITY_KIND,
  PLUGIN_SUGGESTION_MAX_ITEMS,
  PLUGIN_SUGGEST_TOOL_NAME,
  type PluginSuggestionActivityPayload,
  type PluginSuggestionItem,
  type PluginSuggestionSignIn,
  ThreadId,
  TurnId,
} from "@moss/contracts";
import {
  MCP_CONNECTOR_PRESETS,
  type McpConnectorPreset,
  type McpConnectorRegion,
  isMcpConnectorPresetListed,
} from "@moss/shared/mcpConnectors";
import type { MossAppToolkit } from "@moss/contracts";
import {
  activeDismissedSuggestionPluginIds,
  isMossGuidePluginInstalled,
  type DismissedPluginSuggestionRecord,
} from "@moss/shared/mossGuidePlugin";
import {
  MOSS_PLUGIN_CATALOG,
  MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL,
  mossPluginCatalogIconUrl,
  mossPluginCatalogPluginId,
} from "@moss/shared/mossPluginCatalog";
import { MOSS_SERVICE_PLUGINS, mossServicePluginInfo } from "@moss/shared/mossServicePlugins";
import { Effect } from "effect";

import type { McpConnectorsShape } from "../mcpConnectors/Services/McpConnectors.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";
import { errorText } from "./toolInput.ts";

export const PLUGIN_SUGGESTION_MAX_CARDS_PER_TURN = 2;
export const PLUGIN_SUGGESTION_MAX_CARDS_PER_THREAD = 6;
const MAX_TRACKED_KEYS = 512;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 15;

export interface CatalogEntryRecord {
  readonly item: PluginSuggestionItem;
  readonly installed: boolean;
  readonly searchText: string;
  readonly primaryTokens: ReadonlyArray<string>;
  readonly popularityRank?: number;
}

const BILINGUAL_QUERY_ALIASES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/谷歌邮件|google\s*mail|gmail/iu, ["gmail"]],
  [/微软邮箱|outlook/iu, ["outlook"]],
  [/邮件|邮箱|发邮件|收邮件|mail|inbox/iu, ["gmail", "outlook", "email", "mail"]],
  [/谷歌日历|google\s*calendar/iu, ["googlecalendar"]],
  [/日历|日程|约会|会议室|schedule|calendar/iu, ["googlecalendar", "outlook", "calendar"]],
  [/谷歌云盘|google\s*drive|dropbox|网盘|云盘/iu, ["googledrive", "dropbox"]],
  [/谷歌文档|google\s*docs/iu, ["googledocs"]],
  [/谷歌表格|google\s*sheets/iu, ["googlesheets"]],
  [/谷歌幻灯片|google\s*slides/iu, ["googleslides"]],
  [
    /地图|导航|路线|位置|距离|天气|map|route/iu,
    ["amap", "baidu_maps", "tencent_maps", "maps", "weather"],
  ],
  [/高德/iu, ["amap", "高德地图"]],
  [/百度地图/iu, ["baidu_maps", "百度地图"]],
  [/腾讯地图/iu, ["tencent_maps", "腾讯地图"]],
  [/打车|叫车|出行|网约车|ride|taxi/iu, ["didi", "滴滴"]],
  [/麦当劳|汉堡|麦乐送|点餐|mcdonald/iu, ["mcdonalds_cn", "麦当劳"]],
  [/瑞幸|咖啡|coffee|luckin/iu, ["luckin", "瑞幸"]],
  [/机票|火车票|酒店|旅游|差旅|景点|飞猪|flight|hotel|travel/iu, ["flyai", "飞猪"]],
  [/淘宝|天猫|购物|网购|购物车|taobao|shopping/iu, ["taobao", "淘宝"]],
  [/笔记|文档|知识库|wiki|note/iu, ["notion", "googledocs", "atlassian"]],
  [
    /任务|看板|需求|工单|缺陷|issue|ticket|jira|trello|asana|todoist/iu,
    ["linear", "jira", "trello", "asana", "todoist", "atlassian"],
  ],
  [
    /聊天|群聊|频道|会议|slack|discord|zoom|teams|im/iu,
    ["slack", "discord", "zoom", "microsoftteams"],
  ],
  [/crm|客户管理|hubspot|salesforce/iu, ["hubspot", "salesforce"]],
  [/airtable|shopify|youtube|canva|figma/iu, ["airtable", "shopify", "youtube", "canva", "figma"]],
  [/代码|仓库|github|pr|pull\s*request/iu, ["github", "coderabbit"]],
  [/设计|原型|figma/iu, ["figma"]],
  [
    /部署|托管|worker|serverless|hosting/iu,
    ["vercel", "cloudflare", "netlify", "render", "railway"],
  ],
  [/数据库|sql|postgres|db/iu, ["supabase", "neon", "prisma"]],
  [/报错|异常|监控|埋点|analytics|error/iu, ["sentry", "posthog"]],
  [/支付|收款|账单|invoice|payment/iu, ["stripe"]],
  [/程序化视频|代码剪辑|动效视频|remotion|hyperframes/iu, ["remotion", "hyperframes"]],
  [/论文|文献|引用|bibtex|科研|paper/iu, ["zotero"]],
  [/游戏|game/iu, ["game-studio"]],
  [/网页|前端|网站|ui|web/iu, ["build-web-apps"]],
  [/安卓|android|模拟器/iu, ["test-android-apps"]],
  [/苹果|ios|swift/iu, ["build-ios-apps"]],
  [/mac|macos/iu, ["build-macos-apps"]],
  [/飞书|feishu|lark/iu, ["lark", "feishu"]],
  [/钉钉|dingtalk/iu, ["dingtalk"]],
  [/企业微信|企微|wecom|wxwork/iu, ["wecom", "wechat"]],
  [/推特|twitter|\bx\b/iu, ["twitter"]],
  [/小红书|xiaohongshu|rednote/iu, ["xiaohongshu"]],
  [/公众号|微信公众号|wechat/iu, ["wechat"]],
  [/记账|报销|财务|会计|expense|accounting/iu, ["quickbooks", "xero", "stripe", "googlesheets"]],
  [/表单|问卷|survey|form/iu, ["typeform", "googleforms", "airtable"]],
  [/云文档|协作文档|confluence/iu, ["notion", "confluence", "googledocs", "lark"]],
];

/** Everyday personal/office connectors boosted above niche/marketing tools on broad queries. */
const POPULAR_CORE_APP_TOKENS: ReadonlySet<string> = new Set([
  "gmail",
  "outlook",
  "googlecalendar",
  "notion",
  "linear",
  "slack",
  "github",
  "figma",
  "googledrive",
  "googledocs",
  "googlesheets",
  "jira",
  "trello",
  "asana",
  "todoist",
  "discord",
  "zoom",
  "microsoftteams",
  "hubspot",
  "airtable",
  "dropbox",
  "lark",
  "feishu",
  "stripe",
  "sentry",
]);

function trimDescription(text: string | null | undefined, fallback: string): string {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  const value = cleaned.length > 0 ? cleaned : fallback;
  return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

function expandSearchTerms(query: string): readonly string[] {
  const base = query
    .toLowerCase()
    .split(/[\s,，、/|]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const terms = new Set<string>(base);
  for (const [pattern, aliases] of BILINGUAL_QUERY_ALIASES) {
    if (pattern.test(query)) {
      for (const alias of aliases) terms.add(alias.toLowerCase());
    }
  }
  if (terms.size === 0 && query.trim().length > 0) {
    terms.add(query.trim().toLowerCase());
  }
  return [...terms];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
  while (map.size > MAX_TRACKED_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export interface PluginSuggestionToolsDeps {
  readonly mcpConnectors?:
    | Pick<McpConnectorsShape, "list" | "mossApps" | "servicePlugins">
    | undefined;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<
      {
        readonly officialPlugins?: {
          readonly uninstalled?: ReadonlyArray<string>;
          readonly dismissedSuggestions?: ReadonlyArray<DismissedPluginSuggestionRecord>;
        };
      },
      unknown
    >;
  };
  readonly readAccountRegion?: () => Effect.Effect<McpConnectorRegion>;
  readonly readInstalledNativePluginIds?: () => Effect.Effect<ReadonlySet<string>>;
  readonly newSuggestionId?: () => string;
}

function mapComposioToolkitToCatalogRecord(
  toolkit: MossAppToolkit,
  isConnected: boolean,
  popularityRank?: number,
): CatalogEntryRecord {
  const slugLower = toolkit.slug.toLowerCase();
  const pluginId = `${toolkit.slug}@moss-apps`;
  const signIn: PluginSuggestionSignIn =
    toolkit.signIn === "credentials" || toolkit.signIn === "setup" ? toolkit.signIn : "managed";
  const desc = trimDescription(toolkit.description, toolkit.name);
  return {
    installed: isConnected,
    item: {
      pluginId,
      sourceKind: "moss-app",
      displayName: toolkit.name,
      developerName: "Moss",
      shortDescription: desc,
      iconUrl: toolkit.logoUrl ?? null,
      toolkitSlug: toolkit.slug,
      signIn,
      requiresAuth: toolkit.signIn !== "none",
    },
    primaryTokens: [slugLower, toolkit.name.toLowerCase()],
    searchText:
      `${pluginId} ${toolkit.slug} ${toolkit.name} ${toolkit.description} ${toolkit.categories.join(" ")}`.toLowerCase(),
    ...(popularityRank === undefined ? {} : { popularityRank }),
  };
}

interface UnifiedCatalogSnapshot {
  readonly records: ReadonlyArray<CatalogEntryRecord>;
  readonly connectedAppSlugs: ReadonlySet<string>;
  readonly connectorSlugSet: ReadonlySet<string>;
}

function buildUnifiedPluginCatalog(
  deps: Pick<
    PluginSuggestionToolsDeps,
    "mcpConnectors" | "readAccountRegion" | "readInstalledNativePluginIds"
  >,
): Effect.Effect<UnifiedCatalogSnapshot> {
  return Effect.gen(function* () {
    const region: McpConnectorRegion = deps.readAccountRegion
      ? yield* deps.readAccountRegion().pipe(Effect.orElseSucceed(() => "global" as const))
      : "global";
    const installedNative = deps.readInstalledNativePluginIds
      ? yield* deps
          .readInstalledNativePluginIds()
          .pipe(Effect.orElseSucceed((): ReadonlySet<string> => new Set()))
      : new Set<string>();

    const connectors = deps.mcpConnectors
      ? yield* deps.mcpConnectors.list().pipe(Effect.orElseSucceed(() => [] as const))
      : [];
    const connectedPresetIds = new Set(
      connectors.flatMap((entry) =>
        entry.presetId && entry.status === "connected" ? [entry.presetId] : [],
      ),
    );

    const serviceState = deps.mcpConnectors
      ? yield* deps.mcpConnectors.servicePlugins
          .list()
          .pipe(Effect.orElseSucceed(() => ({ installed: [], skills: [] })))
      : { installed: [], skills: [] };
    const installedServiceIds = new Set(serviceState.installed);

    const appToolkits = deps.mcpConnectors
      ? yield* deps.mcpConnectors.mossApps.listToolkits({ all: true }).pipe(
          Effect.map((res) => res.toolkits),
          Effect.orElseSucceed(() => [] as const),
        )
      : [];
    const appConnections = deps.mcpConnectors
      ? yield* deps.mcpConnectors.mossApps
          .listConnections()
          .pipe(Effect.orElseSucceed(() => [] as const))
      : [];
    const connectedAppSlugs = new Set(
      appConnections.filter((c) => c.status === "active").map((c) => c.toolkitSlug),
    );

    const records: CatalogEntryRecord[] = [];
    const servicePresetIds = new Set<string>();

    // 1. Moss service plugins (CN daily-life services + bundled skill/MCP)
    for (const plugin of MOSS_SERVICE_PLUGINS) {
      const info = mossServicePluginInfo(plugin);
      if (plugin.connectorPresetId) servicePresetIds.add(plugin.connectorPresetId);
      const isInstalled = plugin.connectorPresetId
        ? connectedPresetIds.has(plugin.connectorPresetId)
        : installedServiceIds.has(plugin.id);
      if (!isInstalled && info.region === "cn" && region !== "cn") continue;
      const pluginId = `${plugin.id}@moss-service-plugins`;
      const desc = trimDescription(plugin.skill.description || info.description, info.name);
      records.push({
        installed: isInstalled,
        item: {
          pluginId,
          sourceKind: "moss-service-plugin",
          displayName: info.name,
          developerName: "Moss",
          shortDescription: desc,
          iconUrl: null,
          servicePluginId: plugin.id,
          ...(plugin.connectorPresetId ? { connectorPresetId: plugin.connectorPresetId } : {}),
          requiresAuth: plugin.connectorPresetId !== null,
        },
        primaryTokens: [plugin.id, info.name.toLowerCase(), plugin.skill.name.toLowerCase()],
        searchText:
          `${pluginId} ${info.name} ${info.description} ${plugin.skill.description} ${plugin.skill.name}`.toLowerCase(),
      });
    }

    // 2. Listed MCP connector presets (excluding those already covered by service plugins)
    const connectorSlugSet = new Set<string>();
    const connectedConnectorSlugSet = new Set<string>();
    for (const preset of MCP_CONNECTOR_PRESETS as ReadonlyArray<McpConnectorPreset>) {
      if (!isMcpConnectorPresetListed(preset)) continue;
      if (servicePresetIds.has(preset.id)) continue;
      const isConnected = connectedPresetIds.has(preset.id);
      if (!isConnected && preset.region === "cn" && region !== "cn") continue;
      connectorSlugSet.add(preset.id);
      if (isConnected) connectedConnectorSlugSet.add(preset.id);
      const pluginId = `connector:${preset.id}`;
      const desc = trimDescription(preset.description, preset.name);
      records.push({
        installed: isConnected,
        item: {
          pluginId,
          sourceKind: "mcp-connector",
          displayName: preset.name,
          developerName: "Moss",
          shortDescription: desc,
          iconUrl: null,
          connectorPresetId: preset.id,
          requiresAuth: true,
        },
        primaryTokens: [preset.id, preset.name.toLowerCase()],
        searchText:
          `${pluginId} ${preset.name} ${preset.category} ${preset.description}`.toLowerCase(),
      });
    }

    // 3. Hosted Moss Apps (full Composio catalog, preserving usage popularity order)
    for (const [index, toolkit] of appToolkits.entries()) {
      const slugLower = toolkit.slug.toLowerCase();
      const isConnected = connectedAppSlugs.has(toolkit.slug);
      // Avoid duplicate row when an identical MCP preset exists unless the app itself is connected.
      if (connectorSlugSet.has(slugLower) && !isConnected) continue;
      if (connectedConnectorSlugSet.has(slugLower) && !isConnected) continue;
      records.push(mapComposioToolkitToCatalogRecord(toolkit, isConnected, index));
    }

    // 4. Moss Plugin Catalog (open-source skills/MCP plugins; never include Moss built-in image/video/canvas/web-builder)
    for (const entry of MOSS_PLUGIN_CATALOG) {
      const pluginId = mossPluginCatalogPluginId(entry.name);
      const isInstalled = installedNative.has(pluginId);
      const desc = trimDescription(entry.zhDescription || entry.description, entry.displayName);
      records.push({
        installed: isInstalled,
        item: {
          pluginId,
          sourceKind: "moss-catalog",
          displayName: entry.displayName,
          developerName: entry.developerName,
          shortDescription: desc,
          iconUrl: mossPluginCatalogIconUrl(MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL, entry),
          marketplaceName: "moss-catalog",
          pluginName: entry.name,
          requiresAuth: false,
        },
        primaryTokens: [entry.name.toLowerCase(), entry.displayName.toLowerCase()],
        searchText:
          `${pluginId} ${entry.name} ${entry.displayName} ${entry.zhDescription} ${entry.description} ${entry.category}`.toLowerCase(),
      });
    }

    return { records, connectedAppSlugs, connectorSlugSet };
  });
}

export function loadUnifiedPluginCatalog(
  deps: Pick<
    PluginSuggestionToolsDeps,
    "mcpConnectors" | "readAccountRegion" | "readInstalledNativePluginIds"
  >,
): Effect.Effect<ReadonlyArray<CatalogEntryRecord>> {
  return buildUnifiedPluginCatalog(deps).pipe(Effect.map((snapshot) => snapshot.records));
}

export function searchMossPluginsCatalog(
  catalog: ReadonlyArray<CatalogEntryRecord>,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
  dismissedIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<{
  readonly pluginId: string;
  readonly sourceKind: PluginSuggestionItem["sourceKind"];
  readonly displayName: string;
  readonly developerName: string;
  readonly shortDescription: string;
  readonly installed: boolean;
  readonly dismissed: boolean;
  readonly requiresAuth: boolean;
}> {
  const cappedLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.round(limit)));
  const terms = expandSearchTerms(query);
  const queryLower = query.trim().toLowerCase();
  const scored: Array<{ readonly score: number; readonly entry: CatalogEntryRecord }> = [];

  for (const entry of catalog) {
    let score = 0;
    if (queryLower.length === 0) {
      score = 1;
    } else {
      if (entry.item.pluginId.toLowerCase() === queryLower) score += 100;
      if (entry.primaryTokens.some((tok) => tok === queryLower)) score += 80;
      for (const term of terms) {
        if (entry.primaryTokens.some((tok) => tok === term)) score += 30;
        else if (entry.primaryTokens.some((tok) => tok.includes(term))) score += 18;
        else if (entry.searchText.includes(term)) score += 8;
      }
      if (score > 0 && entry.primaryTokens.some((tok) => POPULAR_CORE_APP_TOKENS.has(tok))) {
        score += 12;
      }
    }
    if (score > 0) scored.push({ score, entry });
  }

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.entry.installed !== right.entry.installed) return left.entry.installed ? 1 : -1;
    const leftPop = left.entry.popularityRank ?? Number.MAX_SAFE_INTEGER;
    const rightPop = right.entry.popularityRank ?? Number.MAX_SAFE_INTEGER;
    if (leftPop !== rightPop) return leftPop - rightPop;
    return left.entry.item.displayName.localeCompare(right.entry.item.displayName);
  });

  return scored.slice(0, cappedLimit).map(({ entry }) => ({
    pluginId: entry.item.pluginId,
    sourceKind: entry.item.sourceKind,
    displayName: entry.item.displayName,
    developerName: entry.item.developerName,
    shortDescription: entry.item.shortDescription,
    installed: entry.installed,
    dismissed: dismissedIds.has(entry.item.pluginId),
    requiresAuth: entry.item.requiresAuth,
  }));
}

export function makeAgentGatewayPluginSuggestionTools(
  deps: PluginSuggestionToolsDeps,
): ReadonlyArray<ToolEntry> {
  const newSuggestionId = deps.newSuggestionId ?? (() => `ps-${randomBytes(8).toString("hex")}`);
  const cardsByTurn = new Map<string, number>();
  const cardsByThread = new Map<string, number>();
  const suggestedIdsByTurn = new Map<string, Set<string>>();

  const readGuideSettings = () =>
    deps.serverSettings.getSettings.pipe(Effect.orElseSucceed(() => ({}) as const));

  const isGuideInstalled = () =>
    readGuideSettings().pipe(Effect.map((settings) => isMossGuidePluginInstalled(settings)));

  const searchTool: ToolEntry = {
    requiredCapability: "thread:read",
    available: isGuideInstalled,
    definition: {
      name: PLUGIN_SEARCH_TOOL_NAME,
      description:
        "Search Moss's connected apps (full Composio catalog: Gmail, Outlook, Calendar, GitHub, Notion, HubSpot, Jira, etc.), CN life services (高德, 滴滴, 麦当劳, 瑞幸, 飞猪, 淘宝), MCP connectors, and open-source workflow plugins. Always prefer Moss's native built-in capabilities first (images, videos, canvas, docs, sheets, slides, charts, automations never need plugins). Only search when the user explicitly requests or objectively needs an external service/account. Pass concise product/brand/capability keywords (e.g. 'gmail', 'Outlook', 'Notion'), not the full sentence.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Concise product name, service name, or capability keywords.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            description: "Maximum results to return (default 8, max 15).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Search Moss plugins",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const settings = yield* readGuideSettings();
        if (!isMossGuidePluginInstalled(settings)) {
          return mcpToolResultError(
            "Moss Guide (moss-guide) is uninstalled. Reinstall it in Plugins to use plugin discovery.",
          );
        }
        const dismissedIds = activeDismissedSuggestionPluginIds(settings);
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) {
          return mcpToolResultError('Argument "query" must be a non-empty keyword string.');
        }
        const rawLimit = typeof args.limit === "number" ? args.limit : DEFAULT_SEARCH_LIMIT;
        const snapshot = yield* buildUnifiedPluginCatalog(deps);
        let catalog = snapshot.records;
        let results = searchMossPluginsCatalog(catalog, query, rawLimit, dismissedIds);

        // Fallback targeted lookup in case the full catalog omitted or hadn't loaded a niche Composio toolkit.
        if (results.length === 0 && deps.mcpConnectors) {
          const searchQueries = Array.from(new Set([query, ...expandSearchTerms(query)])).slice(
            0,
            2,
          );
          const extraRecords: CatalogEntryRecord[] = [];
          const existingIds = new Set(catalog.map((entry) => entry.item.pluginId));
          for (const term of searchQueries) {
            const found = yield* deps.mcpConnectors.mossApps
              .listToolkits({ search: term, limit: 20 })
              .pipe(
                Effect.map((res) => res.toolkits),
                Effect.orElseSucceed(() => [] as const),
              );
            for (const [idx, toolkit] of found.entries()) {
              const pluginId = `${toolkit.slug}@moss-apps`;
              const isConnected = snapshot.connectedAppSlugs.has(toolkit.slug);
              if (
                existingIds.has(pluginId) ||
                (snapshot.connectorSlugSet.has(toolkit.slug.toLowerCase()) && !isConnected)
              ) {
                continue;
              }
              existingIds.add(pluginId);
              extraRecords.push(
                mapComposioToolkitToCatalogRecord(toolkit, isConnected, catalog.length + idx),
              );
            }
          }
          if (extraRecords.length > 0) {
            catalog = [...catalog, ...extraRecords];
            results = searchMossPluginsCatalog(catalog, query, rawLimit, dismissedIds);
          }
        }

        return mcpToolResultJson({
          query,
          results,
          note:
            results.length > 0
              ? "Only call moss_suggest_plugins for an unconnected plugin (installed=false, dismissed=false) that the user explicitly asked for or clearly needs for the task. Prefer 1 exact match (max 3), and never repeat dismissed suggestions."
              : "No matching external plugins found for that query. Try a broader capability or English/Chinese product keyword, or solve with Moss built-in capabilities if applicable.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const suggestTool: ToolEntry = {
    requiredCapability: "thread:write",
    available: isGuideInstalled,
    definition: {
      name: PLUGIN_SUGGEST_TOOL_NAME,
      description:
        "Display a quiet, non-blocking plugin suggestion card in the chat so the user can install and authorize/connect a missing external plugin with one click. Only call when the user explicitly wants an external app (e.g. 'send Gmail / 发谷歌邮件') or clearly needs an unconnected service. Pass exact pluginId values returned by moss_search_plugins (prefer 1 exact match, at most 3). Never suggest installed plugins or Moss built-in capabilities.",
      inputSchema: {
        type: "object",
        properties: {
          pluginIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: PLUGIN_SUGGESTION_MAX_ITEMS,
            description: "Exact pluginId values from moss_search_plugins (1 to 3 items).",
          },
        },
        required: ["pluginIds"],
        additionalProperties: false,
      },
      annotations: {
        title: "Suggest Moss plugins in chat",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const settings = yield* readGuideSettings();
        if (!isMossGuidePluginInstalled(settings)) {
          return mcpToolResultError(
            "Moss Guide (moss-guide) is uninstalled. Reinstall it in Plugins to suggest plugins.",
          );
        }
        const dismissedIds = activeDismissedSuggestionPluginIds(settings);
        const rawIds = Array.isArray(args.pluginIds) ? args.pluginIds : [];
        const requestedIds = Array.from(
          new Set(
            rawIds
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        ).slice(0, PLUGIN_SUGGESTION_MAX_ITEMS);
        if (requestedIds.length === 0) {
          return mcpToolResultError('Argument "pluginIds" must contain 1 to 3 valid plugin IDs.');
        }

        const snapshot = yield* buildUnifiedPluginCatalog(deps);
        const byId = new Map(snapshot.records.map((entry) => [entry.item.pluginId, entry]));

        // Resolve any @moss-apps ID that came from targeted search if not present in the cached full catalog.
        if (deps.mcpConnectors) {
          for (const id of requestedIds) {
            if (byId.has(id) || !id.endsWith("@moss-apps")) continue;
            const slug = id.slice(0, -"@moss-apps".length);
            if (!slug) continue;
            const found = yield* deps.mcpConnectors.mossApps
              .listToolkits({ search: slug, limit: 10 })
              .pipe(
                Effect.map((res) => res.toolkits),
                Effect.orElseSucceed(() => [] as const),
              );
            const exact = found.find((t) => t.slug === slug);
            if (exact) {
              byId.set(
                id,
                mapComposioToolkitToCatalogRecord(
                  exact,
                  snapshot.connectedAppSlugs.has(exact.slug),
                ),
              );
            }
          }
        }

        const turnKey =
          context.callerTurnId === null
            ? null
            : `${context.callerThreadId}\0${context.callerTurnId}`;
        const alreadySuggestedInTurn =
          turnKey !== null
            ? (suggestedIdsByTurn.get(turnKey) ?? new Set<string>())
            : new Set<string>();

        const toSuggest: PluginSuggestionItem[] = [];
        const alreadyInstalled: string[] = [];
        const dismissed: string[] = [];
        const unknown: string[] = [];

        for (const id of requestedIds) {
          const entry = byId.get(id);
          if (!entry) {
            unknown.push(id);
            continue;
          }
          if (entry.installed) {
            alreadyInstalled.push(id);
            continue;
          }
          if (dismissedIds.has(id)) {
            dismissed.push(id);
            continue;
          }
          if (alreadySuggestedInTurn.has(id)) continue;
          toSuggest.push(entry.item);
        }

        if (toSuggest.length === 0) {
          if (alreadyInstalled.length > 0 && unknown.length === 0 && dismissed.length === 0) {
            return mcpToolResultJson({
              suggested: [],
              alreadyInstalled,
              note: "The requested plugin(s) are already installed/connected. Use their tools directly without suggesting installation.",
            });
          }
          if (dismissed.length > 0 && unknown.length === 0) {
            return mcpToolResultJson({
              suggested: [],
              alreadyInstalled,
              dismissed,
              note: "The user recently dismissed these plugin suggestion(s). Respect their preference and do not suggest them again unless they explicitly ask to connect them in Plugins.",
            });
          }
          if (unknown.length > 0) {
            return mcpToolResultError(
              `Unknown pluginId(s): ${unknown.join(", ")}. Call ${PLUGIN_SEARCH_TOOL_NAME} first and pass exact returned pluginId values.`,
            );
          }
          return mcpToolResultJson({
            suggested: [],
            alreadyInstalled,
            note: "Those plugins were already suggested in this turn.",
          });
        }

        if (
          turnKey !== null &&
          (cardsByTurn.get(turnKey) ?? 0) >= PLUGIN_SUGGESTION_MAX_CARDS_PER_TURN
        ) {
          return mcpToolResultError(
            "This turn already showed enough plugin suggestion cards. Continue helping the user with their task.",
          );
        }
        if (
          (cardsByThread.get(context.callerThreadId) ?? 0) >= PLUGIN_SUGGESTION_MAX_CARDS_PER_THREAD
        ) {
          return mcpToolResultError(
            "This chat has reached the plugin suggestion limit. Tell the user they can open Plugins to browse more.",
          );
        }

        const suggestionId = newSuggestionId();
        const createdAt = new Date().toISOString();
        const payload: PluginSuggestionActivityPayload = {
          suggestionId,
          suggestions: toSuggest,
        };
        yield* deps.orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`agent:plugin-suggest:${suggestionId}`),
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
          activity: {
            id: EventId.makeUnsafe(`plugin-suggest:${suggestionId}`),
            tone: "info",
            kind: PLUGIN_SUGGESTION_ACTIVITY_KIND,
            summary: `Suggested ${toSuggest.map((s) => s.displayName).join(", ")}`,
            payload,
            turnId: context.callerTurnId === null ? null : TurnId.makeUnsafe(context.callerTurnId),
            createdAt,
          },
          createdAt,
        });

        if (turnKey !== null) {
          bump(cardsByTurn, turnKey);
          const nextSet = new Set(alreadySuggestedInTurn);
          for (const item of toSuggest) nextSet.add(item.pluginId);
          suggestedIdsByTurn.set(turnKey, nextSet);
        }
        bump(cardsByThread, context.callerThreadId);

        return mcpToolResultJson({
          suggestionId,
          suggested: toSuggest.map((item) => ({
            pluginId: item.pluginId,
            displayName: item.displayName,
            requiresAuth: item.requiresAuth,
          })),
          alreadyInstalled,
          ...(dismissed.length > 0 ? { skippedDismissed: dismissed } : {}),
          ...(unknown.length > 0 ? { ignoredUnknown: unknown } : {}),
          note: "An Install card is now shown in the chat. Briefly tell the user to click Install and complete sign-in/authorization if needed, and continue any part of the task that does not depend on it.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [searchTool, suggestTool];
}
