// FILE: webMcp.ts
// Purpose: Lists and calls the WebMCP tools a page in Moss's in-app browser registers
//          through `document.modelContext`, on behalf of an agent.
// Layer: Desktop browser automation (host side of WebMCP)
// Why: the page side (browserWebMcp/guestBridge.ts) kept working after BetterWright
//      replaced the browser automation (#1114), but nothing let an agent use it.
//      Restored from 35b3236ed..502b73f34 and fitted to the current host.

import { randomUUID } from "node:crypto";

import {
  type BrowserBoundedJson,
  type BrowserBoundedJsonObject,
  type BrowserTabId,
  type BrowserWebMcpCallInput,
  type BrowserWebMcpDiscoveryId,
  type BrowserWebMcpToolId,
  type BrowserWebMcpToolsInput,
  type BrowserWebMcpToolsOutput,
} from "@moss/contracts";
import type { WebContents } from "electron";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserAutomationHostError, browserHostError } from "./hostErrors";
import {
  abortReason,
  ensureCdpAttached,
  evaluateInContext,
  observePage,
  throwIfAborted,
} from "./cdpRuntime";

const WEB_MCP_BRIDGE_EXPRESSION = "globalThis.__mossWebMcpBridgeV1";
const MAX_DISCOVERED_TOOLS = 128;
const WEB_MCP_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;
// Discovery is model context, not a bulk transport. Keep enough room for
// several useful schemas without allowing one page to consume a large part of
// the turn context merely by advertising tools.
const MAX_DISCOVERY_CONTENT_BYTES = 20 * 1024;

interface BridgeTool {
  readonly index: number;
  readonly signature: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: BrowserBoundedJsonObject;
  readonly origin: string;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly consequentialHint: boolean;
    readonly untrustedContentHint: boolean;
  };
}

export interface WebMcpDiscoveryEntry {
  readonly toolId: BrowserWebMcpToolId;
  readonly index: number;
  readonly signature: string;
  readonly name: string;
  readonly origin: string;
  readonly consequential: boolean;
}

export interface WebMcpDiscoveryHandle {
  readonly discoveryId: BrowserWebMcpDiscoveryId;
  readonly tabId: string;
  readonly contextObjectId: string;
  readonly humanControlEpoch: number;
  readonly entries: ReadonlyMap<BrowserWebMcpToolId, WebMcpDiscoveryEntry>;
  readonly onInvalidated: (listener: () => void) => () => void;
  readonly release: () => Promise<void>;
}

interface WebMcpDiscovery {
  readonly output: BrowserWebMcpToolsOutput;
  readonly handle: WebMcpDiscoveryHandle | null;
}

export type WebMcpInvocationResult =
  | { readonly status: "completed"; readonly result: BrowserBoundedJson }
  | {
      readonly status: "failed";
      readonly error: { readonly name: string; readonly message: string };
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The bridge runs in the page's own world, so everything it returns is the page's word,
// and the page can replace the built-ins the bridge's own checks use. Every limit and
// every clean-up is applied again here, from what the host itself knows.
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const MAX_TITLE_BYTES = 1_024;
const MAX_DESCRIPTION_BYTES = 4_096;
const MAX_SCHEMA_BYTES = 16_384;
const MAX_JSON_DEPTH = 20;
/** Page tool results feed a model; well under the contract's 512 KiB per call. */
export const MAX_WEB_MCP_RESULT_BYTES = 65_536;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_MESSAGE_BYTES = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object" || depth > MAX_JSON_DEPTH) return depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.reduce<number>(
    (deepest, child) => Math.max(deepest, jsonDepth(child, depth + 1)),
    depth,
  );
}

/** Page text with control characters folded to spaces, within `maxBytes`; else null. */
function cleanText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").replace(/ {2,}/gu, " ").trim();
  return cleaned.length > 0 && utf8Bytes(cleaned) <= maxBytes ? cleaned : null;
}

/** A schema the host re-serialised itself: a plain object within the size and depth limits. */
function cleanSchema(value: unknown): BrowserBoundedJsonObject | null {
  if (asRecord(value) === null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (utf8Bytes(serialized) > MAX_SCHEMA_BYTES) return null;
  const copy = JSON.parse(serialized) as BrowserBoundedJsonObject;
  return jsonDepth(copy) <= MAX_JSON_DEPTH ? copy : null;
}

/**
 * The site a guest shows, from its own main-frame address. Only http(s) pages offer
 * page tools. Never taken from the page: a page can claim any origin in its tools.
 */
export function guestMainFrameOrigin(contents: WebContents): string | null {
  try {
    const url = new URL(contents.getURL());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** One page tool, re-checked on the host; null when it breaks a limit (counted as skipped). */
function toBridgeTool(value: unknown, origin: string): BridgeTool | null {
  const tool = asRecord(value);
  const annotations = asRecord(tool?.annotations);
  if (
    tool === null ||
    !Number.isSafeInteger(tool.index) ||
    (tool.index as number) < 0 ||
    (tool.index as number) >= MAX_DISCOVERED_TOOLS ||
    typeof tool.signature !== "string" ||
    !WEB_MCP_SIGNATURE_PATTERN.test(tool.signature) ||
    typeof tool.name !== "string" ||
    !TOOL_NAME_PATTERN.test(tool.name) ||
    annotations === null ||
    typeof annotations.readOnlyHint !== "boolean"
  ) {
    return null;
  }
  const description = cleanText(tool.description, MAX_DESCRIPTION_BYTES);
  const title = tool.title === undefined ? undefined : cleanText(tool.title, MAX_TITLE_BYTES);
  const inputSchema = cleanSchema(tool.inputSchema);
  if (description === null || title === null || inputSchema === null) return null;
  return {
    index: tool.index as number,
    signature: tool.signature,
    name: tool.name,
    ...(title === undefined ? {} : { title }),
    description,
    inputSchema,
    origin,
    annotations: {
      readOnlyHint: annotations.readOnlyHint,
      // Anything but an explicit `false` from the page keeps the tool consequential.
      consequentialHint: annotations.consequentialHint !== false,
      untrustedContentHint: true,
    },
  };
}

/**
 * A page tool runs without asking only when the page marked it read-only and
 * did not also mark it consequential. A tool with no hints is consequential.
 */
export function webMcpToolIsConsequential(annotations: {
  readonly readOnlyHint: boolean;
  readonly consequentialHint: boolean;
}): boolean {
  return !annotations.readOnlyHint || annotations.consequentialHint;
}

const queryTokens = (value: string): readonly string[] =>
  [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (token) => token.length > 1,
  );

function toolRelevance(tool: BridgeTool, query: string): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  const name = tool.name.toLocaleLowerCase();
  const title = tool.title?.toLocaleLowerCase() ?? "";
  const description = tool.description.toLocaleLowerCase();
  const schemaKeys = JSON.stringify(tool.inputSchema).toLocaleLowerCase();
  let score = name === normalizedQuery ? 100 : name.includes(normalizedQuery) ? 50 : 0;
  if (title.includes(normalizedQuery)) score += 30;
  if (description.includes(normalizedQuery)) score += 15;
  for (const token of queryTokens(normalizedQuery)) {
    if (name.includes(token)) score += 12;
    if (title.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
    if (schemaKeys.includes(token)) score += 2;
  }
  return score;
}

function unavailableOutput(
  runtime: BrowserAutomationVisibleRuntime,
  url: string,
): BrowserWebMcpToolsOutput {
  return {
    tabId: runtime.tabId as BrowserTabId,
    url,
    contentTrust: "untrusted-web-page",
    available: false,
    implementation: "unavailable",
    discoveryId: null,
    tools: [],
    totalToolCount: 0,
    skippedToolCount: 0,
    truncated: false,
  };
}

function createRemoteObjectRelease(
  runtime: BrowserAutomationVisibleRuntime,
  objectId: string,
): Pick<WebMcpDiscoveryHandle, "onInvalidated" | "release"> {
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const invalidationListeners = new Set<() => void>();
  const debuggerInstance = runtime.webContents.debugger;
  const onDebuggerMessage = (_event: unknown, method: string, rawParams: unknown) => {
    const params = asRecord(rawParams);
    const frame = asRecord(params?.frame);
    const mainFrameNavigated = method === "Page.frameNavigated" && frame && !frame.parentId;
    if (method === "Runtime.executionContextsCleared" || mainFrameNavigated) void release();
  };
  const onDebuggerDetach = () => void release();
  const onWebContentsDestroyed = () => void release();
  const detachLifecycleListeners = () => {
    debuggerInstance.removeListener("message", onDebuggerMessage);
    debuggerInstance.removeListener("detach", onDebuggerDetach);
    runtime.webContents.removeListener("destroyed", onWebContentsDestroyed);
  };
  const release = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    if (released) return Promise.resolve();
    released = true;
    detachLifecycleListeners();
    for (const listener of invalidationListeners) listener();
    invalidationListeners.clear();
    releasePromise =
      runtime.webContents.isDestroyed() || !debuggerInstance.isAttached()
        ? Promise.resolve()
        : debuggerInstance.sendCommand("Runtime.releaseObject", { objectId }).then(
            () => undefined,
            () => undefined,
          );
    return releasePromise;
  };
  debuggerInstance.on("message", onDebuggerMessage);
  debuggerInstance.on("detach", onDebuggerDetach);
  runtime.webContents.once("destroyed", onWebContentsDestroyed);
  return {
    release,
    onInvalidated: (listener) => {
      if (released) {
        listener();
        return () => undefined;
      }
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
  };
}

/**
 * Calls the page's bridge and stops waiting when `signal` aborts. A page can keep a
 * promise pending for ever; waiting for it here would hold the tab and visibility locks
 * and block every later browser call of the chat. On abort the page is told to cancel
 * (`onAbort`) and the call is abandoned: its CDP reply, if one ever comes, is ignored.
 * `userGesture` gives the page user activation (popups, file pickers, fullscreen): only
 * a call the person approved gets it.
 */
async function callBridge(
  runtime: BrowserAutomationVisibleRuntime,
  objectId: string,
  functionDeclaration: string,
  args: ReadonlyArray<unknown>,
  options: {
    readonly signal: AbortSignal;
    readonly userGesture: boolean;
    readonly onAbort?: () => Promise<void>;
  },
): Promise<unknown> {
  throwIfAborted(options.signal);
  ensureCdpAttached(runtime.webContents);
  const command = runtime.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    awaitPromise: true,
    returnByValue: true,
    userGesture: options.userGesture,
    arguments: args.map((value) => ({ value })),
  }) as Promise<{
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: unknown;
  }>;
  const response = await new Promise<Awaited<typeof command>>((resolve, reject) => {
    const onAbort = () => {
      if (options.onAbort) void options.onAbort().catch(() => undefined);
      reject(abortReason(options.signal));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    command.then(
      (value) => {
        options.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        options.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
  if (response.exceptionDetails || !response.result) {
    throw new Error("The page's WebMCP bridge threw.");
  }
  return response.result.value;
}

export async function discoverWebMcpTools(
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserWebMcpToolsInput,
  humanControlEpoch: number,
  signal: AbortSignal,
): Promise<WebMcpDiscovery> {
  throwIfAborted(signal);
  const page = await observePage(runtime, signal);
  const origin = guestMainFrameOrigin(runtime.webContents);
  if (origin === null) return { output: unavailableOutput(runtime, page.url), handle: null };
  let contextObjectId: string | undefined;
  try {
    const bridge = await evaluateInContext(runtime, WEB_MCP_BRIDGE_EXPRESSION, {
      awaitPromise: false,
      returnByValue: false,
      effectMayHaveCommitted: false,
      signal,
    });
    contextObjectId = bridge.objectId;
  } catch (error) {
    if (error instanceof BrowserAutomationHostError) throw error;
  }
  if (!contextObjectId) {
    return { output: unavailableOutput(runtime, page.url), handle: null };
  }
  const lease = createRemoteObjectRelease(runtime, contextObjectId);

  let rawList: unknown;
  try {
    // Listing is not consent: the page gets no user activation from it.
    rawList = await callBridge(
      runtime,
      contextObjectId,
      "async function() { return await this.list(); }",
      [],
      { signal, userGesture: false },
    );
  } catch (error) {
    await lease.release();
    if (error instanceof BrowserAutomationHostError || signal.aborted) throw error;
    return { output: unavailableOutput(runtime, page.url), handle: null };
  }
  const list = asRecord(rawList);
  if (!list || list.available !== true || !Array.isArray(list.tools)) {
    await lease.release();
    return { output: unavailableOutput(runtime, page.url), handle: null };
  }
  const bridgeTools = list.tools
    .slice(0, MAX_DISCOVERED_TOOLS)
    .map((tool) => toBridgeTool(tool, origin))
    .filter((tool): tool is BridgeTool => tool !== null);
  const skippedToolCount = Math.min(
    1_000_000,
    (typeof list.skippedToolCount === "number" && Number.isSafeInteger(list.skippedToolCount)
      ? Math.max(0, list.skippedToolCount)
      : 0) +
      (list.tools.length - bridgeTools.length),
  );
  const query = input.query ?? "";
  const ranked = bridgeTools
    .map((tool, order) => ({ tool, order, score: toolRelevance(tool, query) }))
    .toSorted((left, right) => right.score - left.score || left.order - right.order);
  const discoveryId = randomUUID() as BrowserWebMcpDiscoveryId;
  const entries = new Map<BrowserWebMcpToolId, WebMcpDiscoveryEntry>();
  const tools: BrowserWebMcpToolsOutput["tools"][number][] = [];
  let contentBytes = 0;
  for (const { tool } of ranked) {
    if (tools.length >= (input.limit ?? 8)) break;
    const consequential = webMcpToolIsConsequential(tool.annotations);
    const exposedTool = {
      toolId: `w${tools.length + 1}` as BrowserWebMcpToolId,
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      origin: tool.origin,
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        consequentialHint: consequential,
        untrustedContentHint: true,
      },
    };
    const toolBytes = Buffer.byteLength(JSON.stringify(exposedTool), "utf8");
    if (contentBytes + toolBytes > MAX_DISCOVERY_CONTENT_BYTES) continue;
    contentBytes += toolBytes;
    tools.push(exposedTool);
    entries.set(exposedTool.toolId, {
      toolId: exposedTool.toolId,
      index: tool.index,
      signature: tool.signature,
      name: tool.name,
      origin: tool.origin,
      consequential,
    });
  }
  const implementation = list.implementation === "native" ? "native" : "compatibility";
  return {
    output: {
      tabId: runtime.tabId as BrowserTabId,
      url: page.url,
      contentTrust: "untrusted-web-page",
      available: true,
      implementation,
      discoveryId,
      tools,
      totalToolCount: bridgeTools.length,
      skippedToolCount,
      truncated: tools.length < bridgeTools.length || skippedToolCount > 0,
    },
    handle: {
      discoveryId,
      tabId: runtime.tabId,
      contextObjectId,
      humanControlEpoch,
      entries,
      ...lease,
    },
  };
}

/**
 * Keeps animation frames and timers running on one guest while a page tool
 * runs. Page libraries wait for `requestAnimationFrame` between steps (UI SDK's
 * `act` does), and a guest whose pane is hidden or whose window is minimised is
 * throttled until frames stop. Only this guest changes, only for the call; the
 * returned function restores the guest's own setting and is safe to call twice.
 */
export function keepGuestFramesRunning(contents: WebContents): () => void {
  if (contents.isDestroyed()) return () => undefined;
  const throttled = contents.getBackgroundThrottling();
  if (!throttled) return () => undefined;
  contents.setBackgroundThrottling(false);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
  };
}

/** A page tool's result within the host's own size and depth limits, else a failure. */
function checkedResult(value: unknown): WebMcpInvocationResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return {
      status: "failed",
      error: { name: "WebMcpResultInvalid", message: "The page tool returned no JSON value." },
    };
  }
  if (utf8Bytes(serialized) > MAX_WEB_MCP_RESULT_BYTES) {
    return {
      status: "failed",
      error: {
        name: "WebMcpResultTooLarge",
        message: "The page-declared WebMCP tool returned more than 64 KiB of JSON.",
      },
    };
  }
  const copy = JSON.parse(serialized) as BrowserBoundedJson;
  if (jsonDepth(copy) > MAX_JSON_DEPTH) {
    return {
      status: "failed",
      error: {
        name: "WebMcpResultTooDeep",
        message: "The page-declared WebMCP tool returned JSON deeper than 20 levels.",
      },
    };
  }
  return { status: "completed", result: copy };
}

export async function invokeWebMcpTool(
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserWebMcpCallInput,
  handle: WebMcpDiscoveryHandle,
  signal: AbortSignal,
): Promise<WebMcpInvocationResult & { readonly entry: WebMcpDiscoveryEntry }> {
  const entry = handle.entries.get(input.toolId);
  if (
    !entry ||
    handle.discoveryId !== input.discoveryId ||
    handle.tabId !== runtime.tabId ||
    // The agent names the site it means to act on, and the guest must still show
    // that site now (its own address, never the page's word).
    entry.origin !== input.origin ||
    guestMainFrameOrigin(runtime.webContents) !== entry.origin
  ) {
    browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
  }
  const invocationId = randomUUID();
  const cancel = async () => {
    if (runtime.webContents.isDestroyed() || !runtime.webContents.debugger.isAttached()) return;
    const expression = `${WEB_MCP_BRIDGE_EXPRESSION}?.cancel(${JSON.stringify(invocationId)})`;
    await runtime.webContents.debugger
      .sendCommand("Runtime.evaluate", {
        expression,
        awaitPromise: false,
        returnByValue: true,
        userGesture: false,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  };
  const restoreThrottling = keepGuestFramesRunning(runtime.webContents);
  let value: unknown;
  try {
    value = await callBridge(
      runtime,
      handle.contextObjectId,
      "async function(index, signature, inputJson, invocationId) { return await this.invoke(index, signature, inputJson, invocationId); }",
      [entry.index, entry.signature, JSON.stringify(input.arguments ?? {}), invocationId],
      // Only a consequential call, which the person approved (or Full access allowed),
      // acts with user activation; a read-only call never needs a popup or a picker.
      { signal, userGesture: entry.consequential, onAbort: cancel },
    );
  } catch (error) {
    if (error instanceof BrowserAutomationHostError || signal.aborted) throw error;
    // The command reached the page: the tool may have acted before the failure.
    browserHostError({ code: "BrowserAmbiguousResult", tabId: runtime.tabId as BrowserTabId });
  } finally {
    // Restored on success, page error, cancellation and timeout alike, including
    // when the page never answers: the host stops waiting at its deadline.
    restoreThrottling();
  }
  const result = asRecord(value);
  if (result?.status === "stale") {
    browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
  }
  if (result?.status === "completed") {
    return { ...checkedResult(result.result ?? null), entry };
  }
  const error = asRecord(result?.error);
  if (result?.status === "failed" && error !== null) {
    return {
      status: "failed",
      error: {
        name: cleanText(error.name, MAX_ERROR_NAME_BYTES) ?? "WebMcpToolError",
        message:
          cleanText(error.message, MAX_ERROR_MESSAGE_BYTES) ??
          "The page-declared WebMCP tool failed.",
      },
      entry,
    };
  }
  browserHostError({
    code: "BrowserMalformedResponse",
    retryable: false,
    phase: "runtime",
    effectMayHaveCommitted: true,
    tabId: runtime.tabId as BrowserTabId,
  });
}
