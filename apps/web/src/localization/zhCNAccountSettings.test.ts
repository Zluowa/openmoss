// FILE: zhCNAccountSettings.test.ts
// Purpose: Locks account/settings Chinese copy and the dynamic-content preservation boundary.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnAccountSettingsText } from "./zhCNAccountSettings";

describe("translateZhCnAccountSettingsText", () => {
  it("translates authentication, account, profile, usage, theme, and workspace copy", () => {
    expect(translateZhCnAccountSettingsText("Moss account required")).toBe("需要登录 Moss 账号");
    expect(translateZhCnAccountSettingsText("Sign in to Moss")).toBe("登录 Moss");
    expect(translateZhCnAccountSettingsText("API users")).toBe("API 用户");
    expect(translateZhCnAccountSettingsText("Model accounts")).toBe("模型账号");
    expect(translateZhCnAccountSettingsText("Environment variables")).toBe("环境变量");
    expect(translateZhCnAccountSettingsText("Private")).toBe("私有");
    expect(translateZhCnAccountSettingsText("Private profile")).toBe("私有个人资料");
    expect(translateZhCnAccountSettingsText("Profile statistics")).toBe("个人资料统计");
    expect(translateZhCnAccountSettingsText("tokens activity")).toBe("Token 活动");
    expect(translateZhCnAccountSettingsText("Token activity")).toBe("Token 活动");
    expect(translateZhCnAccountSettingsText("Weekly")).toBe("每周");
    expect(translateZhCnAccountSettingsText("Cumulative")).toBe("累计");
    expect(translateZhCnAccountSettingsText("Peak tokens")).toBe("峰值 Token 数");
    expect(translateZhCnAccountSettingsText("Total chats")).toBe("对话总数");
    expect(translateZhCnAccountSettingsText("Couldn’t load your local stats.")).toBe(
      "无法加载本地统计数据。",
    );
    expect(translateZhCnAccountSettingsText("Activity insights")).toBe("活动洞察");
    expect(translateZhCnAccountSettingsText("runs")).toBe("次运行");
    expect(translateZhCnAccountSettingsText("Rate limits remaining")).toBe("剩余额度");
    expect(translateZhCnAccountSettingsText("5h")).toBe("5 小时");
    expect(translateZhCnAccountSettingsText("Theme editor")).toBe("主题编辑器");
    expect(translateZhCnAccountSettingsText("Workspace settings")).toBe("工作区设置");
    expect(translateZhCnAccountSettingsText("Two terminals side by side.")).toBe(
      "两个终端并排显示。",
    );
  });

  it("translates account metadata while preserving emails, roles, key prefixes, and dates", () => {
    expect(translateZhCnAccountSettingsText("3 saved accounts")).toBe("已保存 3 个账号");
    expect(translateZhCnAccountSettingsText("Email: moss@example.com")).toBe(
      "邮箱：moss@example.com",
    );
    expect(translateZhCnAccountSettingsText("Change email from moss@example.com")).toBe(
      "更改邮箱（当前为 moss@example.com）",
    );
    expect(translateZhCnAccountSettingsText("owner · 2 active keys · created Jul 16, 2026")).toBe(
      "owner · 2 个有效 key · 创建于 Jul 16, 2026",
    );
    expect(
      translateZhCnAccountSettingsText("sk-live... · created Jul 16, 2026 · last used Never"),
    ).toBe("sk-live... · 创建于 Jul 16, 2026 · 最近使用于 Never");
    expect(translateZhCnAccountSettingsText("Session expires Jul 16, 2026")).toBe(
      "会话有效期至 Jul 16, 2026",
    );
  });

  it("translates anchored provider, skill, profile, usage, theme, and layout output", () => {
    expect(translateZhCnAccountSettingsText("Provider copies: Codex, Claude")).toBe(
      "服务商副本：Codex, Claude",
    );
    expect(translateZhCnAccountSettingsText("Provider copies: Antigravity")).toBe(
      "服务商副本：Antigravity",
    );
    expect(translateZhCnAccountSettingsText("Provider copy: Antigravity")).toBe(
      "服务商副本：Antigravity",
    );
    expect(translateZhCnAccountSettingsText("Antigravity binary path")).toBe(
      "Antigravity 二进制路径",
    );
    expect(translateZhCnAccountSettingsText("Antigravity server URL")).toBe(
      "Antigravity 服务器 URL",
    );
    expect(translateZhCnAccountSettingsText("Antigravity server password")).toBe(
      "Antigravity 服务器密码",
    );
    expect(
      translateZhCnAccountSettingsText(
        "Optional existing Antigravity server URL. Leave blank to spawn a local server.",
      ),
    ).toBe("可填写现有 Antigravity 服务器 URL；留空则启动本地服务器。");
    expect(
      translateZhCnAccountSettingsText(
        "Optional password for an externally managed Antigravity server.",
      ),
    ).toBe("外部管理的 Antigravity 服务器可选密码。");
    expect(translateZhCnAccountSettingsText("Enable the My Skill skill")).toBe(
      "启用 My Skill 技能",
    );
    expect(translateZhCnAccountSettingsText("Enable My Codex Work Account")).toBe(
      "启用 My Codex Work Account",
    );
    expect(translateZhCnAccountSettingsText("My Project · 1,234 prompts")).toBe(
      "My Project · 1,234 条提示词",
    );
    expect(translateZhCnAccountSettingsText("1.2k tokens on Jul 16")).toBe("Jul 16：1.2k 个 token");
    expect(translateZhCnAccountSettingsText("42% left")).toBe("剩余 42%");
    expect(translateZhCnAccountSettingsText("5h remaining")).toBe("5 小时剩余额度");
    expect(translateZhCnAccountSettingsText("Resets in 2h 16m")).toBe("将在 2 小时 16 分钟后重置");
    expect(translateZhCnAccountSettingsText("Usage pace: behind")).toBe("用量进度：超出预期");
    expect(translateZhCnAccountSettingsText("浅色主题 accent color")).toBe("浅色主题强调色");
    expect(translateZhCnAccountSettingsText("Reset Dark theme code font")).toBe(
      "重置深色主题代码字体",
    );
    expect(translateZhCnAccountSettingsText("Select next texture. Current texture: dots-2")).toBe(
      "选择下一个纹理。当前纹理：双点阵",
    );
    expect(translateZhCnAccountSettingsText("4 panes")).toBe("4 个窗格");
  });

  it("keeps product terms, credentials, providers, models, paths, diagnostics, and user text", () => {
    const values = [
      "Moss Key",
      "sk-secret-value",
      "moss@example.com",
      "/Users/moss/Codex/tools/apps/web/src/main.tsx",
      "Claude 3.7 Sonnet",
      "OpenAI gpt-5.4",
      "EPERM: operation not permitted",
      "Please keep my English account label exactly as written.",
    ];

    for (const value of values) {
      expect(translateZhCnAccountSettingsText(value)).toBe(value);
    }
  });

  it("does not partially match dynamic account/settings sentences", () => {
    const values = [
      "prefix 3 saved accounts",
      "3 saved accounts on this device",
      "Use not-an-email",
      "Provider copies: Codex, CustomProvider",
      "Resets in 2h 16m after renewal",
      "Select next texture. Current texture: custom-pattern",
    ];

    for (const value of values) {
      expect(translateZhCnAccountSettingsText(value)).toBe(value);
    }
  });
});
