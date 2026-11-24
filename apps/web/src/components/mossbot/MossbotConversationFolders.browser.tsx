import "~/index.css";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import { MossLocaleScope } from "~/localization";
import { MossbotNewConversationMenu } from "./MossbotConversationFolders";

describe("MossbotNewConversationMenu", () => {
  it("N8-3: in the sidebar, + offers 新建群聊 and 新建分组 but not a second 新建助手", async () => {
    const onAssistant = vi.fn();
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <MossbotNewConversationMenu
          sidebar
          onAssistant={onAssistant}
          onRoom={vi.fn()}
          onFolder={vi.fn()}
        />
      </MossLocaleScope>,
    );
    try {
      await userEvent.click(page.getByRole("button", { name: "新建群聊" }));
      await expect.element(page.getByRole("menuitem", { name: "新建群聊" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "新建分组" })).toBeVisible();
      expect(page.getByRole("menuitem", { name: "新建助手" }).all()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps 新建助手 first on the page header, where there is no sidebar row", async () => {
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <MossbotNewConversationMenu onAssistant={vi.fn()} onRoom={vi.fn()} onFolder={vi.fn()} />
      </MossLocaleScope>,
    );
    try {
      await userEvent.click(page.getByRole("button", { name: "新建助手或群聊" }));
      await expect.element(page.getByRole("menuitem", { name: "新建助手" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
