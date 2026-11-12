// FILE: pageAiText.ts
// Purpose: Moss's words for the page AI host pieces (composer, quick actions, notices) in the
//          page's language, matching the page editor's own copy.
// Layer: Page AI (web)

export type PageAiLocale = "zh-CN" | "en";

/** Follows the UI language the localization provider publishes on <html data-moss-locale>. */
export function pageAiLocale(): PageAiLocale {
  const declared =
    typeof document === "undefined" ? undefined : document.documentElement.dataset.mossLocale;
  return declared && !declared.toLowerCase().startsWith("zh") ? "en" : "zh-CN";
}

/** One row of the page insert menu; `value` is the editor's id for the same item. */
export interface PageInsertMenuItem {
  readonly value: string;
  readonly icon: string;
  readonly label: string;
  readonly description?: string;
  readonly shortcut?: string;
}
export interface PageInsertMenuSection {
  readonly title: string;
  readonly items: readonly PageInsertMenuItem[];
}

const zh = {
  insertMenu: [
    {
      title: "生成",
      items: [
        {
          value: "page_ai_generate",
          icon: "sparkles-two",
          label: "生成",
          description: "写一段新内容",
        },
        {
          value: "page_ai_visualize",
          icon: "layout-grid-2",
          label: "创建可视化",
          description: "做个图表或小工具",
        },
      ],
    },
    {
      title: "新建",
      items: [
        {
          value: "page_subpage",
          icon: "page-text-add",
          label: "子页面",
          description: "在这一页下面新建",
        },
      ],
    },
    {
      title: "媒体",
      items: [
        {
          value: "page_ai_image",
          icon: "images-1",
          label: "图像",
          description: "用图片卡生成，或上传一张",
        },
        {
          value: "page_ai_video",
          icon: "video-2",
          label: "视频",
          description: "用视频卡生成一段视频",
        },
        { value: "page_file", icon: "paperclip-1", label: "文件", description: "附上一个文件" },
      ],
    },
    {
      title: "基础",
      items: [
        { value: "moss_instructions", icon: "robot", label: "助手说明" },
        { value: "h1", icon: "headline", label: "一级标题", shortcut: "#" },
        { value: "h2", icon: "headline", label: "二级标题", shortcut: "##" },
        { value: "h3", icon: "headline", label: "三级标题", shortcut: "###" },
        { value: "disc", icon: "list-bullets", label: "无序列表", shortcut: "-" },
        { value: "decimal", icon: "numbered-list", label: "有序列表", shortcut: "1." },
        { value: "todo", icon: "checklist", label: "待办清单", shortcut: "[]" },
        { value: "blockquote", icon: "bubble-quotes", label: "引用", shortcut: ">" },
        { value: "code_block", icon: "code-brackets", label: "代码块", shortcut: "```" },
        { value: "equation", icon: "math-scientific", label: "数学公式" },
        { value: "table", icon: "table", label: "表格" },
        { value: "hr", icon: "divider", label: "分隔线", shortcut: "---" },
        { value: "page_link", icon: "page-link", label: "页面链接" },
        { value: "moss_prompt", icon: "prompt", label: "提示" },
        { value: "callout", icon: "light-bulb", label: "强调块" },
      ],
    },
    {
      title: "提及",
      items: [
        { value: "mention_page", icon: "page-text", label: "页面" },
        { value: "mention_file", icon: "file-text", label: "文件" },
        { value: "mention_chat", icon: "bubble-text", label: "聊天" },
      ],
    },
  ] as PageInsertMenuSection[],
  composerPlaceholder: "让智能体处理这一页…",
  composerLabel: "让智能体处理此页面",
  send: "发送",
  generate: "生成",
  image: "图像",
  visualize: "可视化",
  subpage: "子页面",
  insert: "插入",
  workingFor: (seconds: number) => `处理中 · ${seconds} 秒`,
  doneIn: (seconds: number) => `已完成 · 用时 ${seconds} 秒`,
  untitledChat: "新对话",
  /** The page's assistant chat is named after the page. */
  pageChatTitle: (title: string) => title || "未命名页面",
  noAgent: "还没有可用的智能体。先在 Moss 里连接一个，再回到这里。",
  saveFirst: "页面还没保存好，请稍后再试。",
  runFailed: "智能体没能开始处理",
  resolveFailed: "没能记录这次审阅",
  uploadFailed: "上传失败",
  uploadNoPreview: "文件已放进资料库，但无法在页面里显示。",
  appPageSoon: "应用页即将上线",
  starting: "正在交给智能体…",
  running: "智能体正在处理…",
  drafted: "已写好，等你审阅",
  done: "智能体已完成，修改建议在页面里等你审阅",
  failed: "没有完成",
  failedAgentOff: "这个智能体在设置里关掉了。打开它，或换一个智能体再试。",
  failedSignIn: "智能体需要先登录。登录后再试。",
  failedSlow: "智能体启动太久，没有响应。稍后再试，或查看对话里的详情。",
  failedOther: "智能体没能完成。查看对话里的详情，或再试一次。",
  openChat: "查看对话",
};
type Text = typeof zh;
const en: Text = {
  insertMenu: [
    {
      title: "Generate",
      items: [
        {
          value: "page_ai_generate",
          icon: "sparkles-two",
          label: "Generate",
          description: "Write something new",
        },
        {
          value: "page_ai_visualize",
          icon: "layout-grid-2",
          label: "Create visualization",
          description: "A chart or a small tool",
        },
      ],
    },
    {
      title: "New",
      items: [
        {
          value: "page_subpage",
          icon: "page-text-add",
          label: "Subpage",
          description: "A new page under this one",
        },
      ],
    },
    {
      title: "Media",
      items: [
        {
          value: "page_ai_image",
          icon: "images-1",
          label: "Image",
          description: "Generate with the image card, or upload one",
        },
        {
          value: "page_ai_video",
          icon: "video-2",
          label: "Video",
          description: "Generate a clip with the video card",
        },
        { value: "page_file", icon: "paperclip-1", label: "File", description: "Attach a file" },
      ],
    },
    {
      title: "Basics",
      items: [
        { value: "moss_instructions", icon: "robot", label: "Assistant instructions" },
        { value: "h1", icon: "headline", label: "Heading 1", shortcut: "#" },
        { value: "h2", icon: "headline", label: "Heading 2", shortcut: "##" },
        { value: "h3", icon: "headline", label: "Heading 3", shortcut: "###" },
        { value: "disc", icon: "list-bullets", label: "Bulleted list", shortcut: "-" },
        { value: "decimal", icon: "numbered-list", label: "Numbered list", shortcut: "1." },
        { value: "todo", icon: "checklist", label: "To-do list", shortcut: "[]" },
        { value: "blockquote", icon: "bubble-quotes", label: "Quote", shortcut: ">" },
        { value: "code_block", icon: "code-brackets", label: "Code block", shortcut: "```" },
        { value: "equation", icon: "math-scientific", label: "Math" },
        { value: "table", icon: "table", label: "Table" },
        { value: "hr", icon: "divider", label: "Divider", shortcut: "---" },
        { value: "page_link", icon: "page-link", label: "Page link" },
        { value: "moss_prompt", icon: "prompt", label: "Prompt" },
        { value: "callout", icon: "light-bulb", label: "Highlight" },
      ],
    },
    {
      title: "Mention",
      items: [
        { value: "mention_page", icon: "page-text", label: "Page" },
        { value: "mention_file", icon: "file-text", label: "File" },
        { value: "mention_chat", icon: "bubble-text", label: "Chat" },
      ],
    },
  ] as PageInsertMenuSection[],
  composerPlaceholder: "Ask an agent about this page…",
  composerLabel: "Ask an agent to work on this page",
  send: "Send",
  generate: "Generate",
  image: "Image",
  visualize: "Visualize",
  subpage: "Subpage",
  insert: "Insert",
  workingFor: (seconds: number) => `Working · ${seconds}s`,
  doneIn: (seconds: number) => `Done in ${seconds}s`,
  untitledChat: "New chat",
  pageChatTitle: (title: string) => title || "Untitled page",
  noAgent: "No agent is available yet. Connect one in Moss, then come back.",
  saveFirst: "The page has not finished saving. Try again in a moment.",
  runFailed: "The agent could not start",
  resolveFailed: "Could not record this review",
  uploadFailed: "Upload failed",
  uploadNoPreview: "The file is in your library but cannot be shown in the page.",
  appPageSoon: "App pages are coming soon",
  starting: "Handing it to the agent…",
  running: "The agent is working…",
  drafted: "Written; ready for your review",
  done: "Done. Suggested changes are waiting in the page",
  failed: "Did not finish",
  failedAgentOff:
    "This agent is turned off in Settings. Turn it on, or pick another agent, and try again.",
  failedSignIn: "The agent needs you to sign in first. Sign in, then try again.",
  failedSlow:
    "The agent took too long to start. Try again in a moment, or see the chat for details.",
  failedOther: "The agent couldn't finish. See the chat for details, or try again.",
  openChat: "Open chat",
};

export const pageAiText = (locale: PageAiLocale): Text => (locale === "en" ? en : zh);

/**
 * What a page shows when a run fails. Moss's own messages are already written for people and
 * pass through; an agent's or provider's technical error becomes a plain sentence that says
 * what to do (its full text stays in the chat).
 */
export function pageAiErrorText(raw: string | undefined, text: Text): string {
  const message = raw?.trim() ?? "";
  const technical =
    !message ||
    /^\w*Error\b|\bat <anonymous>|Provider|adapter|validation|thread\.|RPC|ECONN|\{/u.test(
      message,
    ) ||
    (text === zh && !/[\u4e00-\u9fff]/u.test(message));
  if (!technical) return message;
  if (/disabled in Settings|is disabled/iu.test(message)) return text.failedAgentOff;
  if (/sign.?in|log.?in|unauthenticated|needsLogin|401/iu.test(message)) return text.failedSignIn;
  if (/timed? ?out|timeout|deadline|did not respond/iu.test(message)) return text.failedSlow;
  return text.failedOther;
}
