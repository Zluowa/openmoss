// FILE: dashboardRuntime.ts
// Purpose: Server half of 数据看板: runs a live-query dataset on the user's connector (read-only
//          tools only, filters checked against their rules first) and keeps the last report an
//          open dashboard sent (faults, how each source loaded, the page as text) so Moss can
//          read how its page really ran.
// Layer: Server pages stream `types`
// Why: The page runs in an isolated frame that cannot reach the network; the web host asks the
//      server, which holds the connector sessions 应用页 already use.
// Exports: makeDashboardRuntime, DashboardRuntime, DashboardReport
// A loader's own calls (input.call) stay on the dataset's connector and pass the same
// read-only check, so a page can page through results but never change data.

import {
  PAGE_APP_MCP_CALL_TIMEOUT_MS,
  PAGE_APP_MCP_MAX_RESULT_BYTES,
  type PageId,
  type PageTypesDashboardQueryInput,
  type PageTypesDashboardQueryResult,
  type PageTypesDashboardReportInput,
} from "@moss/contracts";
import { readFile, stat } from "node:fs/promises";

import {
  DASHBOARD_LIBRARY_FILE_MAX_BYTES,
  fillCallArgs,
  isDashboardPayload,
  parseDashboard,
} from "@moss/shared/spaceItems/dashboard";
import { Effect } from "effect";

import { classifyMcpTool } from "../apps/extensions/mcpPolicy";
import type { PageAppMcpSources, PageAppMcpTool } from "../apps/extensions/mcpSources";
import { PagesServiceError, type PagesPrincipal } from "../Services/PagesService";
import type { PageTypesServiceShape } from "./PageTypesService";

export interface DashboardReport {
  readonly revision: number;
  readonly at: string;
  readonly faults: PageTypesDashboardReportInput["faults"];
  readonly sources: PageTypesDashboardReportInput["sources"];
  readonly page: string;
  readonly width: number;
  readonly draft: boolean;
}

export interface DashboardRuntime {
  readonly query: (
    input: PageTypesDashboardQueryInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageTypesDashboardQueryResult, PagesServiceError>;
  readonly report: (
    input: PageTypesDashboardReportInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<{ readonly stored: boolean }, PagesServiceError>;
  /** The last report for a page, or null when no dashboard view sent one in this run. */
  readonly lastReport: (pageId: PageId) => DashboardReport | null;
  /** Adds a data file an agent made to the 资料库 (moss_dashboard_attach_file). */
  readonly addLibraryFile: (
    path: string,
  ) => Effect.Effect<
    { readonly itemId: string; readonly size: number; readonly name: string },
    PagesServiceError
  >;
}

const MAX_REPORTS = 200;
const TOOLS_TTL_MS = 5 * 60_000;

/** The tool's answer as a page reads it: structured content, else JSON text, else text. */
export function answerOf(raw: {
  content: readonly unknown[];
  structuredContent: unknown;
}): unknown {
  if (raw.structuredContent !== undefined && raw.structuredContent !== null)
    return raw.structuredContent;
  const texts = raw.content.flatMap((part) =>
    part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
  const parsed = texts.map((text) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
  if (parsed.length === 0) return null;
  const single = parsed.length === 1 ? parsed[0] : parsed;
  // An answer whose only key is `result` is unwrapped.
  if (single && typeof single === "object" && !Array.isArray(single)) {
    const keys = Object.keys(single);
    if (keys.length === 1 && keys[0] === "result") return (single as { result: unknown }).result;
  }
  return single;
}

/** The 资料库 as the dashboard uses it: read a file's text by id, add a file an agent made. */
export interface DashboardLibraryFiles {
  readonly read: (itemId: string) => Promise<string>;
  readonly add: (
    path: string,
  ) => Promise<{ readonly itemId: string; readonly size: number; readonly name: string }>;
}

const DATA_FILE = /\.(csv|tsv|json|txt)$/iu;

/** Reads a 资料库 item's text: data files only, at most 15 MB, UTF-8. */
export async function readLibraryDataFile(
  item:
    | { readonly path: string | null; readonly trashedAt: string | null; readonly title: string }
    | undefined,
): Promise<string> {
  if (!item || item.trashedAt !== null || !item.path) throw new Error("资料库里找不到这个文件");
  if (!DATA_FILE.test(item.path)) throw new Error("看板只读 .csv、.tsv、.json 或 .txt 文件");
  const info = await stat(item.path);
  if (info.size > DASHBOARD_LIBRARY_FILE_MAX_BYTES) throw new Error("文件超过 15 MB，看板载不下");
  const bytes = await readFile(item.path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("这个文件不是 UTF-8 编码");
  }
}

export function makeDashboardRuntime(deps: {
  readonly types: Pick<PageTypesServiceShape, "read">;
  readonly sources: PageAppMcpSources | null;
  readonly library?: DashboardLibraryFiles | null;
  readonly now?: () => string;
}): DashboardRuntime {
  const now = deps.now ?? (() => new Date().toISOString());
  const reports = new Map<string, DashboardReport>();
  const toolLists = new Map<string, { at: number; tools: ReadonlyArray<PageAppMcpTool> }>();
  const failed = (
    status: PageTypesDashboardQueryResult["status"],
    message: string,
  ): PageTypesDashboardQueryResult => ({
    status,
    message,
    at: now(),
  });

  const readDashboard = (
    scopeSpaceId: PageTypesDashboardQueryInput["scopeSpaceId"],
    pageId: PageId,
    principal: PagesPrincipal,
  ) =>
    Effect.gen(function* () {
      const item = yield* deps.types.read({ scopeSpaceId, pageId }, principal);
      if (item.kind !== "app" || !item.data || !isDashboardPayload(item.data)) {
        return yield* Effect.fail(
          new PagesServiceError({ code: "invalid", message: "This item is not a data dashboard" }),
        );
      }
      return { item, dashboard: parseDashboard(item.data) };
    });

  const query: DashboardRuntime["query"] = (input, principal) =>
    Effect.gen(function* () {
      const { dashboard } = yield* readDashboard(input.scopeSpaceId, input.pageId, principal);
      const dataset =
        (input.draft ? dashboard.draft?.datasets[input.datasetId] : undefined) ??
        dashboard.datasets[input.datasetId];
      if (!dataset) return failed("error", "没有这个数据来源");
      const fileSource = dataset.source.kind === "file" ? dataset.source : null;
      if (fileSource?.library) {
        const library = deps.library;
        if (!library) return failed("error", "这个版本的 Moss 读不了资料库里的文件");
        return yield* Effect.tryPromise({
          try: async () => ({
            status: "ok" as const,
            answer: await library.read(fileSource.library!.itemId),
            at: now(),
          }),
          catch: (cause) =>
            new PagesServiceError({
              code: "storage",
              message: cause instanceof Error ? cause.message : "文件读不出来",
              cause,
            }),
        }).pipe(Effect.catch((error) => Effect.succeed(failed("error", error.message))));
      }
      if (dataset.source.kind !== "call") return failed("error", "这个数据来源是文件，不需要查询");
      // Only the stored connector and tool run. The view supplies filter values; an editor's
      // 测试 may also supply arguments, which still pass the same read-only check.
      const source = input.call
        ? { ...dataset.source, tool: input.call.tool, args: input.call.args, rules: {} }
        : input.args
          ? { ...dataset.source, args: input.args }
          : dataset.source;
      const values = { ...dashboard.params, ...(input.params as Record<string, never>) };
      const filled = fillCallArgs(source, values);
      if ("error" in filled) return failed("error", filled.error);
      if (!deps.sources) return failed("error", "这个版本的 Moss 不能运行实时查询");
      const sources = deps.sources;
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const server = await sources.resolve(source.connector);
          if (!server.session) {
            return failed(
              server.needsAuth ? "connect" : "error",
              server.reason ?? "找不到这个连接，请先在设置里连接它。",
            );
          }
          const cached = toolLists.get(server.key);
          const tools =
            cached && Date.now() - cached.at < TOOLS_TTL_MS
              ? cached.tools
              : await server.session.listTools(
                  AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                );
          toolLists.set(server.key, { at: Date.now(), tools });
          const tool = tools.find((entry) => entry.name === source.tool) ?? null;
          if (!tool) return failed("error", `${server.label} 没有「${source.tool}」这个工具`);
          if (!classifyMcpTool(source.tool, tool).readOnly)
            return failed("declined", "这个查询会修改数据，看板不能自动运行它。");
          const raw = await server.session.callTool(
            source.tool,
            filled.args,
            AbortSignal.any([signal, AbortSignal.timeout(PAGE_APP_MCP_CALL_TIMEOUT_MS)]),
          );
          if (JSON.stringify(raw).length > PAGE_APP_MCP_MAX_RESULT_BYTES)
            return failed("error", "结果太大，看板载不下。请在查询里先汇总。");
          const answer = answerOf(raw);
          if (raw.isError) {
            const message = typeof answer === "string" ? answer : JSON.stringify(answer ?? "");
            return failed("error", `查询没成功：${message.slice(0, 400)}`);
          }
          // MCP results arrive as JSON, so the answer is JSON (the contract's Schema.Json).
          return {
            status: "ok" as const,
            answer: answer as PageTypesDashboardQueryResult["answer"],
            at: now(),
          };
        },
        catch: (cause) =>
          new PagesServiceError({
            code: "storage",
            message:
              cause instanceof Error && cause.name === "TimeoutError"
                ? "查询太久没有结果，请稍后再试"
                : "连接出错了，请稍后再试",
            cause,
          }),
      }).pipe(Effect.catch((error) => Effect.succeed(failed("error", error.message))));
    });

  const report: DashboardRuntime["report"] = (input, principal) =>
    Effect.gen(function* () {
      const { item } = yield* readDashboard(input.scopeSpaceId, input.pageId, principal);
      if (input.revision > item.page.revision) return { stored: false };
      reports.delete(input.pageId);
      reports.set(input.pageId, {
        revision: input.revision,
        at: now(),
        faults: input.faults,
        sources: input.sources,
        page: input.page,
        width: input.width,
        draft: input.draft === true,
      });
      while (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value!);
      return { stored: true };
    });

  const addLibraryFile: DashboardRuntime["addLibraryFile"] = (path) =>
    Effect.tryPromise({
      try: async () => {
        if (!deps.library) throw new Error("这个版本的 Moss 不能把文件放进资料库");
        if (!DATA_FILE.test(path)) throw new Error("看板只接受 .csv、.tsv、.json 或 .txt 文件");
        return deps.library.add(path);
      },
      catch: (cause) =>
        new PagesServiceError({
          code: "invalid",
          message: cause instanceof Error ? cause.message : "文件放不进资料库",
          cause,
        }),
    });

  return { query, report, lastReport: (pageId) => reports.get(pageId) ?? null, addLibraryFile };
}
