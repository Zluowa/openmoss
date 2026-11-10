// FILE: zhCNProviderStatus.test.ts
// Purpose: Locks the provider status sentences the settings page shows for each agent.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

describe("provider status in zh-CN", () => {
  it.each([
    [
      "Moss could not safely apply compatibility for this Hermes version.",
      "Moss 无法安全兼容这个 Hermes 版本。",
    ],
    [
      "This Hermes installation is missing the required compatibility helper.",
      "当前 Hermes 安装缺少所需的兼容组件。",
    ],
    [
      "Hermes compatibility did not load from its isolated Moss home.",
      "Hermes 兼容组件未从 Moss 隔离目录加载。",
    ],
    [
      "Hermes compatibility did not load. Check whether its Moss plugin is disabled.",
      "Hermes 兼容组件未加载，请检查 Moss 插件是否已停用。",
    ],
    [
      "Moss Hermes compatibility is disabled in this isolated home's plugin settings.",
      "Moss Hermes 兼容插件已在此隔离目录的插件设置中停用。",
    ],
    [
      "Managed Hermes plugin configuration could not be read safely.",
      "无法安全读取 Moss 托管的 Hermes 插件配置。",
    ],
    [
      "Moss Hermes compatibility plugin conflicts with an existing plugin.",
      "Moss Hermes 兼容插件与已有插件冲突，原文件已保留。",
    ],
    [
      "The Codex program changed. Restart Moss to apply it; accounts and history are preserved.",
      "Codex 程序已更改，重启 Moss 后生效。账号和聊天历史会保留。",
    ],
    [
      "The Claude program changed. Restart Moss to apply it; accounts and history are preserved.",
      "Claude 程序已更改，重启 Moss 后生效。账号和聊天历史会保留。",
    ],
    [
      "Codex is still in use or its exit is unconfirmed. Finish running work, or restart Moss, before updating.",
      "Codex 仍在使用中，或尚未确认退出。请先结束正在运行的任务，或重启 Moss，再更新程序。",
    ],
    [
      "Failed to execute Claude Agent CLI health check: The Claude program changed. Restart Moss to apply it; accounts and history are preserved..",
      "无法执行 Claude Agent CLI 健康检查：Claude 程序已更改，重启 Moss 后生效。账号和聊天历史会保留。",
    ],
    [
      "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
      "OpenCode CLI 已安装。请按需在 OpenCode 中配置服务商凭据。",
    ],
    [
      "Antigravity CLI (`agy`) is not installed or is not on PATH.",
      "Antigravity CLI (`agy`) 未安装，或不在 PATH 中。",
    ],
    [
      "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
      "Pi CLI 已安装。请按需在 Pi 中配置服务商凭据。",
    ],
    [
      "OMP CLI (`omp`) is not on PATH. Install it to use the OMP provider.",
      "OMP CLI (`omp`) 不在 PATH 中。请先安装它，才能使用 OMP 服务商。",
    ],
    [
      "Devin CLI is installed. Run `devin auth login` to authenticate locally, or set WINDSURF_API_KEY before starting a session.",
      "Devin CLI 已安装。请运行 `devin auth login` 在本地认证，或在开始会话前设置 WINDSURF_API_KEY。",
    ],
  ])("translates %s", (english, chinese) => {
    expect(translateZhCnPresentationText(english)).toBe(chinese);
  });

  it("keeps names, versions and what the CLI printed literal", () => {
    expect(
      translateZhCnPresentationText("Grok CLI is installed but failed to run. spawn EACCES"),
    ).toBe("Grok CLI 已安装，但运行失败。spawn EACCES");
    expect(
      translateZhCnPresentationText(
        "Codex CLI is installed but failed to run. Timed out while running command.",
      ),
    ).toBe("Codex CLI 已安装，但运行失败。执行命令超时。");
    expect(
      translateZhCnPresentationText(
        "Could not verify Gemini authentication status: unexpected token.",
      ),
    ).toBe("无法确认 Gemini 的认证状态。unexpected token.");
    expect(
      translateZhCnPresentationText(
        "Antigravity CLI 1.2.0 is too old for Moss. Upgrade to 1.4.0 or newer.",
      ),
    ).toBe("Antigravity CLI 1.2.0 版本过低，Moss 无法使用。请升级到 1.4.0 或更新版本。");
    expect(translateZhCnPresentationText("ChatGPT Pro Subscription")).toBe("ChatGPT Pro 订阅");
  });

  it("translates the install and sign-in hints that follow the shared sentences", () => {
    expect(
      translateZhCnPresentationText(
        "Kimi Code CLI (`kimi`) is not installed or not on PATH. Install it with `npm install -g @moonshot-ai/kimi-code`.",
      ),
    ).toBe(
      "Kimi Code CLI (`kimi`) 未安装，或不在 PATH 中。请用 `npm install -g @moonshot-ai/kimi-code` 安装。",
    );
    expect(
      translateZhCnPresentationText(
        "Kimi Code CLI is installed. Run `kimi login` in a terminal (with the same KIMI_CODE_HOME, if set) and retry.",
      ),
    ).toBe(
      "Kimi Code CLI 已安装。请在终端中运行 `kimi login`（如已设置 KIMI_CODE_HOME，请使用相同的值），然后重试。",
    );
  });

  it("says how to install Grok and OpenCode, which Moss can't install for the user", () => {
    expect(
      translateZhCnPresentationText(
        "Grok CLI (`grok`) is not installed or not on PATH. Grok has no npm package for every platform, so use the installer at docs.x.ai/build/overview.",
      ),
    ).toBe(
      "Grok CLI (`grok`) 未安装，或不在 PATH 中。Grok 的 npm 包并不支持所有平台，请使用 docs.x.ai/build/overview 上的安装程序。",
    );
    expect(
      translateZhCnPresentationText(
        "OpenCode CLI (`opencode`) is not installed or not on PATH. Install it with `npm install -g opencode-ai`.",
      ),
    ).toBe(
      "OpenCode CLI (`opencode`) 未安装，或不在 PATH 中。请用 `npm install -g opencode-ai` 安装。",
    );
  });

  it.each([
    [
      "Provider settings changed while the update was being prepared. Try again.",
      "准备更新期间服务商设置有改动，请重试。",
    ],
    [
      "This provider's installation changed while the update was being prepared. Try again.",
      "准备更新期间这个服务商的安装发生了变化，请重试。",
    ],
    [
      "Moss could not confirm which version to install. Check your network and try again.",
      "Moss 无法确认要安装的版本，请检查网络后重试。",
    ],
    [
      "Update command completed, but Moss could not verify the requested provider version.",
      "更新命令已完成，但 Moss 无法确认已装上要求的版本。",
    ],
  ])("explains why a one-click update could not start: %s", (english, chinese) => {
    expect(translateZhCnPresentationText(english)).toBe(chinese);
  });

  it("leaves an unknown status sentence untouched", () => {
    const unknown = "Some future provider status we have not seen.";
    expect(translateZhCnPresentationText(unknown)).toBe(unknown);
  });
});
