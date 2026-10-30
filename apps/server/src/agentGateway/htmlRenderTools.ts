// FILE: htmlRenderTools.ts
// Purpose: The `html_render` agent tool, which shows a self-contained HTML page inline in the
//   caller's thread above the agent's reply.
// Layer: Agent gateway tool
// Origin: Ported from apps/server/src/mcp/toolkits/html/{tools,handlers}.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at ba0ea3d152150f399827d36a5b4b86c5bbda2d7f
//   (PR #15968), with the shorter tool copy from 08a463e29976617134de01e9341f898bc881d0eb.
//   Moss serves it from its agent gateway and records each page as a thread activity
//   (Moss's providers share no tool-result shape for clients to read it from).
//   See THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";

import { CommandId, EventId, ThreadId, TurnId } from "@synara/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "@synara/shared/htmlRender";
import type { ThemeAppearance } from "@synara/shared/themePalettes";
import {
  HTML_RENDER_ACTIVITY_KIND,
  htmlRenderActivityPayload,
} from "@synara/shared/htmlRenderActivity";
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

export const HTML_RENDER_TOOL_DESCRIPTION = `Show a finished HTML page (chart, diagram, mockup) inline in this thread, above your final reply. Do not announce or restate the page. The frame fits the page's height, up to ${HTML_RENDER_MAX_FIT_HEIGHT}px. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`;

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

const SHOWN_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

function readHtmlRenderArgs(args: Record<string, unknown>) {
  const { html, title, height } = args;
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
  return { html, title, height };
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
}

export function makeAgentGatewayHtmlRenderTools(
  input: AgentGatewayHtmlRenderToolsInput,
): ReadonlyArray<ToolEntry> {
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
          const page = yield* Effect.try({
            try: () => readHtmlRenderArgs(args),
            catch: (error) => error,
          });
          const threadId = ThreadId.makeUnsafe(context.callerThreadId);
          const cwd = yield* input.resolveWorkspaceRoot(context);
          const reference = yield* input.htmlRender.publish({ threadId, cwd, ...page });
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
          const result = { htmlRender: reference, message: SHOWN_MESSAGE };
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
