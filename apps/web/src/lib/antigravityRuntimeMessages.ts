// FILE: antigravityRuntimeMessages.ts
// Purpose: Localize known Antigravity runtime copy without rewriting diagnostics or user content.
// Layer: Web presentation helper
// Exports: narrow Antigravity runtime-message localization

import type { MossLocaleCode } from "../appSettings";

const LEGACY_PRODUCT_NAME = ["Syn", "ara"].join("");

const ZH_CN_EXACT_MESSAGES: Readonly<Record<string, string>> = {
  "Antigravity CLI (`agy`) is not installed or is not on PATH.":
    "Antigravity CLI（`agy`）未安装或不在 PATH 中。",
  "Antigravity CLI version check timed out.": "Antigravity CLI 版本检查超时。",
  "Antigravity CLI version check failed.": "Antigravity CLI 版本检查失败。",
  "Antigravity CLI is installed, authenticated, and returned available models.":
    "Antigravity CLI 已安装并完成认证，且已返回可用模型。",
  "Antigravity CLI is installed, but Moss could not verify login by listing models.":
    "Antigravity CLI 已安装，但 Moss 无法通过模型列表验证登录状态。",
  "Antigravity CLI session started": "Antigravity CLI 会话已启动",
  "Antigravity CLI print mode cannot pause for interactive approvals. Select Full access to use this provider.":
    "Antigravity CLI 的打印模式无法暂停并等待交互式批准。请选择“完全访问”以使用此服务商。",
  "An Antigravity turn is already active for this thread.":
    "此线程已有一个正在运行的 Antigravity 回合。",
  "Failed to prepare Antigravity turn files.": "准备 Antigravity 回合文件失败。",
  "Failed to create the Antigravity hook stream.": "创建 Antigravity 钩子事件流失败。",
  "Failed to launch Antigravity CLI.": "启动 Antigravity CLI 失败。",
  "Failed to list Antigravity models.": "获取 Antigravity 模型列表失败。",
  "agy models failed": "agy models 命令失败",
  "Streams Antigravity CLI lifecycle events to Moss when requested.":
    "按需将 Antigravity CLI 生命周期事件流式传送到 Moss。",
};

// These short details are not self-identifying. Translate them only after an
// Antigravity adapter envelope has established their source.
const ZH_CN_ADAPTER_DETAILS: Readonly<Record<string, string>> = {
  "A prompt or file attachment is required.": "需要输入提示词或附加文件。",
  "Plugin install failed.": "插件安装失败。",
  "Failed to install the Moss capture hook.": "安装 Moss 捕获钩子失败。",
  // Historical sessions may retain the pre-Moss fallback text.
  [`Failed to install the ${LEGACY_PRODUCT_NAME} capture hook.`]: "安装 Moss 捕获钩子失败。",
};

function localizeKnownTemplate(message: string): string {
  const exact = ZH_CN_EXACT_MESSAGES[message];
  if (exact !== undefined) {
    return exact;
  }

  const healthFailure = /^Antigravity CLI health check failed: ([\s\S]+)$/u.exec(message);
  if (healthFailure?.[1] !== undefined) {
    return `Antigravity CLI 健康检查失败：${healthFailure[1]}`;
  }

  const outdated = /^Antigravity CLI (.+) is too old for Moss\. Upgrade to (.+) or newer\.$/u.exec(
    message,
  );
  if (outdated?.[1] !== undefined && outdated[2] !== undefined) {
    return `Antigravity CLI ${outdated[1]} 版本过低，无法用于 Moss。请升级到 ${outdated[2]} 或更高版本。`;
  }

  const windowsLimit =
    /^Antigravity prompts on Windows are limited to (.+) characters because the CLI accepts print-mode prompts as command-line arguments\. Shorten the prompt or attach the content as files\.$/u.exec(
      message,
    );
  if (windowsLimit?.[1] !== undefined) {
    return `Windows 上的 Antigravity 提示词长度上限为 ${windowsLimit[1]} 个字符，因为 CLI 的打印模式通过命令行参数接收提示词。请缩短提示词或将内容作为文件附加。`;
  }

  const helperTimeout = /^Antigravity helper timed out after ([0-9]+)ms: ([\s\S]+)$/u.exec(message);
  if (helperTimeout?.[1] !== undefined && helperTimeout[2] !== undefined) {
    return `Antigravity 辅助进程在 ${helperTimeout[1]}ms 后超时：${helperTimeout[2]}`;
  }

  const exited = /^Antigravity CLI exited with code ([\s\S]+)\.$/u.exec(message);
  if (exited?.[1] !== undefined) {
    return `Antigravity CLI 已退出，退出代码为 ${exited[1]}。`;
  }

  const interactiveRequest =
    /^Antigravity CLI print mode does not expose interactive requests for ([\s\S]+)\.$/u.exec(
      message,
    );
  if (interactiveRequest?.[1] !== undefined) {
    return `Antigravity CLI 的打印模式不提供线程 ${interactiveRequest[1]} 的交互式请求。`;
  }

  return message;
}

function localizeKnownAdapterEnvelope(line: string): string {
  const validation =
    /^(Error: )?Provider adapter validation failed \(antigravity\) in ([^:\r\n]+): ([\s\S]+)$/u.exec(
      line,
    );
  if (validation?.[2] !== undefined && validation[3] !== undefined) {
    const localizedIssue =
      ZH_CN_ADAPTER_DETAILS[validation[3]] ?? localizeKnownTemplate(validation[3]);
    if (localizedIssue === validation[3]) {
      return line;
    }
    const errorPrefix = validation[1] ? "错误：" : "";
    return `${errorPrefix}Antigravity 服务商适配器在 ${validation[2]} 校验失败：${localizedIssue}`;
  }

  const request =
    /^(Error: )?Provider adapter request failed \(antigravity\) for ([^:\r\n]+): ([\s\S]+)$/u.exec(
      line,
    );
  if (request?.[2] !== undefined && request[3] !== undefined) {
    const localizedDetail = ZH_CN_ADAPTER_DETAILS[request[3]] ?? localizeKnownTemplate(request[3]);
    if (localizedDetail === request[3]) {
      return line;
    }
    const errorPrefix = request[1] ? "错误：" : "";
    return `${errorPrefix}Antigravity 服务商适配器请求 ${request[2]} 失败：${localizedDetail}`;
  }

  return line;
}

export function localizeAntigravityRuntimeMessage(message: string, locale: MossLocaleCode): string {
  if (locale !== "zh-CN") {
    return message;
  }

  const localizedTemplate = localizeKnownTemplate(message);
  if (localizedTemplate !== message) {
    return localizedTemplate;
  }

  const localizedEnvelope = localizeKnownAdapterEnvelope(message);
  if (localizedEnvelope !== message) {
    return localizedEnvelope;
  }

  // Effect's Cause.pretty appends stack frames after the adapter error's first line.
  // Translate only a recognized first line, and preserve the entire diagnostic suffix byte-for-byte.
  const firstNewline = message.indexOf("\n");
  if (firstNewline >= 0) {
    const firstLine = message.slice(0, firstNewline);
    const localizedFirstLine = localizeKnownAdapterEnvelope(firstLine);
    if (localizedFirstLine !== firstLine) {
      return `${localizedFirstLine}${message.slice(firstNewline)}`;
    }
  }

  return message;
}
