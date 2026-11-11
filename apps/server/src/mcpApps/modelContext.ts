// FILE: modelContext.ts
// Purpose: `ui/update-model-context` for interactive connectors (SPEC §10, Claude's Code-tab
//   behaviour): a per-thread store keyed by tool name (last write wins), limits with Claude's error
//   texts, the snapshot taken when the person sends a message, the `<widget_context_hint>` appended
//   to that turn, and the answer of the gateway tool `moss_read_widget_context`.
// Layer: Server MCP Apps runtime (in-memory, process-lifetime)
// Exports: McpAppModelContextStore, MCP_APP_MODEL_CONTEXT_*, appendWidgetContextHint

import { checkStructuredContent } from "./toolUi.ts";

export const MCP_APP_MODEL_CONTEXT_TOKEN_LIMIT = 16_000;
/** Estimates are rough; Claude rejects only above 110 % of the limit. */
export const MCP_APP_MODEL_CONTEXT_HARD_TOKEN_LIMIT = 17_600;
export const MCP_APP_MODEL_CONTEXT_CHARS_PER_TOKEN = 4.5;
export const MCP_APP_MODEL_CONTEXT_MAX_BYTES_PER_VIEW = 917_504;
export const MCP_APP_MODEL_CONTEXT_STORE_MAX_CHARS = 33_554_432;
export const MCP_APP_READ_WIDGET_CONTEXT_TOOL = "moss_read_widget_context";

export type McpAppModelContextBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

interface StoredEntry {
  readonly toolName: string;
  readonly callId: string;
  readonly content: ReadonlyArray<McpAppModelContextBlock>;
  readonly chars: number;
  touchedAt: number;
}

/** Image size from the PNG / GIF / JPEG header, when it can be read cheaply. */
function imagePixels(base64: string): number | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64.slice(0, 64 * 1024), "base64");
  } catch {
    return undefined;
  }
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  }
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
    return bytes.readUInt16LE(6) * bytes.readUInt16LE(8);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return bytes.readUInt16BE(offset + 5) * bytes.readUInt16BE(offset + 7);
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

/** Token estimate: text chars / 4.5; images by pixel area (≈ w·h / 750, at least 85). */
export function estimateModelContextTokens(blocks: ReadonlyArray<McpAppModelContextBlock>): number {
  let tokens = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      tokens += block.text.length / MCP_APP_MODEL_CONTEXT_CHARS_PER_TOKEN;
    } else {
      const pixels = imagePixels(block.data);
      tokens += pixels === undefined ? 1_600 : Math.max(85, Math.min(pixels, 1_568 * 1_568) / 750);
    }
  }
  return Math.ceil(tokens);
}

export type ModelContextUpdate =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** Accepted blocks: text and image only (hostCapabilities.updateModelContext = {text, image}). */
export function normalizeModelContextBlocks(input: {
  readonly content?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly structuredContent?: Record<string, unknown> | undefined;
  readonly toolName: string;
}):
  | { readonly ok: true; readonly blocks: ReadonlyArray<McpAppModelContextBlock> }
  | { readonly ok: false; readonly message: string } {
  const blocks: McpAppModelContextBlock[] = [];
  for (const entry of input.content ?? []) {
    if (entry.type === "text" && typeof entry.text === "string") {
      blocks.push({ type: "text", text: entry.text });
    } else if (
      entry.type === "image" &&
      typeof entry.data === "string" &&
      typeof entry.mimeType === "string" &&
      entry.mimeType.startsWith("image/")
    ) {
      blocks.push({ type: "image", data: entry.data, mimeType: entry.mimeType });
    } else {
      return {
        ok: false,
        message: `ui/update-model-context accepts text and image content blocks only; got '${String(entry.type)}'.`,
      };
    }
  }
  if (input.structuredContent !== undefined) {
    const check = checkStructuredContent(input.toolName, input.structuredContent);
    if (!check.ok) return { ok: false, message: check.message };
    blocks.push({
      type: "text",
      text: `structuredContent: ${JSON.stringify(input.structuredContent)}`,
    });
  }
  return { ok: true, blocks };
}

function blockChars(blocks: ReadonlyArray<McpAppModelContextBlock>): number {
  return blocks.reduce(
    (total, block) => total + (block.type === "text" ? block.text.length : block.data.length),
    0,
  );
}

/** Builds the hint appended to the turn sent to the provider (never shown in the transcript). */
export function widgetContextHint(toolNames: ReadonlyArray<string>): string {
  return `<widget_context_hint>本对话中有可交互小组件：${toolNames.join("、")}。要读取某个小组件的当前状态，调用 ${MCP_APP_READ_WIDGET_CONTEXT_TOOL} 并传入它的 tool_name。</widget_context_hint>`;
}

/** Appends the hint to a provider turn; a slash command or empty input is left alone. */
export function appendWidgetContextHint(
  input: string | undefined,
  toolNames: ReadonlyArray<string>,
): string | undefined {
  if (toolNames.length === 0 || input === undefined) return input;
  if (input.trimStart().startsWith("/")) return input;
  return `${input}\n\n${widgetContextHint(toolNames)}`;
}

/** Per-thread `ui/update-model-context` state plus the last-send snapshots. */
export class McpAppModelContextStore {
  private readonly live = new Map<string, Map<string, StoredEntry>>();
  private readonly snapshots = new Map<string, ReadonlyMap<string, StoredEntry>>();
  private totalChars = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Records one widget's update; empty content clears that tool's entry. */
  update(input: {
    readonly threadId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly blocks: ReadonlyArray<McpAppModelContextBlock>;
  }): ModelContextUpdate {
    const tokens = estimateModelContextTokens(input.blocks);
    if (tokens > MCP_APP_MODEL_CONTEXT_HARD_TOKEN_LIMIT) {
      return {
        ok: false,
        message: `ui/update-model-context content is ~${tokens} tokens; host limit is ${MCP_APP_MODEL_CONTEXT_TOKEN_LIMIT} tokens.`,
      };
    }
    const bytes = Buffer.byteLength(JSON.stringify(input.blocks), "utf8");
    if (bytes > MCP_APP_MODEL_CONTEXT_MAX_BYTES_PER_VIEW) {
      return {
        ok: false,
        message: `ui/update-model-context content is ${bytes} bytes; host limit is ${MCP_APP_MODEL_CONTEXT_MAX_BYTES_PER_VIEW} bytes per app.`,
      };
    }
    const thread = this.live.get(input.threadId) ?? new Map<string, StoredEntry>();
    const previous = thread.get(input.toolName);
    if (previous) this.totalChars -= previous.chars;
    if (input.blocks.length === 0) {
      thread.delete(input.toolName);
    } else {
      const chars = blockChars(input.blocks);
      thread.set(input.toolName, {
        toolName: input.toolName,
        callId: input.callId,
        content: input.blocks,
        chars,
        touchedAt: this.now(),
      });
      this.totalChars += chars;
    }
    if (thread.size > 0) this.live.set(input.threadId, thread);
    else this.live.delete(input.threadId);
    this.evict();
    return { ok: true };
  }

  /** Drops what a failed call's widget shared (Claude: never given to the model). */
  dropCall(threadId: string, callId: string): void {
    const thread = this.live.get(threadId);
    if (!thread) return;
    for (const [toolName, entry] of thread) {
      if (entry.callId === callId) {
        this.totalChars -= entry.chars;
        thread.delete(toolName);
      }
    }
    if (thread.size === 0) this.live.delete(threadId);
  }

  /**
   * Called when the person sends a message: freezes what `moss_read_widget_context` answers until
   * the next send, and returns the tool names for the hint.
   */
  snapshotForSend(threadId: string): ReadonlyArray<string> {
    const thread = this.live.get(threadId);
    if (!thread || thread.size === 0) {
      this.snapshots.delete(threadId);
      return [];
    }
    this.snapshots.set(threadId, new Map(thread));
    return [...thread.keys()];
  }

  /** The `moss_read_widget_context` answer for one tool name. */
  readSnapshot(
    threadId: string,
    toolName: string,
  ): { readonly content: ReadonlyArray<McpAppModelContextBlock>; readonly isError?: true } {
    const snapshot = this.snapshots.get(threadId);
    if (!snapshot || snapshot.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "用户上次发送消息时，还没有小组件分享任何内容。在用户发送下一条消息之前，再次读取会得到相同的结果。",
          },
        ],
      };
    }
    const entry = snapshot.get(toolName);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `用户上次发送消息时，小组件 ${toolName} 没有分享内容。可读取的小组件：${[...snapshot.keys()].join("、")}。`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `以下是小组件 ${toolName} 在用户上次发送消息时分享的内容。在用户发送下一条消息之前，再次读取会得到相同的结果。`,
        },
        ...entry.content,
      ],
    };
  }

  forgetThread(threadId: string): void {
    const thread = this.live.get(threadId);
    for (const entry of thread?.values() ?? []) this.totalChars -= entry.chars;
    this.live.delete(threadId);
    this.snapshots.delete(threadId);
  }

  private evict(): void {
    while (this.totalChars > MCP_APP_MODEL_CONTEXT_STORE_MAX_CHARS) {
      let oldest: { threadId: string; entry: StoredEntry } | undefined;
      for (const [threadId, thread] of this.live) {
        for (const entry of thread.values()) {
          if (!oldest || entry.touchedAt < oldest.entry.touchedAt) oldest = { threadId, entry };
        }
      }
      if (!oldest) return;
      const thread = this.live.get(oldest.threadId)!;
      thread.delete(oldest.entry.toolName);
      this.totalChars -= oldest.entry.chars;
      if (thread.size === 0) this.live.delete(oldest.threadId);
    }
  }
}
