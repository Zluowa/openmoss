// FILE: threadSystemTitle.test.ts
// Purpose: Guards display-only localization of exact Moss-generated legacy thread titles.
// Layer: Web UI localization helper tests

import { describe, expect, it } from "vitest";

import { resolveLocalizedSystemThreadTitle } from "./threadSystemTitle";

describe("resolveLocalizedSystemThreadTitle", () => {
  it("localizes the exact legacy voice-chat default without rewriting persistence", () => {
    expect(resolveLocalizedSystemThreadTitle("New voice chat", "en")).toBe("New voice chat");
    expect(resolveLocalizedSystemThreadTitle("New voice chat", "zh-CN")).toBe("新建语音对话");
  });

  it("localizes the exact terminal default without rewriting persistence", () => {
    expect(resolveLocalizedSystemThreadTitle("New terminal", "en")).toBe("New terminal");
    expect(resolveLocalizedSystemThreadTitle("New terminal", "zh-CN")).toBe("新建终端");
  });

  it.each([
    " New voice chat",
    "New voice chat ",
    "new voice chat",
    "New voice chat for release review",
    "User renamed: New voice chat",
    "新建语音对话",
    " New terminal",
    "New terminal ",
    "new terminal",
    "New terminal for release review",
    "User renamed: New terminal",
    "新建终端",
  ])("preserves user-authored or dynamic title %j exactly", (title) => {
    expect(resolveLocalizedSystemThreadTitle(title, "zh-CN")).toBe(title);
  });
});
