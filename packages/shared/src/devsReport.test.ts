import { describe, expect, it } from "vitest";
import {
  devsSecondsUntilNextDay,
  devsUtcDay,
  parseDevsInvocation,
  readDevsDailyLimit,
  redactDevsReportText,
} from "./devsReport";

describe("developer mentions", () => {
  it.each(["@devs 切换模型后卡住了", "  @devs: 切换模型后卡住了", "@DEVS，切换模型后卡住了"])(
    "recognizes a message that starts with the tag: %s",
    (text) => {
      expect(parseDevsInvocation(text)?.description).toBe("切换模型后卡住了");
    },
  );
  it.each([
    "请看看 @devs 切换模型后卡住了",
    "I asked @devs about this yesterday",
    "@ devs 切换模型后卡住了",
    "user@devs.example",
    "@devstuff bug",
    "@devs-team bug",
    "\\@devs bug",
    "https://example.test/@devs",
    "`@devs`",
    "```text\n@devs bug\n```",
  ])("treats every other mention as chat text: %s", (text) => {
    expect(parseDevsInvocation(text)).toBeNull();
  });
  it("selects either engine and keeps later mentions verbatim", () => {
    expect(parseDevsInvocation("@DEVS codex: fix `@devs` after @devs")).toEqual({
      engine: "codex",
      description: "fix `@devs` after @devs",
    });
    expect(parseDevsInvocation("@devs claude：窗口打不开")).toEqual({
      engine: "claude",
      description: "窗口打不开",
    });
  });
  it("does not steal longer engine names", () => {
    expect(parseDevsInvocation("@devs codexSettings broken")).toEqual({
      description: "codexSettings broken",
    });
  });
});

describe("developer report redaction", () => {
  it.each([
    ["my password is hunter2", "hunter2"],
    ["我的密码是abc123，请帮忙", "abc123"],
    ["key moss_sk_AbC123xyz failed", "moss_sk_AbC123xyz"],
    ["stripe sk_live_51Habc broke", "sk_live_51Habc"],
    ["token Xy7Kq2LmN9pQr4sT expired", "Xy7Kq2LmN9pQr4sT"],
    ["mail 张三@例子.中国 now", "张三@例子.中国"],
    ["mail bob@example.com now", "bob@example.com"],
    ["call 13812345678 now", "13812345678"],
    ["call me on 13812345678.", "13812345678"],
    ["座机 010-12345678。", "010-12345678"],
    ["call 555-123-4567.", "555-123-4567"],
    ["call +86 138 1234 5678 now", "138 1234 5678"],
    ["call 010-12345678 now", "010-12345678"],
    ["call +1 (555) 123-4567 now", "555"],
    ["call 555-123-4567 now", "555-123-4567"],
    ["open D:\\work\\acme-secret\\src\\app.ts", "acme-secret"],
    ["open /var/www/acme/config.yml", "acme"],
    ["open \\\\corp-share\\team\\plan.docx", "corp-share"],
    ["open C:\\Users\\Alice Smith\\moss\\x.ts", "Alice"],
  ])("removes private details: %s", (text, secret) => {
    expect(redactDevsReportText(text, 5_000)).not.toContain(secret);
  });
  it("keeps ordinary problem descriptions readable", () => {
    const text =
      "登录时提示密码错误 ERR_HTTP2_PROTOCOL_ERROR in useChatTurnSubmission at 2026-11-03 12:30:45, version 1.4.4, and/or 1/2/3";
    expect(redactDevsReportText(text, 5_000)).toBe(text);
    expect(redactDevsReportText("open D:\\work\\src\\app.ts", 5_000)).toBe("open <path>/app.ts");
  });
  it("stays within its length limit", () => {
    expect(redactDevsReportText("x".repeat(100), 10)).toHaveLength(10);
  });
});

describe("developer report daily caps", () => {
  it("reads configured caps and falls back on anything invalid", () => {
    expect(readDevsDailyLimit("5", 20)).toBe(5);
    expect(readDevsDailyLimit("0", 20)).toBe(0);
    for (const value of [undefined, "", "-1", "2.5", "lots", "10001"])
      expect(readDevsDailyLimit(value, 20)).toBe(20);
  });
  it("counts against UTC days", () => {
    const now = Date.parse("2026-11-03T23:59:00Z");
    expect(devsUtcDay(now)).toBe("2026-11-03");
    expect(devsSecondsUntilNextDay(now)).toBe(60);
  });
});
