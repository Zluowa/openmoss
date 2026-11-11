// FILE: hostContext.ts
// Purpose: Build the widget host context (SPEC §5, SPEC-protocol §3.5) and deliver its
//          changes as diffs only, never before the widget says it is initialized.
// Layer: Web MCP App host protocol
// Exports: buildMcpAppHostContext, McpAppHostContextChannel, diffMcpAppHostContext,
//          MCP_APP_HOST_INFO_NAME

import type { McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { MCP_APP_INLINE_MAX_HEIGHT } from "./constants";

export const MCP_APP_HOST_INFO_NAME = "Moss";

export interface McpAppHostContextInput {
  readonly theme: "light" | "dark";
  readonly locale: string;
  readonly styles: NonNullable<McpUiHostContext["styles"]>;
  readonly displayMode: "inline" | "fullscreen";
  readonly paneAvailable: boolean;
  readonly width: number;
  readonly height: number;
  readonly callId: string;
  readonly tool: Tool;
  readonly environment?: {
    readonly timeZone?: string;
    readonly userAgent?: string;
    readonly touch?: boolean;
    readonly hover?: boolean;
  };
}

function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** The complete host context, keys in Claude's build order. */
export function buildMcpAppHostContext(input: McpAppHostContextInput): McpUiHostContext {
  const environment = input.environment ?? {};
  const availableDisplayModes: McpUiDisplayMode[] = input.paneAvailable
    ? ["inline", "fullscreen"]
    : ["inline"];
  return {
    theme: input.theme,
    locale: input.locale,
    timeZone: environment.timeZone ?? readTimeZone(),
    userAgent:
      environment.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent),
    platform: "desktop",
    deviceCapabilities: {
      touch: environment.touch ?? mediaMatches("(pointer: coarse)"),
      hover: environment.hover ?? mediaMatches("(hover: hover)"),
    },
    availableDisplayModes,
    styles: input.styles,
    displayMode: input.displayMode,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    containerDimensions:
      input.displayMode === "fullscreen"
        ? { width: dimension(input.width), height: dimension(input.height) }
        : { width: dimension(input.width), maxHeight: MCP_APP_INLINE_MAX_HEIGHT },
    toolInfo: { id: input.callId, tool: input.tool },
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b)),
      );
    }
    return entry;
  });
}

/** Keys whose JSON differs between two contexts. */
export function diffMcpAppHostContext(
  previous: McpUiHostContext,
  next: McpUiHostContext,
): Partial<McpUiHostContext> {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (stableJson(previous[key]) !== stableJson(next[key])) changed[key] = next[key];
  }
  return changed as Partial<McpUiHostContext>;
}

/**
 * Holds the context the widget knows about and the latest one. Before `initialized` nothing is
 * sent (the latest context is what `ui/initialize` returns); afterwards every change is sent as
 * one diff against what the widget last saw.
 */
export class McpAppHostContextChannel {
  private current: McpUiHostContext;
  private known: McpUiHostContext | null = null;
  private live = false;

  constructor(
    initial: McpUiHostContext,
    private readonly send: (diff: Partial<McpUiHostContext>) => void,
  ) {
    this.current = initial;
  }

  /** The context `ui/initialize` answers with. */
  snapshot(): McpUiHostContext {
    return this.current;
  }

  /** The widget asked `ui/initialize`; it now knows the current context. */
  markInitializeAnswered(): void {
    this.known = this.current;
  }

  /** The widget said `initialized`; send whatever changed since it was answered. */
  markInitialized(): void {
    if (this.live) return;
    this.live = true;
    this.known ??= this.current;
    this.flush();
  }

  update(partial: Partial<McpUiHostContext>): void {
    this.current = { ...this.current, ...partial };
    if (this.live) this.flush();
  }

  private flush(): void {
    const known = this.known ?? this.current;
    const diff = diffMcpAppHostContext(known, this.current);
    this.known = this.current;
    if (Object.keys(diff).length > 0) this.send(diff);
  }
}
