import { describe, expect, it } from "vitest";

import { WHATS_NEW_ENTRIES } from "../whatsNew/entries";
import { translateZhCnWhatsNewText } from "./zhCNWhatsNew";

const releaseFields = () =>
  WHATS_NEW_ENTRIES.flatMap((entry) =>
    entry.features.flatMap((feature) =>
      [feature.title, feature.description, feature.details].filter(
        (value): value is string => typeof value === "string",
      ),
    ),
  );

describe("translateZhCnWhatsNewText", () => {
  it("covers every curated release field", () => {
    const fields = releaseFields();

    expect(WHATS_NEW_ENTRIES).toHaveLength(73);
    expect(WHATS_NEW_ENTRIES.reduce((total, entry) => total + entry.features.length, 0)).toBe(513);
    expect(fields).toHaveLength(1402);

    for (const field of fields) {
      const translated = translateZhCnWhatsNewText(field);
      expect(translated, field).not.toBe(field);
      expect(translated, field).toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it("keeps unknown external text untouched", () => {
    expect(translateZhCnWhatsNewText("A user-authored release note from elsewhere.")).toBe(
      "A user-authored release note from elsewhere.",
    );
    expect(translateZhCnWhatsNewText("/Users/moss/project/README.md")).toBe(
      "/Users/moss/project/README.md",
    );
  });

  it("translates release chrome, dates, and update counts", () => {
    expect(translateZhCnWhatsNewText("What's New")).toBe("新功能");
    expect(translateZhCnWhatsNewText("Release history")).toBe("发布历史");
    expect(translateZhCnWhatsNewText("Every curated release, newest first.")).toBe(
      "所有精选版本，按时间从新到旧排列。",
    );
    const months = [
      ["Jan", "1月"],
      ["Feb", "2月"],
      ["Mar", "3月"],
      ["Apr", "4月"],
      ["May", "5月"],
      ["Jun", "6月"],
      ["Jul", "7月"],
      ["Aug", "8月"],
      ["Sep", "9月"],
      ["Oct", "10月"],
      ["Nov", "11月"],
      ["Dec", "12月"],
    ] as const;

    for (const [month, translated] of months) {
      expect(translateZhCnWhatsNewText(`${month} 8`)).toBe(`${translated}8日`);
    }
    expect(translateZhCnWhatsNewText("1 update")).toBe("1 项更新");
    expect(translateZhCnWhatsNewText("24 updates")).toBe("24 项更新");
  });

  it("uses product-quality copy for the most visible recent releases", () => {
    expect(translateZhCnWhatsNewText("Quit without silently abandoning running chats")).toBe(
      "退出时不再悄然放弃仍在运行的对话",
    );
    expect(translateZhCnWhatsNewText("Agents can use the visible browser")).toBe(
      "智能体可直接操作眼前的浏览器",
    );
    expect(translateZhCnWhatsNewText("Stop stays responsive under load")).toBe(
      "高负载下仍能及时停止",
    );
    expect(translateZhCnWhatsNewText("Follow-ups no longer disappear into stale queues")).toBe(
      "后续消息不会再消失在失效队列中",
    );
    expect(translateZhCnWhatsNewText("Every agent's live tool work is visible")).toBe(
      "所有智能体的实时工具操作均清晰可见",
    );
    expect(translateZhCnWhatsNewText("Choose whether follow-ups queue or steer")).toBe(
      "选择后续消息排队或立即引导",
    );
    expect(translateZhCnWhatsNewText("Mainland phone login completes reliably")).toBe(
      "中国大陆手机号登录更稳定",
    );
    expect(translateZhCnWhatsNewText("Review pull requests without leaving Moss")).toBe(
      "无需离开 Moss 即可审阅拉取请求",
    );
    expect(translateZhCnWhatsNewText("AppSnaps wait safely until you send")).toBe(
      "AppSnap 截图会安全保留到发送时",
    );
    expect(translateZhCnWhatsNewText("Factory Droid is now a first-class provider")).toBe(
      "Factory Droid 成为原生支持的服务商",
    );
    expect(translateZhCnWhatsNewText("Moss, all the way through")).toBe(
      "从内到外，全面统一为 Moss",
    );
    expect(translateZhCnWhatsNewText("A dedicated Studio workspace for agent-led work")).toBe(
      "面向智能体任务的专属 Studio 工作区",
    );
  });

  it("preserves product names, technical names, paths, and versions", () => {
    const protectedTerms = ["Moss", "AppSnap", "Codex", "Claude", "GitHub", "API"];

    for (const field of releaseFields()) {
      const translated = translateZhCnWhatsNewText(field);
      for (const term of protectedTerms) {
        if (field.includes(term)) expect(translated, field).toContain(term);
      }

      for (const version of field.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g) ?? []) {
        expect(translated, field).toContain(version);
      }
      for (const match of field.matchAll(
        /(?:^|[\s(])((?:~\/|\/)[A-Za-z0-9._@%+~/-]*[A-Za-z0-9_@%+~/-])/g,
      )) {
        const path = match[1];
        if (path) expect(translated, field).toContain(path);
      }
    }
  });

  it("preserves product and technical names in 0.6.4", () => {
    const entry = WHATS_NEW_ENTRIES.find((candidate) => candidate.version === "0.6.4");
    expect(entry).toBeDefined();

    const fields =
      entry?.features.flatMap((feature) =>
        [feature.title, feature.description, feature.details].filter(
          (value): value is string => typeof value === "string",
        ),
      ) ?? [];
    const sourceCopy = fields.join("\n");
    const translatedCopy = fields.map(translateZhCnWhatsNewText).join("\n");
    const protectedTerms = [
      "Moss",
      "Electron WebView",
      "Codex",
      "Claude Code",
      "Claude",
      "Antigravity",
      "Git",
      "PR",
      "permessage-deflate",
      ".github",
      "Dock",
      "hook",
      "role",
      "name",
      "text",
      "selector",
      "ref",
    ];

    for (const term of protectedTerms) {
      if (sourceCopy.includes(term)) expect(translatedCopy).toContain(term);
    }
  });

  it("preserves product and technical names in 0.7.1", () => {
    const entry = WHATS_NEW_ENTRIES.find((candidate) => candidate.version === "0.7.1");
    expect(entry).toBeDefined();

    const fields =
      entry?.features.flatMap((feature) =>
        [feature.title, feature.description, feature.details].filter(
          (value): value is string => typeof value === "string",
        ),
      ) ?? [];
    const sourceCopy = fields.join("\n");
    const translatedCopy = fields.map(translateZhCnWhatsNewText).join("\n");
    const protectedTerms = [
      "Moss",
      "WebSocket",
      "Git",
      "PR",
      "Explorer",
      "worktree",
      "Claude",
      "Codex",
      "OpenCode",
      "Grok",
      "Kilo",
      "Antigravity",
      "ACP",
      "AskUserQuestion",
      "API",
      "Windows",
      "macOS",
      "Markdown",
      "GitHub-flavored Markdown",
      "shim",
      "diff",
    ];

    for (const term of protectedTerms) {
      if (sourceCopy.includes(term)) expect(translatedCopy).toContain(term);
    }
  });

  it("avoids literal machine-translation jargon in 0.5.x and 0.4.x notes", () => {
    const recentCopy = WHATS_NEW_ENTRIES.slice(0, 7)
      .flatMap((entry) =>
        entry.features.flatMap((feature) =>
          [feature.title, feature.description, feature.details]
            .filter((value): value is string => typeof value === "string")
            .map(translateZhCnWhatsNewText),
        ),
      )
      .join("\n");

    expect(recentCopy).not.toMatch(
      /突变|水化|作曲家|降价|一流的提供商|代理|提供程序|提供者|提供商|令牌|工作空间|转录|成绩单/u,
    );
  });

  it("uses consistent product terminology throughout every curated release", () => {
    const allCopy = releaseFields().map(translateZhCnWhatsNewText).join("\n");

    expect(allCopy).not.toMatch(
      /作曲家|降价|提供程序|提供者|提供商|代理|线程|转录本|成绩单|文字记录|令牌|代币|存储库|工件|审查|审核|水化|固定装置|原语|逃生舱口|拇指|家庭聊天|转弯|轮流|新鲜|平静|扫描|探针|门控|叉子|标头|侧车|突变|工作空间|投影|流媒体|手风琴|垫片|摄取|边车|芯片|路线|图钉|toast/u,
    );
  });
});
