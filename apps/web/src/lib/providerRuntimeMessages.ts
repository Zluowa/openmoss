// FILE: providerRuntimeMessages.ts
// Purpose: Localize known provider task/runtime copy without rewriting diagnostics or identifiers.
// Layer: Web presentation helper
// Exports: narrow provider runtime-message normalization and localization

import type { MossLocaleCode } from "../appSettings";

export const PERSONAL_CODEX_USAGE_LIMIT_MESSAGE =
  "Your personal Codex usage limit has been reached. Open ChatGPT Codex usage to buy credits, wait for the reset, or switch providers.";

const RAW_PERSONAL_CODEX_USAGE_LIMIT_PATTERN =
  /(?:\byou(?:'|’)?ve\s+hit\s+your\s+usage\s+limit\b|chatgpt\.com\/codex\/settings\/usage[\s\S]*\bpurchase\s+more\s+credits\b)/iu;

// Codex drops the config's speed tier for a model that does not offer it and
// says so in protocol terms; the row says what that means for this chat.
const RAW_CODEX_UNSUPPORTED_SERVICE_TIER_PATTERN =
  /^Configured service tier `([^`\r\n]+)` is not advertised as supported for model `([^`\r\n]+)` and will be omitted from requests\.$/u;
const CODEX_UNSUPPORTED_SERVICE_TIER_PATTERN =
  /^(\S+) doesn't offer the "([^"\r\n]+)" speed set in your Codex config, so it runs at standard speed\.$/u;

function codexUnsupportedServiceTierMessage(tier: string, model: string): string {
  return `${model} doesn't offer the "${tier}" speed set in your Codex config, so it runs at standard speed.`;
}

// What the server says when a provider session comes back without its own
// history (ProviderCommandReactor's context-lifecycle notices).
const ZH_CN_CONTEXT_LIFECYCLE_MESSAGES: Readonly<Record<string, string>> = {
  "The session restarted without its previous history.": "会话已重新启动，之前的对话记录没有带上。",
  "The session's history was unavailable for this turn.": "这一轮没能读取到会话的历史记录。",
  "The session was restarted, so your message included a summary.":
    "会话已重新启动，你的消息附上了之前对话的摘要。",
  "The session's history was lost, so the model continues from a summary.":
    "会话的历史记录丢失了，模型会根据摘要继续。",
  "Your message included a summary while the session recovered its context.":
    "会话正在恢复上下文，你的消息附上了之前对话的摘要。",
  "The turn could not be stopped cleanly, so the session was restarted.":
    "这一轮没能正常停止，会话已重新启动。",
  "The turn could not be stopped cleanly, so the session was restarted and your message included a summary.":
    "这一轮没能正常停止，会话已重新启动，你的消息附上了摘要。",
  "This fork starts from an earlier turn, so the model continues from the transcript up to that turn.":
    "这个分支从较早的一轮开始，模型会接着那一轮之前的对话继续。",
  "This fork starts from an earlier turn without the source session's history.":
    "这个分支从较早的一轮开始，没有带上原会话的历史记录。",
};

function localizeSummaryDisclosure(disclosure: string): string {
  return disclosure
    .split("; ")
    .map((part) =>
      part
        .replace(/^(\d+) messages? omitted$/u, "省略了 $1 条消息")
        .replace(/^(\d+) messages? shortened$/u, "缩短了 $1 条消息"),
    )
    .join("；");
}

const ZH_CN_EXACT_MESSAGES: Readonly<Record<string, string>> = {
  ...ZH_CN_CONTEXT_LIFECYCLE_MESSAGES,
  // Context-compaction rows are provider runtime records rendered by
  // TimelineWorkEntryRow, so they must be localized at this seam rather than
  // only in the UI-copy helper used by command and toast builders.
  "Compacting context": "正在压缩上下文",
  "Context compacted": "上下文已压缩",
  "Context automatically compacting": "正在自动压缩上下文",
  "Context automatically compacted": "上下文已自动压缩",
  "Optimizing the conversation": "正在优化对话",
  "Optimized the conversation": "已优化对话",
  "Manual context compaction failed": "手动压缩上下文失败",
  "Automatic context compaction failed": "自动压缩上下文失败",
  "Context compaction cancelled": "已取消压缩上下文",
  "Runtime warning": "运行提示",
  "Provider retrying": "正在重试",
  "Provider task stop failed": "停止服务商任务失败",
  "Provider task background failed": "将服务商任务转入后台失败",
  "No active provider session is bound to this thread.": "此线程未绑定活动的服务商会话。",
  "No active provider session with workspace cwd is bound to this thread.":
    "此线程未绑定含工作区目录的活动服务商会话。",
  "The Moss model gateway is rate limiting requests right now. Try again in a moment.":
    "Moss 当前请求较多，请稍后再试。",
  "Moss model service is temporarily unavailable. Try again shortly.":
    "Moss 模型服务暂时不可用，请稍后再试。",
  "The provider could not complete this request. Try again shortly.":
    "服务商暂时无法完成此请求，请稍后重试。",
  "Please run grok login": "请运行 grok login",
  "(empty response)": "没有返回内容",
  "The model finished without returning visible text.": "模型已结束，但没有返回可见内容。",
  "Your Moss package usage allowance is exhausted.": "套餐额度已用完。",
  "Moss account quota is exhausted for this period. Top up your plan or wait for the quota to reset.":
    "本周期的 Moss 使用额度已用完，请升级套餐或等待额度重置。",
  "The current Moss account does not have model access. Sign in again; if this continues, contact support.":
    "当前 Moss 账号没有模型使用权限。请重新登录；若仍然出现，请联系支持。",
  [PERSONAL_CODEX_USAGE_LIMIT_MESSAGE]:
    "个人 Codex 使用额度已达上限。请在 ChatGPT Codex 用量页购买额度、等待重置，或切换服务商。",
};

interface ProviderRuntimeTemplate {
  readonly pattern: RegExp;
  readonly localize: (match: RegExpExecArray) => string;
}

const ZH_CN_TEMPLATE_MESSAGES: readonly ProviderRuntimeTemplate[] = [
  {
    // "Summary: 2 messages omitted; 1 message shortened. <notice>"
    pattern: /^Summary: ((?:\d+ messages? (?:omitted|shortened)(?:; )?)+)\. (.+)$/u,
    localize: (match) => {
      const notice = match[2] ?? "";
      return `摘要：${localizeSummaryDisclosure(match[1] ?? "")}。${ZH_CN_CONTEXT_LIFECYCLE_MESSAGES[notice] ?? notice}`;
    },
  },
  {
    pattern: /^Subagent '([^'\r\n]+)' already finished; the message was not delivered\.$/u,
    localize: (match) => `子代理 '${match[1]}' 已结束；消息未发送。`,
  },
  {
    pattern: /^Failed to stop subagent task '([^'\r\n]+)'\.$/u,
    localize: (match) => `停止子代理任务 '${match[1]}' 失败。`,
  },
  {
    pattern:
      /^Cannot stop provider task '([^'\r\n]+)' because the provider runtime is not active\.$/u,
    localize: (match) => `无法停止服务商任务 '${match[1]}'，因为服务商运行时未处于活动状态。`,
  },
  {
    pattern: /^Provider '([^'\r\n]+)' does not support stopping a provider task\.$/u,
    localize: (match) => `服务商 '${match[1]}' 不支持停止服务商任务。`,
  },
  {
    pattern:
      /^Cannot background provider task '([^'\r\n]+)' because the provider runtime is not active\.$/u,
    localize: (match) =>
      `无法将服务商任务 '${match[1]}' 转入后台，因为服务商运行时未处于活动状态。`,
  },
  {
    pattern: /^Provider '([^'\r\n]+)' does not support backgrounding a provider task\.$/u,
    localize: (match) => `服务商 '${match[1]}' 不支持将服务商任务转入后台。`,
  },
  {
    pattern:
      /^Cannot message subagent '([^'\r\n]+)' because the provider runtime is not active\.$/u,
    localize: (match) => `无法向子代理 '${match[1]}' 发送消息，因为服务商运行时未处于活动状态。`,
  },
  {
    pattern: /^Provider '([^'\r\n]+)' does not support messaging a running subagent\.$/u,
    localize: (match) => `服务商 '${match[1]}' 不支持向运行中的子代理发送消息。`,
  },
  {
    pattern:
      /^The Moss model gateway is rate limiting requests right now\. Try again in about ([^\r\n]+)\.$/u,
    localize: (match) => `Moss 当前请求较多，请约 ${match[1]} 后重试。`,
  },
  {
    pattern:
      /^Moss account quota is exhausted for this period\. Top up your plan, or try again in about ([^\r\n]+)\.$/u,
    localize: (match) => `本周期的 Moss 使用额度已用完，请升级套餐，或约 ${match[1]} 后重试。`,
  },
  {
    pattern:
      /^exceeded retry limit, last status:\s*429 Too Many Requests(?:,\s*request id:\s*[^\r\n]+)?$/iu,
    localize: () => "Moss 当前请求较多，请稍后再试。",
  },
  {
    pattern: /^(\d+) tasks: ([^\r\n]+)$/u,
    localize: (match) => `${match[1]} 个任务：${match[2]}`,
  },
  {
    pattern: CODEX_UNSUPPORTED_SERVICE_TIER_PATTERN,
    localize: (match) => `${match[1]} 不支持 Codex 配置里的“${match[2]}”速度，本次按标准速度运行。`,
  },
];

export function normalizeProviderRuntimeMessage(message: string): string {
  const trimmed = message.trim();
  if (RAW_PERSONAL_CODEX_USAGE_LIMIT_PATTERN.test(trimmed)) {
    return PERSONAL_CODEX_USAGE_LIMIT_MESSAGE;
  }
  const unsupportedTier = RAW_CODEX_UNSUPPORTED_SERVICE_TIER_PATTERN.exec(trimmed);
  return unsupportedTier
    ? codexUnsupportedServiceTierMessage(unsupportedTier[1] ?? "", unsupportedTier[2] ?? "")
    : message;
}

export function localizeProviderRuntimeMessage(message: string, locale: MossLocaleCode): string {
  const normalized = normalizeProviderRuntimeMessage(message);
  if (locale !== "zh-CN") {
    return normalized;
  }

  const exact = ZH_CN_EXACT_MESSAGES[normalized];
  if (exact !== undefined) {
    return exact;
  }

  for (const template of ZH_CN_TEMPLATE_MESSAGES) {
    const match = template.pattern.exec(normalized);
    if (match) {
      return template.localize(match);
    }
  }

  return normalized;
}
