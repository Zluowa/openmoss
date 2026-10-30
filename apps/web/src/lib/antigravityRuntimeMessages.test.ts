// FILE: antigravityRuntimeMessages.test.ts
// Purpose: Prove narrow Antigravity runtime localization preserves all dynamic diagnostics.
// Layer: Web unit tests

import { describe, expect, it } from "vitest";

import { localizeAntigravityRuntimeMessage } from "./antigravityRuntimeMessages";

const exactCases = [
  [
    "Antigravity CLI (`agy`) is not installed or is not on PATH.",
    "Antigravity CLI（`agy`）未安装或不在 PATH 中。",
  ],
  ["Antigravity CLI version check timed out.", "Antigravity CLI 版本检查超时。"],
  ["Antigravity CLI version check failed.", "Antigravity CLI 版本检查失败。"],
  [
    "Antigravity CLI is installed, authenticated, and returned available models.",
    "Antigravity CLI 已安装并完成认证，且已返回可用模型。",
  ],
  [
    "Antigravity CLI is installed, but Moss could not verify login by listing models.",
    "Antigravity CLI 已安装，但 Moss 无法通过模型列表验证登录状态。",
  ],
  ["Antigravity CLI session started", "Antigravity CLI 会话已启动"],
  [
    "Antigravity CLI print mode cannot pause for interactive approvals. Select Full access to use this provider.",
    "Antigravity CLI 的打印模式无法暂停并等待交互式批准。请选择“完全访问”以使用此服务商。",
  ],
  [
    "An Antigravity turn is already active for this thread.",
    "此线程已有一个正在运行的 Antigravity 回合。",
  ],
  ["Failed to prepare Antigravity turn files.", "准备 Antigravity 回合文件失败。"],
  ["Failed to create the Antigravity hook stream.", "创建 Antigravity 钩子事件流失败。"],
  ["Failed to launch Antigravity CLI.", "启动 Antigravity CLI 失败。"],
  ["Failed to list Antigravity models.", "获取 Antigravity 模型列表失败。"],
  ["agy models failed", "agy models 命令失败"],
  [
    "Streams Antigravity CLI lifecycle events to Moss when requested.",
    "按需将 Antigravity CLI 生命周期事件流式传送到 Moss。",
  ],
] as const;

describe("localizeAntigravityRuntimeMessage", () => {
  it.each(exactCases)("localizes the exact known template %s", (input, expected) => {
    expect(localizeAntigravityRuntimeMessage(input, "zh-CN")).toBe(expected);
  });

  it("localizes dynamic health templates without changing raw details or versions", () => {
    const rawDetail = "SpawnError: agy failed at /Users/moss/My Project/agy";
    const health = localizeAntigravityRuntimeMessage(
      `Antigravity CLI health check failed: ${rawDetail}`,
      "zh-CN",
    );
    expect(health).toBe(`Antigravity CLI 健康检查失败：${rawDetail}`);
    expect(health).toContain(rawDetail);

    const outdated = localizeAntigravityRuntimeMessage(
      "Antigravity CLI 1.2.3-beta.4 is too old for Moss. Upgrade to 2.0.0 or newer.",
      "zh-CN",
    );
    expect(outdated).toBe(
      "Antigravity CLI 1.2.3-beta.4 版本过低，无法用于 Moss。请升级到 2.0.0 或更高版本。",
    );
    expect(outdated).toContain("1.2.3-beta.4");
    expect(outdated).toContain("2.0.0");
  });

  it("preserves the Windows limit, timeout command, exit code, and thread id", () => {
    const windows = localizeAntigravityRuntimeMessage(
      "Antigravity prompts on Windows are limited to 24,000 characters because the CLI accepts print-mode prompts as command-line arguments. Shorten the prompt or attach the content as files.",
      "zh-CN",
    );
    expect(windows).toContain("24,000");

    const command = '"C:\\Program Files\\Antigravity\\agy.exe" models --cwd "D:\\工作区"';
    const timeout = localizeAntigravityRuntimeMessage(
      `Antigravity helper timed out after 30000ms: ${command}`,
      "zh-CN",
    );
    expect(timeout).toBe(`Antigravity 辅助进程在 30000ms 后超时：${command}`);
    expect(timeout).toContain(command);

    expect(
      localizeAntigravityRuntimeMessage("Antigravity CLI exited with code 137.", "zh-CN"),
    ).toBe("Antigravity CLI 已退出，退出代码为 137。");
    expect(
      localizeAntigravityRuntimeMessage(
        "Antigravity CLI print mode does not expose interactive requests for thread-原始/42.",
        "zh-CN",
      ),
    ).toBe("Antigravity CLI 的打印模式不提供线程 thread-原始/42 的交互式请求。");
  });

  it("localizes known adapter envelopes while preserving operation, method, and stack paths", () => {
    const validation =
      "Error: Provider adapter validation failed (antigravity) in turn/start: A prompt or file attachment is required.\n" +
      "    at /Users/moss/Codex/My Project/ProviderCommandReactor.ts:42:7";
    const localizedValidation = localizeAntigravityRuntimeMessage(validation, "zh-CN");
    expect(localizedValidation).toBe(
      "错误：Antigravity 服务商适配器在 turn/start 校验失败：需要输入提示词或附加文件。\n" +
        "    at /Users/moss/Codex/My Project/ProviderCommandReactor.ts:42:7",
    );
    expect(localizedValidation).toContain(
      "/Users/moss/Codex/My Project/ProviderCommandReactor.ts:42:7",
    );

    expect(
      localizeAntigravityRuntimeMessage(
        "Provider adapter request failed (antigravity) for model/list: Failed to list Antigravity models.",
        "zh-CN",
      ),
    ).toBe("Antigravity 服务商适配器请求 model/list 失败：获取 Antigravity 模型列表失败。");

    expect(
      localizeAntigravityRuntimeMessage(
        "Provider adapter request failed (antigravity) for plugin/install: Plugin install failed.",
        "zh-CN",
      ),
    ).toBe("Antigravity 服务商适配器请求 plugin/install 失败：插件安装失败。");
  });

  it("returns English and unknown diagnostics byte-for-byte", () => {
    const known = "Antigravity CLI version check timed out.";
    expect(localizeAntigravityRuntimeMessage(known, "en")).toBe(known);

    for (const genericMessage of [
      "A prompt or file attachment is required.",
      "Plugin install failed.",
      "Failed to install the Moss capture hook.",
      "Failed to install the Moss capture hook.",
    ]) {
      expect(localizeAntigravityRuntimeMessage(genericMessage, "zh-CN")).toBe(genericMessage);
    }

    const unknown =
      "Error: Provider adapter request failed (antigravity) for model/list: 用户原始 Read Settings\r\n" +
      "  at C:\\Users\\moss\\custom-provider.ts:9:1\u0000";
    expect(localizeAntigravityRuntimeMessage(unknown, "zh-CN")).toBe(unknown);
  });
});
