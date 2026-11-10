// FILE: zhCNProviderStatus.ts
// Purpose: Simplified Chinese for the status, sign-in and update sentences the server sends for
//          each provider (`apps/server/src/provider/Layers/ProviderHealth.ts`).
// Layer: Pure localization data
// Boundary: Provider names, commands, versions, paths and the diagnostic detail a CLI printed are
//           reinserted byte for byte. Unknown sentences pass through unchanged.

import { lookupPhrase } from "./zhCNPhraseTable";

type StatusTranslation = readonly [pattern: RegExp, translate: (...slots: string[]) => string];

export const HERMES_COMPATIBILITY_STATUS: Readonly<Record<string, string>> = {
  "Moss could not safely apply compatibility for this Hermes version.":
    "Moss 无法安全兼容这个 Hermes 版本。",
  "This Hermes installation is missing the required compatibility helper.":
    "当前 Hermes 安装缺少所需的兼容组件。",
  "Hermes compatibility did not load from its isolated Moss home.":
    "Hermes 兼容组件未从 Moss 隔离目录加载。",
  "Hermes compatibility did not load. Check whether its Moss plugin is disabled.":
    "Hermes 兼容组件未加载，请检查 Moss 插件是否已停用。",
  "Moss Hermes compatibility is disabled in this isolated home's plugin settings.":
    "Moss Hermes 兼容插件已在此隔离目录的插件设置中停用。",
  "Managed Hermes plugin configuration could not be read safely.":
    "无法安全读取 Moss 托管的 Hermes 插件配置。",
  "Moss Hermes compatibility plugin conflicts with an existing plugin.":
    "Moss Hermes 兼容插件与已有插件冲突，原文件已保留。",
};

const EXACT_STATUS: Readonly<Record<string, string>> = {
  ...HERMES_COMPATIBILITY_STATUS,
  "Choose one Codex program in Settings before starting this account.":
    "请先在设置中为所有 Codex 账号选择同一个程序。",
  "Choose one Claude program in Settings before starting this account.":
    "请先在设置中为所有 Claude 账号选择同一个程序。",
  "The Codex program changed. Restart Moss to apply it; accounts and history are preserved.":
    "Codex 程序已更改，重启 Moss 后生效。账号和聊天历史会保留。",
  "The Claude program changed. Restart Moss to apply it; accounts and history are preserved.":
    "Claude 程序已更改，重启 Moss 后生效。账号和聊天历史会保留。",
  "Codex is still in use or its exit is unconfirmed. Finish running work, or restart Moss, before updating.":
    "Codex 仍在使用中，或尚未确认退出。请先结束正在运行的任务，或重启 Moss，再更新程序。",
  "Claude is still in use or its exit is unconfirmed. Finish running work, or restart Moss, before updating.":
    "Claude 仍在使用中，或尚未确认退出。请先结束正在运行的任务，或重启 Moss，再更新程序。",
  "Select an absolute agent program path in Settings, then restart Moss.":
    "请在设置中选择智能体程序的完整路径，然后重启 Moss。",
  // Sign-in and instance state
  "Authentication has not been checked for this provider instance.":
    "还没有检查这个服务商实例的认证状态。",
  "Provider instance has not been checked yet.": "还没有检查这个服务商实例。",
  "Provider sign-in could not be started.": "无法开始服务商登录。",
  "Only Codex and Claude support account sign-in from Moss.":
    "只有 Codex 和 Claude 支持在 Moss 中登录账号。",
  "Provider account is not configured.": "服务商账号尚未配置。",
  "Provider account is disabled in Moss settings.": "服务商账号已在 Moss 设置中停用。",
  "Moss managed and API-key accounts do not use provider sign-in.":
    "Moss 托管账号和 API 密钥账号不需要登录服务商。",
  "Sign-in cancelled.": "已取消登录。",
  "Checking the signed-in account.": "正在检查已登录的账号。",
  "Sign-in finished, but the provider did not confirm the account.":
    "登录已结束，但服务商没有确认账号。",
  "Starting sign-in.": "正在开始登录。",
  "Finish sign-in in your browser.": "请在浏览器中完成登录。",
  "Provider instance is disabled in Moss settings.": "服务商实例已在 Moss 设置中停用。",
  "Provider instance is not configured.": "服务商实例尚未配置。",
  "Using the Moss managed gateway.": "正在使用 Moss 托管网关。",
  "Configured server password": "已配置服务器密码",
  "OpenAI API Key": "OpenAI API 密钥",

  // Provider updates
  "An update is already running for this provider.": "这个服务商已有更新正在运行。",
  "Update command failed before producing output. Try running the provider update command from a terminal.":
    "更新命令还没有输出就失败了。请尝试在终端中运行服务商的更新命令。",
  "Update command could not be started.": "无法启动更新命令。",
  "This provider does not support one-click updates.": "这个服务商不支持一键更新。",
  "Provider settings changed while the update was being prepared. Try again.":
    "准备更新期间服务商设置有改动，请重试。",
  "This provider's installation changed while the update was being prepared. Try again.":
    "准备更新期间这个服务商的安装发生了变化，请重试。",
  "Moss could not confirm which version to install. Check your network and try again.":
    "Moss 无法确认要安装的版本，请检查网络后重试。",
  "Update command completed, but Moss could not verify the requested provider version.":
    "更新命令已完成，但 Moss 无法确认已装上要求的版本。",
  "Provider instance was disabled or removed before its queued update could start.":
    "排队中的更新开始前，服务商实例已被停用或移除。",
  "Updating provider.": "正在更新服务商。",
  "Update stopped because the provider instance was disabled or removed.":
    "服务商实例已被停用或移除，更新已停止。",
  "Update stopped because the provider was disabled.": "服务商已被停用，更新已停止。",
  "Provider updated.": "服务商已更新。",
  "Waiting for another provider update to finish.": "正在等待另一个服务商更新完成。",

  // Codex and Claude
  "Codex CLI authentication status command is unavailable in this Codex version.":
    "这个版本的 Codex 不支持 CLI 认证状态命令。",
  "Using a custom Codex model provider; OpenAI login check skipped.":
    "正在使用自定义 Codex 模型服务商，已跳过 OpenAI 登录检查。",
  "Moss managed Claude runtime is unavailable. Reinstall Moss before using this provider.":
    "Moss 托管的 Claude 运行时不可用。请先重新安装 Moss，再使用这个服务商。",
  "Claude Agent authentication status command is unavailable in this version of Claude.":
    "这个版本的 Claude 不支持 Claude Agent 认证状态命令。",

  // Cursor
  "Cursor Agent authentication status command is unavailable in this Cursor Agent version.":
    "这个版本的 Cursor Agent 不支持认证状态命令。",
  "Cursor Agent is installed, but Moss could not verify authentication status.":
    "Cursor Agent 已安装，但 Moss 无法确认认证状态。",
  "Cursor Agent is authenticated, but model discovery timed out before Moss could verify available models.":
    "Cursor Agent 已认证，但模型发现超时，Moss 无法确认可用模型。",
  "Cursor Agent is authenticated, but it reports no models available for this account.":
    "Cursor Agent 已认证，但它报告这个账号没有可用模型。",
  "Cursor Agent is authenticated, but model discovery returned no recognizable model rows.":
    "Cursor Agent 已认证，但模型发现没有返回可识别的模型。",
  "Cursor Agent is authenticated, but model discovery failed.":
    "Cursor Agent 已认证，但模型发现失败。",

  // Grok and Droid
  "Grok is not signed in. Run `grok login` to sign in, or set XAI_API_KEY before starting a session.":
    "Grok 还没有登录。请运行 `grok login` 登录，或在开始会话前设置 XAI_API_KEY。",
  "Grok CLI is installed. Run `grok` to authenticate locally, or set XAI_API_KEY before starting a session.":
    "Grok CLI 已安装。请运行 `grok` 在本地认证，或在开始会话前设置 XAI_API_KEY。",
  "Droid CLI is installed. Moss can use the CLI's cached device-pairing login; run `droid` to authenticate locally if needed, or set FACTORY_API_KEY.":
    "Droid CLI 已安装。Moss 可以使用 CLI 缓存的设备配对登录；如有需要，请运行 `droid` 在本地认证，或设置 FACTORY_API_KEY。",

  // OpenCode
  "Configured OpenCode server URL is invalid.": "配置的 OpenCode 服务器 URL 无效。",
  "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.":
    "OpenCode CLI 已安装。请按需在 OpenCode 中配置服务商凭据。",

  // Hermes
  "Hermes ACP is not available. Install Hermes with its ACP dependencies.":
    "Hermes ACP 不可用。请安装 Hermes 及其 ACP 依赖。",
  "Hermes ACP is installed. Run hermes setup to configure credentials.":
    "Hermes ACP 已安装。请运行 hermes setup 配置凭据。",

  // Pi
  "Pi CLI (`pi`) is not on PATH. Install it to use the Pi provider.":
    "Pi CLI (`pi`) 不在 PATH 中。请先安装它，才能使用 Pi 服务商。",
  "Pi CLI health check timed out before Moss could verify the installed version.":
    "Pi CLI 健康检查超时，Moss 无法确认已安装的版本。",
  "Pi CLI health check failed.": "Pi CLI 健康检查失败。",
  "Pi CLI is installed. Configure provider credentials inside Pi as needed.":
    "Pi CLI 已安装。请按需在 Pi 中配置服务商凭据。",

  // OMP
  "OMP CLI (`omp`) is not on PATH. Install it to use the OMP provider.":
    "OMP CLI (`omp`) 不在 PATH 中。请先安装它，才能使用 OMP 服务商。",
  "OMP CLI health check timed out before Moss could verify the installed version.":
    "OMP CLI 健康检查超时，Moss 无法确认已安装的版本。",
  "OMP CLI health check failed.": "OMP CLI 健康检查失败。",
  "OMP CLI is installed. Configure provider credentials inside the OMP app as needed.":
    "OMP CLI 已安装。请按需在 OMP 应用中配置服务商凭据。",

  // Antigravity
  "Antigravity CLI (`agy`) is not installed or is not on PATH.":
    "Antigravity CLI (`agy`) 未安装，或不在 PATH 中。",
  "Antigravity CLI version check timed out.": "Antigravity CLI 版本检查超时。",
  "Antigravity CLI version check failed.": "Antigravity CLI 版本检查失败。",
  "Antigravity CLI is installed, authenticated, and returned available models.":
    "Antigravity CLI 已安装并已认证，且返回了可用模型。",
  "Antigravity CLI is installed, but Moss could not verify login by listing models.":
    "Antigravity CLI 已安装，但 Moss 无法通过列出模型来确认登录状态。",

  // Devin
  "Devin CLI is installed. Run `devin auth login` to authenticate locally, or set WINDSURF_API_KEY before starting a session.":
    "Devin CLI 已安装。请运行 `devin auth login` 在本地认证，或在开始会话前设置 WINDSURF_API_KEY。",

  // Gemini
  "Gemini CLI is installed and authenticated.": "Gemini CLI 已安装并已认证。",
  "Gemini CLI is installed and authenticated, but it did not report any available models. Moss will use its built-in Gemini model list.":
    "Gemini CLI 已安装并已认证，但没有报告任何可用模型。Moss 将使用内置的 Gemini 模型列表。",
  "Gemini ACP request failed.": "Gemini ACP 请求失败。",
  "Gemini ACP did not expose the expected stdio streams.":
    "Gemini ACP 没有提供预期的 stdio 数据流。",
  "Gemini ACP stdin is not writable.": "Gemini ACP 的 stdin 不可写。",
  "Gemini attempted to start an OAuth browser flow during a Moss status check. Run `gemini` in a terminal to sign in.":
    "Gemini 在 Moss 状态检查期间尝试打开 OAuth 浏览器流程。请在终端中运行 `gemini` 登录。",
  "Timed out while starting Gemini ACP session.": "启动 Gemini ACP 会话超时。",
  "Failed to start Gemini ACP session.": "无法启动 Gemini ACP 会话。",

  // Install and sign-in hints that follow "<name> CLI is installed." for Kimi, MiniMax and ZCode.
  "Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry.":
    "在 Windows 上，Kimi Code 需要 Git Bash，但 Moss 没有找到。请安装 Git for Windows，或把 KIMI_SHELL_PATH 设为 bash.exe 的路径，然后重试。",
  "Run `kimi login` in a terminal (with the same KIMI_CODE_HOME, if set) and retry.":
    "请在终端中运行 `kimi login`（如已设置 KIMI_CODE_HOME，请使用相同的值），然后重试。",
  "Run `mcode login` in a terminal (add --region cn or --region global if needed) and retry.":
    "请在终端中运行 `mcode login`（如有需要，请加上 --region cn 或 --region global），然后重试。",
  "Sign in to the ZCode desktop app, or run `zcode-acp setup --provider bigmodel` (or `--provider zai`) to save a GLM Coding Plan key, then retry.":
    "请登录 ZCode 桌面应用，或运行 `zcode-acp setup --provider bigmodel`（或 `--provider zai`）保存 GLM Coding Plan 密钥，然后重试。",
  "The ZCode CLI could not be started. Install the ZCode desktop app (it bundles the CLI) or set ZCODE_BIN to the zcode CLI path, then retry.":
    "无法启动 ZCode CLI。请安装 ZCode 桌面应用（已内置该 CLI），或把 ZCODE_BIN 设为 zcode CLI 的路径，然后重试。",
  "Install it with `npm install -g zcode-acp-server`; the ZCode desktop app provides the GLM CLI it drives.":
    "请用 `npm install -g zcode-acp-server` 安装；它驱动的 GLM CLI 由 ZCode 桌面应用提供。",
};

const TIMEOUT_DETAIL = "Timed out while running command.";

function statusDetail(detail: string): string {
  if (detail === TIMEOUT_DETAIL) return "执行命令超时。";
  return lookupPhrase(EXACT_STATUS, detail) ?? detail;
}

function installHint(hint: string): string {
  if (
    hint ===
    "Grok has no npm package for every platform, so use the installer at docs.x.ai/build/overview."
  ) {
    return "Grok 的 npm 包并不支持所有平台，请使用 docs.x.ai/build/overview 上的安装程序。";
  }
  const command = /^Install it with (`[^`]+`)\.$/.exec(hint);
  return command ? `请用 ${command[1]} 安装。` : statusDetail(hint);
}

const STATUS_PATTERNS: ReadonlyArray<StatusTranslation> = [
  // The CLI health family every provider shares.
  [/^(.+) CLI is installed but failed to run\.$/, (name) => `${name} CLI 已安装，但运行失败。`],
  [
    /^(.+) CLI is installed but failed to run\. (.+)$/s,
    (name, detail = "") => `${name} CLI 已安装，但运行失败。${statusDetail(detail)}`,
  ],
  [
    /^Failed to execute (?:the )?(.+) CLI health check: (.+?)\.?$/s,
    (name, detail) =>
      `无法执行 ${name} CLI 健康检查：${lookupPhrase(EXACT_STATUS, detail) ?? lookupPhrase(EXACT_STATUS, `${detail}.`) ?? detail}`,
  ],
  [
    /^Could not verify (.+) authentication status from JSON output \(missing auth marker\)\.$/,
    (name) => `无法从 JSON 输出确认 ${name} 的认证状态（缺少认证标记）。`,
  ],
  [/^Could not verify (.+) authentication status\.$/, (name) => `无法确认 ${name} 的认证状态。`],
  [
    /^Could not verify (.+) authentication status[.:] (.+?)$/s,
    (name, detail = "") => `无法确认 ${name} 的认证状态。${statusDetail(detail)}`,
  ],
  [
    /^(.+) CLI \((`[^`]+`)\) is not installed or not on PATH\. (.+)$/s,
    (name, command, hint = "") =>
      `${name} CLI (${command}) 未安装，或不在 PATH 中。${installHint(hint)}`,
  ],
  [
    /^(.+) CLI is installed\. (.+)$/s,
    (name, hint = "") => `${name} CLI 已安装。${statusDetail(hint)}`,
  ],

  // Provider specifics that carry a value.
  [
    /^Provider '(.+)' is no longer supported by Moss\.$/,
    (name) => `Moss 已不再支持服务商“${name}”。`,
  ],
  [
    /^Provider driver '(.+)' is not supported by this Moss build\.$/,
    (name) => `这个 Moss 版本不支持服务商驱动“${name}”。`,
  ],
  [
    /^Failed to prepare the private provider account home\. (.+)$/s,
    (detail) => `无法准备服务商账号的私有主目录。${detail}`,
  ],
  [
    /^(ChatGPT|Claude)(?: (.+))? Subscription$/,
    (brand, tier) => `${brand}${tier ? ` ${tier}` : ""} 订阅`,
  ],
  [
    /^OpenCode will use the configured server at (.+) with experimental WebSockets enabled\.$/,
    (url) => `OpenCode 将使用 ${url} 上配置的服务器，并启用实验性 WebSocket。`,
  ],
  [
    /^OpenCode will use the configured server at (.+)\.$/,
    (url) => `OpenCode 将使用 ${url} 上配置的服务器。`,
  ],
  [/^Pi CLI health check failed[.:] (.+?)$/s, (detail) => `Pi CLI 健康检查失败：${detail}`],
  [
    /^Pi CLI (.+) is too old for Moss\. Upgrade to (.+) or newer\.$/,
    (version, minimum) =>
      `Pi CLI ${version} 版本过低，Moss 无法使用。请升级到 ${minimum} 或更新版本。`,
  ],
  [
    /^Pi CLI is installed\. Moss will use Pi agent dir (.+)\.$/,
    (dir) => `Pi CLI 已安装。Moss 将使用 Pi 智能体目录 ${dir}。`,
  ],
  [/^OMP CLI health check failed[.:] (.+?)$/s, (detail) => `OMP CLI 健康检查失败：${detail}`],
  [
    /^OMP CLI is installed\. Moss will use the OMP agent dir (.+)\.$/,
    (dir) => `OMP CLI 已安装。Moss 将使用 OMP 智能体目录 ${dir}。`,
  ],
  [
    /^Antigravity CLI health check failed: (.+)$/s,
    (detail) => `Antigravity CLI 健康检查失败：${detail}`,
  ],
  [
    /^Antigravity CLI (.+) is too old for Moss\. Upgrade to (.+) or newer\.$/,
    (version, minimum) =>
      `Antigravity CLI ${version} 版本过低，Moss 无法使用。请升级到 ${minimum} 或更新版本。`,
  ],
  [
    /^Cursor Agent is authenticated, but model discovery failed[.:] (.+?)$/s,
    (detail) => `Cursor Agent 已认证，但模型发现失败：${detail}`,
  ],
  [
    /^Gemini CLI is installed, but Moss could not verify authentication or discover models\. (.+)$/s,
    (detail) => `Gemini CLI 已安装，但 Moss 无法确认认证状态或发现模型。${detail}`,
  ],
  [
    /^Gemini is not authenticated because Google Code Assist OAuth for individual accounts appears to require Antigravity\. For Moss, use (.+) or Vertex AI auth \((.+)\); use Antigravity for individual Code Assist OAuth until Gemini CLI exposes a compatible path\.$/s,
    (apiKey, vertex) =>
      `Gemini 尚未认证，因为个人账号的 Google Code Assist OAuth 似乎需要 Antigravity。在 Moss 中，请使用 ${apiKey} 或 Vertex AI 认证（${vertex}）；在 Gemini CLI 提供兼容方式之前，个人 Code Assist OAuth 请使用 Antigravity。`,
  ],
  [
    /^Gemini is not authenticated\. (.*) Use Gemini API key or Vertex AI auth for Moss: set (.+) in (`[^`]+`), or set Vertex AI env \((.+)\), then refresh provider status\.$/s,
    (detail, apiKey, envFile, vertex) =>
      `Gemini 尚未认证。${detail} 请在 Moss 中使用 Gemini API 密钥或 Vertex AI 认证：在 ${envFile} 中设置 ${apiKey}，或设置 Vertex AI 环境变量（${vertex}），然后刷新服务商状态。`,
  ],
  [
    /^Timed out while starting Gemini ACP session\. Last output: (.+)$/s,
    (detail) => `启动 Gemini ACP 会话超时。最后输出：${detail}`,
  ],
  [
    /^Gemini ACP exited before responding \((.+)\)\.$/,
    (detail) => `Gemini ACP 在响应前退出（${detail}）。`,
  ],
  [
    /^Update command completed, but Moss still detects an outdated provider version(.*)\.$/,
    (versions) => `更新命令已完成，但 Moss 仍检测到旧版服务商${versions}。`,
  ],
];

export function translateZhCnProviderStatusText(value: string): string {
  const exact = lookupPhrase(EXACT_STATUS, value);
  if (exact) return exact;
  for (const [pattern, translate] of STATUS_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return translate(...match.slice(1).map((slot) => slot ?? ""));
  }
  return value;
}
