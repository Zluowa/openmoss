// FILE: install.ts
// Purpose: Moss's self-report tools for an agent checking Moss's own screen (a module session
//          checking its UI work, the lead accepting it): `screen_report`, `layout_report`,
//          `screenshot`, `console_report`. Read-only. Installed only where enabled:
//          a development build, or a desktop app whose main process enabled self-report (a
//          packaged build started with MOSS_SELF_REPORT=1 in an isolated profile).
//
// How an outside session reaches them, without the owner's profile: it starts an isolated
// instance with a debugging port (the acceptance kit does) and, on the `moss://app` page, runs
// `await window.mossSelfReport.call(name, input)`; `window.mossSelfReport.tools` lists the names
// with their input schemas. Where Chromium offers WebMCP (`document.modelContext`), the same
// tools are registered there too.
// Layer: Web dev/test tooling (self-report)

import { consoleReport, installConsoleCapture, type ConsoleCaptureTarget } from "./consoleCapture";
import { layoutReport, type LayoutReportInput } from "./layoutReport";
import { screenReport, type ScreenReportInput } from "./screenReport";
import {
  settleLayout,
  takeScreenshots,
  type ScreenshotInput,
  type SelfReportCaptureBridge,
} from "./screenshot";

export const SELF_REPORT_VERSION = 1;

const SIZE_SCHEMA = {
  type: "object",
  properties: { width: { type: "number" }, height: { type: "number" } },
  required: ["width", "height"],
  additionalProperties: false,
} as const;

/** Echoed back in the answer, so a caller can match answers to its runs. */
const RUN_ID_SCHEMA = { type: ["string", "number"] } as const;

/**
 * Every answer also carries `runId` (when given), `ms` and `window: {width, height, dpr}`.
 * Bump the version when a tool's input or answer changes shape; the acceptance kit refuses a
 * version it does not know.
 */
export const SELF_REPORT_TOOLS = [
  {
    name: "screen_report",
    description:
      "What the Moss window shows now: route, window size, theme, open dialogs/menus/popups with titles, the focused element, and the visible text in reading order (bounded). Never field values or secrets.",
    inputSchema: {
      type: "object",
      properties: {
        maxChars: { type: "number", description: "Text kept, at most (4000)." },
        runId: RUN_ID_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "layout_report",
    description:
      "Layout defects as a person sees them: overflowing or clipped elements, text cut without an ellipsis, popups partly outside the window, overlapping controls, controls under the window's own buttons. Each with a selector, its rectangle and what it breaks.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Only elements inside this selector." },
        max: { type: "number", description: "Findings kept, at most (100)." },
        windowControls: { type: "string", enum: ["auto", "windows", "mac", "none"] },
        runId: RUN_ID_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description:
      'The window or one element as PNG files, at the current size or at sizes (a list, or "standard": 1101x782, 1375x886, 390x844). Returns the files\' paths.',
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        sizes: {
          oneOf: [
            { type: "array", items: SIZE_SCHEMA },
            { type: "string", enum: ["standard"] },
          ],
        },
        dir: { type: "string", description: "An absolute folder for the files." },
        runId: RUN_ID_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "console_report",
    description:
      "The renderer's console errors and warnings, uncaught errors and unhandled rejections since the last call.",
    inputSchema: {
      type: "object",
      properties: { runId: RUN_ID_SCHEMA },
      additionalProperties: false,
    },
  },
] as const;

export type SelfReportToolName = (typeof SELF_REPORT_TOOLS)[number]["name"];

export interface MossSelfReport {
  readonly version: number;
  readonly tools: typeof SELF_REPORT_TOOLS;
  readonly call: (name: string, input?: unknown) => Promise<unknown>;
}

declare global {
  interface Window {
    mossSelfReport?: MossSelfReport;
  }
}

function asObject(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function runTool(
  name: string,
  args: Record<string, unknown>,
  bridge: SelfReportCaptureBridge | undefined,
): Promise<object> {
  switch (name) {
    case "screen_report":
      return Promise.resolve(screenReport(args as ScreenReportInput));
    case "layout_report":
      return settleLayout().then(() => layoutReport(args as LayoutReportInput));
    case "screenshot":
      return takeScreenshots(bridge, args as ScreenshotInput);
    case "console_report":
      return Promise.resolve(consoleReport());
    default:
      return Promise.resolve({ error: `Unknown self-report tool ${name}.` });
  }
}

/**
 * Runs one tool. Every answer also carries the caller's `runId` (when given), how long the tool
 * took (`ms`) and the window's size at the end (`window`), so reports from several sizes and
 * runs line up.
 */
export async function callSelfReportTool(
  name: string,
  input: unknown,
  bridge: SelfReportCaptureBridge | undefined,
): Promise<unknown> {
  const { runId, ...args } = asObject(input);
  const started = performance.now();
  const result = await runTool(name, args, bridge);
  // The desktop window's position, as the desktop app measures it (an acceptance run asserts
  // `offscreen` beside its own check). Absent outside the desktop app.
  const placement = await bridge?.placement?.().catch(() => undefined);
  return {
    ...result,
    ...(typeof runId === "string" || typeof runId === "number" ? { runId } : {}),
    ms: Math.round(performance.now() - started),
    window: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      ...(placement
        ? { left: placement.left, top: placement.top, offscreen: placement.offscreen }
        : {}),
    },
  };
}

interface ModelContextLike {
  readonly registerTool: (
    tool: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ) => unknown;
}

/** Whether this renderer offers the tools: a development build, or the desktop app said so. */
export function selfReportEnabled(target: Window = window): boolean {
  return target.desktopBridge?.selfReport?.enabled === true || import.meta.env.DEV === true;
}

/** Installs the tools on `target`. Returns a function that removes them again. */
export function installMossSelfReport(target: Window = window): () => void {
  const bridge = target.desktopBridge?.selfReport;
  const stopConsole = installConsoleCapture(target as unknown as ConsoleCaptureTarget);
  target.mossSelfReport = {
    version: SELF_REPORT_VERSION,
    tools: SELF_REPORT_TOOLS,
    call: (name, input) => callSelfReportTool(name, input, bridge),
  };
  const controller = new AbortController();
  const modelContext = (target.document as Document & { modelContext?: ModelContextLike })
    .modelContext;
  if (modelContext && typeof modelContext.registerTool === "function") {
    for (const tool of SELF_REPORT_TOOLS) {
      try {
        modelContext.registerTool(
          {
            ...tool,
            // The text comes from the page, which holds what people wrote.
            annotations: { readOnlyHint: true, untrustedContentHint: true },
            execute: (input: unknown) => callSelfReportTool(tool.name, input, bridge),
          },
          { signal: controller.signal },
        );
      } catch {
        // A browser that refuses one tool still gets the others, and the window global.
      }
    }
  }
  return () => {
    controller.abort();
    stopConsole();
    delete target.mossSelfReport;
  };
}

/** Called once at startup: installs the tools where they are enabled, nowhere else. */
export function installMossSelfReportIfEnabled(target: Window = window): (() => void) | null {
  return selfReportEnabled(target) ? installMossSelfReport(target) : null;
}
