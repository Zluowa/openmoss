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
  // Send failures around a backend restart. The first is wsTransportEvents'
  // WS_MESSAGE_NOT_SENT_DETAIL; the second is the server's settlement verdict.
  "Moss could not reach its backend, so this message was not sent. It is still in the composer.":
    "Moss 暂时连不上后端，这条消息没有发出，内容还在输入框里。",
  "The connection was interrupted before this message was accepted. Please send it again.":
    "消息还没被接收，连接就中断了。请再发一次。",
  // Why a Claude turn failed (ClaudeAdapter), and the rows shown while a provider retries.
  "Claude returned a server error. Retry in a moment.": "Claude 返回了服务器错误，请稍后重试。",
  "Claude is temporarily overloaded. Retry in a moment.": "Claude 暂时过载，请稍后重试。",
  "Claude rate limit reached. Wait briefly, then retry.": "Claude 已达到速率限制，请稍等后重试。",
  "Claude rejected the request as invalid.": "Claude 认为这次请求无效，已拒绝。",
  "The selected Claude model is unavailable for this account.":
    "当前账号不能使用所选的 Claude 模型。",
  "Claude reached the maximum output length before completing the turn.":
    "Claude 在完成这一轮之前达到了输出长度上限。",
  "Claude failed to complete the turn.": "Claude 没能完成这一轮。",
  "The connection to the model service dropped. Try again.": "与模型服务的连接中断了，请重试。",
  // A Moss Codex chat whose sign-in runtime is missing or revoked (threadErrorPresentation).
  "Moss's models aren't ready for this chat. Sign in to Moss again, or switch to another provider, then retry.":
    "Moss 模型服务还没为这个对话准备好。请重新登录 Moss，或换一个服务商后重试。",
  "OpenCode retrying": "OpenCode 正在重试",
  "Connection reset by server": "连接被服务器重置",
  // The Moss gateway's own failure sentences (see threadErrorPresentation).
  "The model service is temporarily unavailable.": "模型服务暂时不可用，请稍后重试。",
  "The model service timed out.": "模型服务响应超时，请稍后重试。",
  "The model provider's balance for this model is used up. Choose another model or try again later.":
    "这个模型的服务商额度已用完，请换一个模型，或稍后再试。",
  "The model service returned an empty response; the request was not replayed.":
    "模型服务返回了空响应，这次请求没有重发。请稍后重试。",
  "The model service credential is temporarily unavailable.": "模型服务暂时不可用，请稍后重试。",
  "The upstream model service rejected the request.":
    "模型服务拒绝了这次请求。可以换个模型，或修改内容后重试。",
  "The upstream provider rejected this request under its access policy.":
    "模型服务商根据其访问政策拒绝了这次请求。",
  "The upstream provider rejected this request.": "模型服务商拒绝了这次请求。",
  "The selected model is not available from this region or provider account.":
    "这个模型在当前地区或账号下不可用，请换一个模型。",
  "This model is not available for this Moss sign-in method.":
    "当前的 Moss 登录方式不能使用这个模型，请换一个模型。",
  "The model cannot represent these tool definitions or tool choices.":
    "这个模型用不了这次对话需要的某个工具。换一个模型，再点「继续任务」就能接着做。",
  "The model response could not be safely accounted for.":
    "这次回复无法完成用量核算，已中止。请重试。",
  "Account quota verification is temporarily unavailable.": "暂时无法核对账号额度，请稍后重试。",
  "Account verification is temporarily unavailable.": "暂时无法验证账号，请稍后重试。",
  "The Moss account session is invalid or expired.": "Moss 登录已失效，请重新登录。",
  "A valid Moss account session is required.": "需要有效的 Moss 登录，请重新登录。",
  "This request id is already in use.": "这个请求 ID 正在使用中，请重试。",
  "An identical request is still running. Retry when it finishes.":
    "相同的请求还在运行，等它结束后再试。",
  // What a turn says when an agent's own login is missing.
  "Kimi Code is not signed in. Run `kimi login` in a terminal (with the same KIMI_CODE_HOME, if set) and retry.":
    "Kimi Code 尚未登录。请在终端中运行 `kimi login`（如已设置 KIMI_CODE_HOME，请使用相同的值），然后重试。",
  "MiniMax Code is not signed in. Run `mcode login` in a terminal (add --region cn or --region global if needed) and retry.":
    "MiniMax Code 尚未登录。请在终端中运行 `mcode login`（如有需要，请加上 --region cn 或 --region global），然后重试。",
  "No ZCode credentials found. Sign in to the ZCode desktop app, or run `zcode-acp setup --provider bigmodel` (or `--provider zai`) to save a GLM Coding Plan key, then retry.":
    "没有找到 ZCode 凭据。请登录 ZCode 桌面应用，或运行 `zcode-acp setup --provider bigmodel`（或 `--provider zai`）保存 GLM Coding Plan 密钥，然后重试。",
  // What a turn says when an agent's own CLI could not start.
  "The ZCode CLI could not be started. Install the ZCode desktop app (it bundles the CLI) or set ZCODE_BIN to the zcode CLI path, then retry.":
    "无法启动 ZCode CLI。请安装 ZCode 桌面应用（已内置该 CLI），或把 ZCODE_BIN 设为 zcode CLI 的路径，然后重试。",
  "Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry.":
    "在 Windows 上，Kimi Code 需要 Git Bash，但 Moss 没有找到。请安装 Git for Windows，或把 KIMI_SHELL_PATH 设为 bash.exe 的路径，然后重试。",
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
    pattern:
      /^This Pi account has no sign-in for (.+)\. Switch to Moss or another model to continue\.$/u,
    localize: (match) =>
      `本机的 Pi 还没登录能用「${match[1]}」的账号。换成 Moss 或其他模型就能继续。`,
  },
  {
    pattern: /^Request retry (\d+)\/(\d+) in (\d+)s \(connection error\)\.$/u,
    localize: (match) => `连接中断，${match[3]} 秒后重试（第 ${match[1]}/${match[2]} 次）。`,
  },
  {
    pattern: /^Request retry (\d+)\/(\d+) in (\d+)s \(HTTP (\d+)\)\.$/u,
    localize: (match) =>
      `请求失败（HTTP ${match[4]}），${match[3]} 秒后重试（第 ${match[1]}/${match[2]} 次）。`,
  },
  {
    // The provider's own error text follows; it's transport detail, so it stays out.
    pattern: /^Pi retrying after provider error \(attempt (\d+)\/(\d+), retrying in ([\d.]+)s\)/u,
    localize: (match) => `服务商出错，${match[3]} 秒后重试（第 ${match[1]}/${match[2]} 次）。`,
  },
  {
    pattern: /^Codex stopped responding \(no activity for (\d+)s\); the turn was aborted\.$/u,
    localize: (match) => `Codex 已停止响应（${match[1]} 秒没有活动），本次对话已中止。`,
  },
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
    pattern:
      /^([^\r\n]+) ended the turn without a reply\. The Moss model service may have refused the request\. Check your plan or try again\.$/u,
    localize: (match) =>
      `${match[1]} 没有回复就结束了这一轮。Moss 模型服务可能拒绝了这次请求，请检查套餐后重试。`,
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
