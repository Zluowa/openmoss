// FILE: pageVisualizeTool.ts
// Purpose: moss_app_visualize, the one call behind a page's 可视化. The agent sends the chart's
//          code as plain top-level strings (html, or html/css/js); Moss assembles the 应用页,
//          publishes it, and proposes the page's 可视化 block naming it as a draft the person
//          accepts. The model never writes Plate JSON or escapes code inside nested JSON, which
//          is where acceptance round 10's model failed nine times.
// Layer: Server agent gateway

import { createHash } from "node:crypto";

import { PageAppsMutateInput, PageDraftsMutateInput, ThreadId } from "@moss/contracts";
import { PAGE_VISUALIZATION_TYPE } from "@moss/shared/pageAi";
import { parsePageRichContent, type PageRichNode } from "@moss/shared/pageRichContent";
import { Effect, Schema } from "effect";

import { PageAppsServiceError, type PageAppsServiceShape } from "../pages/apps/PageAppsService";
import { visualizationBlock } from "../pages/drafts/pageDraftBlocks";
import type { PageDraftsServiceShape } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceError, type PagesServiceShape } from "../pages/Services/PagesService";
import { mcpToolResultJson } from "./protocol";
import { errorText, ToolInputError } from "./toolInput";
import { WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime";

const RETRY =
  "Fix it and call moss_app_visualize once more with the corrected arguments; do not switch to another tool or start a sub-agent.";

const SELF_CONTAINED =
  "Resend the same visualization drawn with plain SVG or Canvas and vanilla JavaScript; no libraries, no external scripts.";

/** Globals of libraries the 应用页 frame does not provide (acceptance round 11: `new Chart(`). */
const LIBRARY_GLOBALS: ReadonlyArray<{
  readonly name: string;
  readonly label: string;
  readonly use: RegExp;
}> = [
  { name: "Chart", label: "Chart.js", use: /(?<![\w$.])(?:new\s+Chart\s*\(|Chart\.\w)/u },
  { name: "d3", label: "D3", use: /(?<![\w$.])d3\.\w/u },
  { name: "echarts", label: "ECharts", use: /(?<![\w$.])echarts\.\w/u },
  { name: "Plotly", label: "Plotly", use: /(?<![\w$.])Plotly\.\w/u },
  { name: "Highcharts", label: "Highcharts", use: /(?<![\w$.])Highcharts\.\w/u },
  { name: "ApexCharts", label: "ApexCharts", use: /(?<![\w$.])ApexCharts\b/u },
  { name: "google", label: "Google Charts", use: /(?<![\w$.])google\.charts\b/u },
  { name: "vegaEmbed", label: "Vega-Embed", use: /(?<![\w$.])vegaEmbed\s*\(/u },
  { name: "React", label: "React", use: /(?<![\w$.])React\.\w/u },
  { name: "ReactDOM", label: "React", use: /(?<![\w$.])ReactDOM\.\w/u },
  { name: "Vue", label: "Vue", use: /(?<![\w$.])Vue\.\w/u },
  { name: "$", label: "jQuery", use: /(?<![\w$.])\$\s*\(/u },
  { name: "jQuery", label: "jQuery", use: /(?<![\w$.])jQuery\s*[(.]/u },
];

const EXTERNAL_RESOURCES: ReadonlyArray<{ readonly what: string; readonly use: RegExp }> = [
  { what: "a script", use: /<script\b[^>]*\ssrc\s*=/iu },
  {
    what: "a stylesheet or font",
    use: /<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet)(?=[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\/)[^>]*>/iu,
  },
  { what: "a stylesheet or font", use: /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//iu },
  {
    what: "a module",
    use: /\bimport\s*(?:[\w$*{},\s]+\bfrom\s*)?["'`](?:https?:)?\/\/|\bimport\s*\(\s*["'`](?:https?:)?\/\//u,
  },
];

const escapeRegExp = (value: string) => value.replace(/[$()*+.?[\\\]^{|}]/gu, "\\$&");

/**
 * Why the code cannot run in the 应用页 frame, or null: the frame loads nothing from outside and
 * provides no libraries, so external resources and library globals the code never defines
 * itself would leave the 应用页 blank.
 */
export function unavailableCodeReason(source: string): string | null {
  for (const resource of EXTERNAL_RESOURCES)
    if (resource.use.test(source))
      return `This visualization loads ${resource.what} from outside the page, which is not available: the 应用页 runs with no network. Put every style and script inline. ${SELF_CONTAINED}`;
  for (const library of LIBRARY_GLOBALS) {
    if (!library.use.test(source)) continue;
    const defined = new RegExp(
      `(?:\\bfunction\\s*\\*?\\s*|\\bclass\\s+|\\b(?:const|let|var)\\s+)${escapeRegExp(library.name)}(?![\\w$])`,
      "u",
    );
    if (!defined.test(source))
      return `This visualization uses ${library.label}, which is not available. ${SELF_CONTAINED}`;
  }
  return null;
}

/**
 * Code as the model meant it: without a Markdown fence, a wrapping tag of its own kind, or one
 * level of escaping too many (`<div class=\"a\">\n…` written as a single line).
 */
export function normalizeCodeText(value: unknown, wrapper?: "style" | "script"): string {
  if (typeof value !== "string") return "";
  let text = value.trim();
  const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/u.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (/^"[\s\S]*"$/u.test(text)) {
    try {
      const inner: unknown = JSON.parse(text);
      if (typeof inner === "string") text = inner.trim();
    } catch {
      // Not a JSON string literal; keep the text.
    }
  }
  if (!text.includes("\n") && /\\n|\\"/u.test(text)) {
    try {
      const unescaped: unknown = JSON.parse(`"${text.replace(/(?<!\\)"/gu, '\\"')}"`);
      if (typeof unescaped === "string") text = unescaped.trim();
    } catch {
      // Leave text that only looks escaped alone.
    }
  }
  if (/^&lt;(?:!doctype|html|div|svg|canvas|section|main|style|script)\b/iu.test(text))
    text = text
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&amp;/gu, "&");
  if (wrapper) {
    const wrapped = new RegExp(
      `^<${wrapper}(?:\\s[^>]*)?>([\\s\\S]*)</${wrapper}\\s*>$`,
      "iu",
    ).exec(text);
    if (wrapped) text = wrapped[1]!.trim();
  }
  return text;
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");

/** One complete document: the model's own, or Moss's around a body fragment, CSS and JS. */
export function assembleVisualizationHtml(input: {
  readonly html: string;
  readonly css: string;
  readonly js: string;
  readonly title: string;
}): string {
  const style = input.css ? `<style>\n${input.css}\n</style>\n` : "";
  const script = input.js
    ? `<script>\n${input.js.replace(/<\/script/giu, "<\\/script")}\n</script>\n`
    : "";
  if (/<!doctype\s+html|<html[\s>]/iu.test(input.html)) {
    let doc = input.html;
    if (style) {
      const headEnd = /<\/head\s*>/iu.exec(doc);
      doc = headEnd
        ? `${doc.slice(0, headEnd.index)}${style}${doc.slice(headEnd.index)}`
        : `${style}${doc}`;
    }
    if (script) {
      const bodyEnd = [...doc.matchAll(/<\/body\s*>/giu)].at(-1);
      doc = bodyEnd
        ? `${doc.slice(0, bodyEnd.index)}${script}${doc.slice(bodyEnd.index)}`
        : `${doc}\n${script}`;
    }
    return doc;
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
${style}</head>
<body>
${input.html}
${script}</body>
</html>
`;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The block a 可视化 run fills: the one named, else the page's only unfilled 可视化 block. */
function targetBlock(nodes: readonly PageRichNode[], blockId: string): PageRichNode | null {
  if (blockId) return nodes.find((node) => node.id === blockId) ?? null;
  const open = nodes.filter(
    (node) => node.type === PAGE_VISUALIZATION_TYPE && typeof node.appPageId !== "string",
  );
  return open.length === 1 ? open[0]! : null;
}

const failure = (error: unknown) => {
  const message =
    error instanceof PagesServiceError || error instanceof PageAppsServiceError
      ? error.message
      : errorText(error);
  return {
    ...mcpToolResultJson({ error: { message: `${message} ${RETRY}` } }),
    isError: true,
  };
};

export function makePageVisualizeTool({
  pages,
  apps,
  drafts,
}: {
  readonly pages: PagesServiceShape;
  readonly apps: PageAppsServiceShape;
  readonly drafts: PageDraftsServiceShape;
}): ToolEntry {
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
  ) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(value),
      catch: (error) => new ToolInputError(`Invalid tool input: ${errorText(error)}`),
    });
  return {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "moss_app_visualize",
      description:
        "Make the chart, diagram or small interactive tool for a page's 可视化 block in ONE call: send its code as plain strings and Moss publishes it as an 应用页 and proposes the filled 可视化 block for the person to accept. Put the data straight into the code. html is either one complete <!doctype html> document or just the body markup; css and js are optional extra strings (no <style>/<script> tags needed). The page must be self-contained: it runs in a sandbox with no network and no libraries, so use no external scripts, stylesheets, fonts or network requests and no chart libraries (Chart.js, D3, ECharts, Plotly, Highcharts and the like); draw with plain HTML/CSS/SVG or Canvas and vanilla JavaScript. Code that loads or uses a library is refused. Do not read moss_app_guide first, do not call moss_pages_draft or moss_app_publish for this, do not write local files, and do not start sub-agents. When it succeeds, tell the person in one short sentence in their language.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "The page (from the request)." },
          scopeSpaceId: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Optional; the value from the request, or omit.",
          },
          blockId: {
            type: "string",
            description: "The 可视化 block to fill (from the request). Omit to add one at the end.",
          },
          title: {
            type: "string",
            maxLength: 120,
            description: "Short title in the person's language.",
          },
          html: {
            type: "string",
            description: "The chart: a complete HTML document, or the body markup.",
          },
          css: { type: "string", description: "Optional CSS." },
          js: { type: "string", description: "Optional JavaScript (runs after the markup)." },
          appId: {
            type: "string",
            description: "Optional: an 应用页 you already published; html then updates it.",
          },
          requestId: { type: "string", maxLength: 100, description: "Optional." },
        },
        required: ["pageId", "html"],
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        yield* context.assertCallerTurnActive();
        const input =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const pageId = text(input.pageId);
        if (!pageId) return yield* Effect.fail(new ToolInputError(`pageId is required. ${RETRY}`));
        const scopeSpaceId = text(input.scopeSpaceId) || null;
        const blockId = text(input.blockId ?? input.placeholderBlockId ?? input.block_id);
        const html = normalizeCodeText(input.html ?? input.code);
        const css = normalizeCodeText(input.css, "style");
        const js = normalizeCodeText(input.js ?? input.javascript ?? input.script, "script");
        const appId = text(input.appId ?? input.appPageId);
        if (!html && !js && !appId)
          return yield* Effect.fail(
            new ToolInputError(
              `html is required: the chart as one HTML document or its body markup, as a plain string. ${RETRY}`,
            ),
          );
        // Checked before anything is read, published or drafted, so the corrected call is new.
        const unavailable = unavailableCodeReason([html, css, js].join("\n"));
        if (unavailable) return yield* Effect.fail(new ToolInputError(`${unavailable} ${RETRY}`));
        const principal = {
          kind: "agent" as const,
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
        };
        const document = yield* pages.read(
          { scopeSpaceId: scopeSpaceId as never, pageId: pageId as never },
          principal,
        );
        let nodes: readonly PageRichNode[] = [];
        if (document.richContent) {
          try {
            nodes = parsePageRichContent(document.richContent).nodes;
          } catch {
            nodes = [];
          }
        }
        const target = targetBlock(nodes, blockId);
        if (blockId && !target)
          return yield* Effect.fail(
            new ToolInputError(
              `Block ${blockId} is not on this page any more. Omit blockId to add the chart at the end. ${RETRY}`,
            ),
          );
        const title =
          text(input.title).slice(0, 120) ||
          (typeof target?.title === "string" ? target.title : "") ||
          "可视化";
        const requestId =
          text(input.requestId).slice(0, 100) ||
          `viz:${createHash("sha256")
            .update(JSON.stringify([pageId, target?.id ?? "", html, css, js, appId]))
            .digest("hex")
            .slice(0, 32)}`;
        const source = html || js ? assembleVisualizationHtml({ html, css, js, title }) : null;
        const app =
          appId && source
            ? (yield* apps.mutate(
                yield* decode(PageAppsMutateInput, {
                  op: "update",
                  requestId: `${requestId}:app`,
                  appId,
                  expectedRevision: (yield* apps.read({ appId } as never, principal)).revision,
                  html: source,
                }),
                principal,
              )).app
            : appId
              ? (yield* apps.read({ appId } as never, principal)).app
              : (yield* apps.mutate(
                  yield* decode(PageAppsMutateInput, {
                    op: "create",
                    requestId: `${requestId}:app`,
                    scopeSpaceId,
                    html: source,
                    title,
                    sourceThreadId: context.callerThreadId,
                  }),
                  principal,
                )).app;
        const block = visualizationBlock({
          appPageId: app.id,
          title,
          prompt: typeof target?.prompt === "string" ? target.prompt : undefined,
        });
        const richContent = JSON.stringify([block]);
        const draft = yield* drafts.mutate(
          yield* decode(PageDraftsMutateInput, {
            op: "create",
            requestId: `${requestId}:draft`,
            scopeSpaceId,
            pageId,
            baseRevision: document.page.revision,
            kind: "visualization",
            summary: `可视化：${title}`.slice(0, 500),
            ops: [
              target && typeof target.id === "string"
                ? { kind: "replace", blockId: target.id, richContent }
                : { kind: "insert", richContent },
            ],
          }),
          principal,
        );
        return mcpToolResultJson({
          appId: app.id,
          title: app.title,
          link: `/apps/${app.id}`,
          draftId: draft.drafts[0]?.id ?? null,
          note: "Done. The 可视化 block waits in the page for the person to accept. Tell them in one short sentence in their language; do not call more tools.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
  };
}
