// FILE: htmlRenderTools.ts
// Purpose: The `html_render` agent tool, which shows a self-contained HTML page inline in the
//   caller's thread above the agent's reply, or updates the visual a named surface keeps.
// Layer: Agent gateway tool
// Origin: Ported from apps/server/src/mcp/toolkits/html/{tools,handlers}.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at ba0ea3d152150f399827d36a5b4b86c5bbda2d7f
//   (PR #15968), with the shorter tool copy from 08a463e29976617134de01e9341f898bc881d0eb.
//   Moss serves it from its agent gateway and records each page as a thread activity
//   (Moss's providers share no tool-result shape for clients to read it from).
//   See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";

import { CommandId, EventId, ThreadId, TurnId } from "@moss/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_SURFACE_LENGTH,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_SURFACE_PATTERN,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  isHtmlRenderSurface,
  type HtmlRenderReference,
} from "@moss/shared/htmlRender";
import type { ThemeAppearance } from "@moss/shared/themePalettes";
import {
  HTML_RENDER_ACTIVITY_KIND,
  htmlRenderActivityPayload,
} from "@moss/shared/htmlRenderActivity";
import { Effect } from "effect";

import type { HtmlRenderShape } from "../htmlRender/HtmlRender.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { gatewayIsoNow } from "./creationUtils.ts";
import { mcpToolResultError } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const HTML_MAX_LENGTH = 512_000;

const PAGE_RULES =
  "Inline <style> and <script>. Local images as absolute paths are inlined. Remote URLs load as-is.";

// The detailed rules live in visual_guide, so this description stays short in every session.
const VISUAL_RULES =
  "Read visual_guide before a diagram, calculator, simulation or map. A button can hand the reader's choice to their composer with window.mossFollowUp(text).";

export const HTML_RENDER_TOOL_DESCRIPTION = `Show a finished HTML page (chart, diagram, mockup, tool, map) inline in this thread, above your final reply. Do not announce or restate the page. Reuse a surface name to update one visual in place across turns (dashboard, test results, progress). The frame fits the page's height, up to ${HTML_RENDER_MAX_FIT_HEIGHT}px. ${PAGE_RULES} ${VISUAL_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`;

export const HTML_PREVIEW_TOOL_DESCRIPTION = `Check an HTML page before html_render. Returns PNG, contentHeight, and console output. The first preview on a machine waits while Moss downloads its preview browser; if it says the download is still running, call again in a minute. ${PAGE_RULES} Theme and layout rules are in html_render.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    html: {
      type: "string",
      minLength: 1,
      maxLength: HTML_MAX_LENGTH,
      description: "A complete, self-contained HTML document.",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: HTML_RENDER_MAX_TITLE_LENGTH,
      description: "Short name for the page.",
    },
    height: {
      type: "integer",
      description: `Frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the contentHeight from html_preview.`,
    },
    surface: {
      type: "string",
      minLength: 1,
      maxLength: HTML_RENDER_MAX_SURFACE_LENGTH,
      pattern: HTML_RENDER_SURFACE_PATTERN,
      description: "Optional stable name, such as build-status. Reuse it to replace that page.",
    },
  },
  required: ["html", "title", "height"],
  additionalProperties: false,
} as const;

const PREVIEW_INPUT_SCHEMA = {
  type: "object",
  properties: {
    html: { type: "string", minLength: 1, maxLength: HTML_MAX_LENGTH },
    width: {
      type: "integer",
      minimum: 240,
      maximum: 1600,
      description: `CSS pixels, 240 to 1600. Default ${HTML_RENDER_COLUMN_WIDTH}. Use about 390 for phones.`,
    },
    appearance: { enum: ["dark", "light"], description: "Default dark." },
  },
  required: ["html"],
  additionalProperties: false,
} as const;

const REPLY_RULE =
  "Don't mention or describe the page; reply with only what it doesn't already say.";

/** What the agent learns about the page it just published. */
function publishedMessage(surface: { readonly name: string; readonly existed: boolean } | null) {
  if (surface === null) return `Shown to the reader above your reply. ${REPLY_RULE}`;
  return surface.existed
    ? `Updated surface "${surface.name}" in place, where the reader first saw it. ${REPLY_RULE}`
    : `Created surface "${surface.name}", shown to the reader above your reply. ${REPLY_RULE}`;
}

function readHtmlRenderArgs(args: Record<string, unknown>) {
  const { html, title, height, surface } = args;
  if (typeof html !== "string" || html.length === 0 || html.length > HTML_MAX_LENGTH) {
    throw new ToolInputError(
      `Argument "html" must be an HTML document of 1-${HTML_MAX_LENGTH} characters.`,
    );
  }
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > HTML_RENDER_MAX_TITLE_LENGTH
  ) {
    throw new ToolInputError(
      `Argument "title" must be 1-${HTML_RENDER_MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (typeof height !== "number" || !Number.isInteger(height)) {
    throw new ToolInputError(`Argument "height" must be an integer number of CSS pixels.`);
  }
  if (surface !== undefined && !isHtmlRenderSurface(surface)) {
    throw new ToolInputError(
      `Argument "surface" must be 1-${HTML_RENDER_MAX_SURFACE_LENGTH} lowercase letters, digits and hyphens.`,
    );
  }
  return { page: { html, title, height }, surface: surface ?? null };
}

function readHtmlPreviewArgs(args: Record<string, unknown>) {
  const html = args.html;
  const width = args.width;
  const appearance = args.appearance;
  if (typeof html !== "string" || html.length === 0 || html.length > HTML_MAX_LENGTH) {
    throw new ToolInputError(
      `Argument "html" must be an HTML document of 1-${HTML_MAX_LENGTH} characters.`,
    );
  }
  if (
    width !== undefined &&
    (typeof width !== "number" || !Number.isInteger(width) || width < 240 || width > 1600)
  ) {
    throw new ToolInputError('Argument "width" must be an integer from 240 to 1600.');
  }
  if (appearance !== undefined && appearance !== "dark" && appearance !== "light") {
    throw new ToolInputError('Argument "appearance" must be "dark" or "light".');
  }
  const theme: ThemeAppearance | undefined =
    appearance === "dark" || appearance === "light" ? appearance : undefined;
  return {
    html,
    ...(width === undefined ? {} : { width }),
    ...(theme === undefined ? {} : { appearance: theme }),
  };
}

export interface AgentGatewayHtmlRenderToolsInput {
  readonly htmlRender: HtmlRenderShape;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  /** The caller thread's workspace, which scopes the local images a page may inline. */
  readonly resolveWorkspaceRoot: (context: ToolContext) => Effect.Effect<string | null>;
  /** Whether the thread already published a page on this surface. */
  readonly hasSurface: (threadId: ThreadId, surface: string) => Effect.Effect<boolean, unknown>;
}

export function makeAgentGatewayHtmlRenderTools(
  input: AgentGatewayHtmlRenderToolsInput,
): ReadonlyArray<ToolEntry> {
  const surfaceExists = (threadId: ThreadId, surface: string) =>
    input.hasSurface(threadId, surface).pipe(Effect.orElseSucceed(() => false));
  return [
    {
      definition: {
        name: "html_preview",
        description: HTML_PREVIEW_TOOL_DESCRIPTION,
        inputSchema: PREVIEW_INPUT_SCHEMA,
        annotations: {
          title: "Preview HTML",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      requiredCapability: "thread:read",
      requiresActiveTurn: true,
      handler: (args) =>
        Effect.gen(function* () {
          const previewArgs = yield* Effect.try({
            try: () => readHtmlPreviewArgs(args),
            catch: (error) => error,
          });
          const preview = yield* input.htmlRender.preview(previewArgs);
          return {
            content: [{ type: "image" as const, data: preview.png, mimeType: "image/png" }],
            structuredContent: {
              ...preview,
              screenshot: {
                mimeType: "image/png" as const,
                data: preview.png,
                width: preview.width,
                height: preview.capturedHeight,
              },
            },
          };
        }).pipe(
          Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
          Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
        ),
    },
    {
      definition: {
        name: HTML_RENDER_TOOL_NAME,
        description: HTML_RENDER_TOOL_DESCRIPTION,
        inputSchema: INPUT_SCHEMA,
        // Read-only in the MCP sense: it shows a page in the caller's own thread
        // and touches no workspace, so plan mode and read-only sandboxes can use it.
        annotations: {
          title: "Render HTML",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      requiredCapability: "thread:write",
      // The page is stored in the calling thread, so it needs that thread's live turn.
      requiresActiveTurn: true,
      handler: (args, context) =>
        Effect.gen(function* () {
          const { page, surface } = yield* Effect.try({
            try: () => readHtmlRenderArgs(args),
            catch: (error) => error,
          });
          const threadId = ThreadId.makeUnsafe(context.callerThreadId);
          // Read before this page is recorded. A failed lookup only changes the wording.
          const existed = surface !== null && (yield* surfaceExists(threadId, surface));
          const cwd = yield* input.resolveWorkspaceRoot(context);
          const published = yield* input.htmlRender.publish({ threadId, cwd, ...page });
          const reference: HtmlRenderReference =
            surface === null ? published : { ...published, surface };
          const createdAt = gatewayIsoNow();
          yield* input.orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:html-render`),
            threadId,
            activity: {
              id: EventId.makeUnsafe(`html-render:${reference.attachmentId}`),
              tone: "info",
              kind: HTML_RENDER_ACTIVITY_KIND,
              summary: reference.title,
              payload: htmlRenderActivityPayload(reference),
              turnId:
                context.callerTurnId === null ? null : TurnId.makeUnsafe(context.callerTurnId),
              createdAt,
            },
            createdAt,
          });
          const result = {
            htmlRender: reference,
            message: publishedMessage(surface === null ? null : { name: surface, existed }),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        }).pipe(
          // Every HTML render error message is built on the server and tells the agent what to do next.
          Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
          Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
        ),
    },
  ];
}
