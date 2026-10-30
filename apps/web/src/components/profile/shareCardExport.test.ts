import { describe, expect, it } from "vitest";

import { shareIntentUrl } from "./shareCardExport";

describe("shareIntentUrl", () => {
  it("localizes curated social copy without changing the Moss handle or URL", () => {
    const zhTweet = new URL(shareIntentUrl("x", "zh-CN"));
    expect(zhTweet.searchParams.get("text")).toBe(
      "晒一下我的 @tryMoss 开发数据。这个 IDE 简直是艺术品。",
    );

    const zhReddit = new URL(shareIntentUrl("reddit", "zh-CN"));
    expect(zhReddit.searchParams.get("url")).toBe("https://trymoss.com");
    expect(zhReddit.searchParams.get("title")).toBe("我的 Moss 开发数据");

    const enTweet = new URL(shareIntentUrl("x", "en"));
    expect(enTweet.searchParams.get("text")).toContain("@tryMoss dev stats");
  });
});
