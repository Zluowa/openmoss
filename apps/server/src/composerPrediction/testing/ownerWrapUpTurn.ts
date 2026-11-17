// FILE: ownerWrapUpTurn.ts
// Purpose: The owner's 2026-11-17 turn that got no suggested next message (round
//          20261117-owner-test, thread f22bee60): the closing message reads as finished work,
//          and the question was asked only through the turn-end box. Payloads as stored.
// Layer: Test fixture

/** The person's request. */
export const OWNER_REQUEST = "把我moss的聊天背景生成一个二次元美少女替换成透明通道的图";

/** The closing message: done, with links and the picture, and no question. */
export const OWNER_FINAL_REPLY =
  "已完成：透明通道已验证，并应用到 Moss 聊天区域右下角，浅色/深色主题都已生效。\n\n" +
  "- [原始透明 PNG](C:/Users/60948/Documents/Moss/2026-11-17/moss/outputs/moss-anime-girl-transparent.png)\n" +
  "- [Moss 轻量版 WebP](C:/Users/60948/Documents/Moss/2026-11-17/moss/outputs/moss-anime-girl-chat-bg.webp)\n\n" +
  "![Generated image](E:\\Codex\\.moss\\runtime\\cross-volume-overlays\\5ce6afd83b1f\\codex-home-overlay\\generated_images\\01a1e7c1-4de6-79d2-b03d-830dd5119c8a\\exec-98c98b54-7665-4fdc-b6e9-fe02edc92b99.png)";

export const OWNER_WRAP_UP_ASK = "现在的角色位置和大小合适吗？";
export const OWNER_WRAP_UP_ACTIONS = ["保持这样", "调整位置"] as const;

const OWNER_WRAP_UP_ARGUMENTS = {
  recap:
    "已生成原创二次元美少女透明图，并将轻量版应用到 Moss 聊天区域；原始 PNG 与 WebP 版已保存到 outputs。请在 Moss 聊天窗口看一下效果。",
  ask: OWNER_WRAP_UP_ASK,
  actions: OWNER_WRAP_UP_ACTIONS.map((label) => ({ label })),
};

/** The completed `moss_wrap_up` call as Codex stored it (`codex.mcp_tool_call`, no `detail`). */
export const OWNER_CODEX_WRAP_UP_ACTIVITY = {
  kind: "tool.completed",
  payload: {
    itemType: "mcp_tool_call",
    status: "completed",
    title: "Moss: Moss Wrap Up",
    data: {
      kind: "codex.mcp_tool_call",
      version: 1,
      callId: "exec-2346db5f-b299-479b-8c8f-90f7cfd49fc7",
      server: "moss",
      tool: "moss_wrap_up",
      status: "completed",
      durationMs: 5,
      arguments: OWNER_WRAP_UP_ARGUMENTS,
      result: {
        content: [
          {
            type: "text",
            text: '{\n  "shown": true,\n  "hasQuestion": true,\n  "note": "The box shows your recap, question and buttons. Write your closing message now; do not ask the question again."\n}',
          },
        ],
        structuredContent: null,
      },
      truncation: { truncated: false, deferredBinary: false },
    },
  },
} as const;

/** The same call in Claude's shape: a `detail` of `ToolName: {json}`. */
export const OWNER_CLAUDE_WRAP_UP_ACTIVITY = {
  kind: "tool.completed",
  payload: {
    itemType: "mcp_tool_call",
    status: "completed",
    title: "Moss Wrap Up",
    detail: `mcp__moss__moss_wrap_up: ${JSON.stringify(OWNER_WRAP_UP_ARGUMENTS)}`,
  },
} as const;
