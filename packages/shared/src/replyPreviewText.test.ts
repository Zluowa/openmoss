import { describe, expect, it } from "vitest";

import { PREVIEW_SECRET_MASK, replyPreviewPlainText } from "./replyPreviewText";

const preview = (markdown: string, truncated = false) => replyPreviewPlainText(markdown, truncated);

describe("reply preview text", () => {
  it("reads the owner's real final reply as its words and link labels", () => {
    expect(
      preview(
        "已完成：透明通道已验证，并应用到 Moss 聊天区域右下角，浅色/深色主题都已生效。\n\n" +
          "- [原始透明 PNG](C:/Users/person/Documents/Moss/2026-11-17/moss/outputs/a.png)\n" +
          "- [Moss 轻量版 WebP](C:/Users/person/Documents/Moss/2026-11-17/moss/outputs/b.webp)\n\n" +
          "![Moss](C:/Users/person/Documents/Moss/2026-11-17/moss/outputs/b.webp)",
      ),
    ).toBe(
      "已完成：透明通道已验证，并应用到 Moss 聊天区域右下角，浅色/深色主题都已生效。 · 原始透明 PNG · Moss 轻量版 WebP",
    );
  });

  it("leaves out OpenUI programs and visual tags", () => {
    expect(preview('Here it is:\n```openui\nroot = Button("Deploy")\n```\nDone.')).toBe(
      "Here it is: Done.",
    );
    expect(preview("Before <openui>root = Card()</openui> after")).toBe("Before after");
    expect(preview("Streaming <openui>root = Card(")).toBe("Streaming");
    expect(
      preview(
        '<cursor-content kind="visualization" src="a.html" title="Chart"></cursor-content>\nSummary line',
      ),
    ).toBe("Summary line");
  });

  it("keeps ordinary code as text", () => {
    expect(preview("Run `bun test` then:\n```bash\nbun run lint\n```")).toBe(
      "Run bun test then: bun run lint",
    );
  });

  it("drops HTML, alert markers, wiki-link brackets and table rules", () => {
    expect(preview("> [!NOTE]\n> Careful here.\n\nSee [[My Page]] and [[Other|that one]].")).toBe(
      "Careful here. See My Page and that one.",
    );
    expect(preview("line<br>two<br/>three <details><summary>More</summary>hidden</details>")).toBe(
      "line two three Morehidden",
    );
    expect(preview("| a | b |\n|---|:-:|\n| 1 | 2 |")).toBe("a · b 1 · 2");
  });

  it("masks credentials", () => {
    const key = `sk-ant-${"a1".repeat(15)}`;
    const text = preview(`The key ${key} is set; also ghp_${"x".repeat(36)}.`);
    expect(text).toBe(`The key ${PREVIEW_SECRET_MASK} is set; also ${PREVIEW_SECRET_MASK}.`);
    expect(text).not.toContain("sk-ant");
  });

  it("masks a credential cut where the read stopped", () => {
    expect(preview("Set MOSS_KEY=moss_sk_abc", true)).toBe(`Set MOSS_KEY=${PREVIEW_SECRET_MASK}`);
    expect(preview("token: ghp_abc12", true)).toBe(`token: ${PREVIEW_SECRET_MASK}`);
    // Assembled at run time so that secret scanners do not read the test value as a real key block.
    const keyBlockStart = ["-----BEGIN RSA", "PRIVATE KEY----- MIIEow"].join(" ");
    expect(preview(keyBlockStart, true)).toBe(PREVIEW_SECRET_MASK);
    // A complete reply that merely ends in a word like that is left alone.
    expect(preview("we tried sk-learn", false)).toBe("we tried sk-learn");
  });
});
