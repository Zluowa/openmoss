import { describe, expect, it } from "vitest";

import {
  chatFileKindLabel,
  formatChatRelativeTimeAgo,
  isChatHtmlPagePath,
  readHtmlDocumentTitle,
} from "./chatFileKind";

describe("chatFileKind", () => {
  it("names what a file in a reply is", () => {
    expect(chatFileKindLabel("site/index.html")).toBe("HTML page");
    expect(chatFileKindLabel("C:\\work\\page.HTM")).toBe("HTML page");
    expect(chatFileKindLabel("notes/readme.md")).toBe("Markdown document");
    expect(chatFileKindLabel("shot.png")).toBe("Image");
    expect(chatFileKindLabel("paper.pdf")).toBe("PDF document");
    expect(chatFileKindLabel("src/app.ts")).toBe("File");
    expect(chatFileKindLabel("src/")).toBe("Folder");
    expect(isChatHtmlPagePath("a/b/index.html")).toBe(true);
    expect(isChatHtmlPagePath("index.html.bak")).toBe(false);
  });

  it("reads a page title as plain text", () => {
    expect(readHtmlDocumentTitle("<head><title>盖碗冲泡计时</title></head>")).toBe("盖碗冲泡计时");
    expect(readHtmlDocumentTitle("<TITLE lang=en>\n  Tea &amp; timer &#x2764;  </TITLE>")).toBe(
      "Tea & timer \u2764",
    );
    // Title text is RCDATA: markup inside it is shown as text, never run.
    expect(readHtmlDocumentTitle("<title><b>x</b></title>")).toBe("<b>x</b>");
    expect(readHtmlDocumentTitle("<title>   </title>")).toBe(null);
    expect(readHtmlDocumentTitle("<h1>No title</h1>")).toBe(null);
    expect(readHtmlDocumentTitle(`<title>${"a".repeat(400)}</title>`)?.length).toBe(160);
  });

  it("formats the hover card time like the desktop chat", () => {
    const now = Date.parse("2026-11-03T10:00:00Z");
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(formatChatRelativeTimeAgo("2026-11-03T09:59:30Z", "en")).toBe("Just now");
      expect(formatChatRelativeTimeAgo("2026-11-03T09:59:00Z", "en")).toBe("1m ago");
      expect(formatChatRelativeTimeAgo("2026-11-03T07:00:00Z", "en")).toBe("3h ago");
      expect(formatChatRelativeTimeAgo("2026-11-03T09:59:30Z", "zh-CN")).toBe("刚刚");
      expect(formatChatRelativeTimeAgo("2026-11-03T09:55:00Z", "zh-CN")).toBe("5 分钟前");
    } finally {
      Date.now = realNow;
    }
  });
});
