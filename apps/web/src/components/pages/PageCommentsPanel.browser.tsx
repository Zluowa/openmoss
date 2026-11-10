// FILE: PageCommentsPanel.browser.tsx
// Purpose: Combined comments retain separate load states, permissions, and reply actions.
// Layer: Web page browser tests

import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import type { PageCommentFeedItem } from "~/lib/pageCommentFeed";
import { useTheme } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE } from "~/theme/theme.logic";

import { PageCommentsPanel, type PageCommentSourceStatus } from "./PageSidePanels";

const comments: readonly PageCommentFeedItem[] = [
  {
    key: "page:1",
    source: "page",
    authorKind: "owner",
    authorName: null,
    content: "Local comment fixture",
    createdAt: "2026-11-06T00:00:00.000Z",
  },
  {
    key: "share:1",
    source: "share",
    authorKind: "guest",
    authorName: "Lin",
    content: "Guest comment fixture",
    createdAt: "2026-11-06T00:01:00.000Z",
  },
];
const ready: PageCommentSourceStatus = { error: null, loading: false, onRetry: () => {} };

function ThemeListener() {
  useTheme();
  return null;
}

describe("Page comments", () => {
  it("routes a guest reply separately from a page-local comment", async () => {
    const reply = vi.fn();
    const submit = vi.fn(async () => true);
    const mounted = await render(
      <MossLocaleScope locale="en">
        <PageCommentsPanel
          comments={comments}
          localStatus={ready}
          shareStatus={ready}
          readOnly={false}
          busy={false}
          onReplyGuest={reply}
          onSubmit={submit}
        />
      </MossLocaleScope>,
    );
    try {
      await page.getByRole("button", { name: "Reply to guests" }).click();
      expect(reply).toHaveBeenCalledOnce();
      expect(submit).not.toHaveBeenCalled();
      await page.getByRole("textbox", { name: "Add page comment" }).fill("Local only");
      await page.getByRole("button", { name: "Add page comment", exact: true }).click();
      expect(submit).toHaveBeenCalledWith("Local only");
      expect(reply).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["page", "share"] as const)(
    "keeps the other source visible when %s comments fail",
    async (source) => {
      const retry = vi.fn();
      const failed = {
        error: new Error("raw-provider-stack-must-not-display"),
        loading: false,
        onRetry: retry,
      };
      const visible = comments.filter((comment) => comment.source !== source);
      const mounted = await render(
        <MossLocaleScope locale="zh-CN">
          <PageCommentsPanel
            comments={visible}
            localStatus={source === "page" ? failed : ready}
            shareStatus={source === "share" ? failed : ready}
            readOnly={false}
            busy={false}
            onReplyGuest={() => {}}
            onSubmit={async () => true}
          />
        </MossLocaleScope>,
      );
      try {
        await expect.element(page.getByText(visible[0]!.content)).toBeVisible();
        await expect
          .element(page.getByRole("alert"))
          .toHaveTextContent(
            source === "page"
              ? "页面评论暂时无法加载。"
              : "访客评论暂时无法加载，其他评论仍可查看。",
          );
        await expect
          .element(page.getByText("raw-provider-stack-must-not-display"))
          .not.toBeInTheDocument();
        await page.getByRole("button", { name: "重试", exact: true }).click();
        expect(retry).toHaveBeenCalledOnce();
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("hides both local and share reply actions for a read-only page", async () => {
    const mounted = await render(
      <MossLocaleScope locale="en">
        <PageCommentsPanel
          comments={comments}
          localStatus={ready}
          shareStatus={ready}
          readOnly
          busy={false}
          onReplyGuest={() => {}}
          onSubmit={async () => true}
        />
      </MossLocaleScope>,
    );
    try {
      await expect.element(page.getByText("Guest comment fixture")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Reply to guests" }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("shows the combined panel in light and dark themes", async () => {
    const previousTheme = localStorage.getItem("moss:theme");
    const mounted = await render(
      <MossLocaleScope locale="zh-CN">
        <ThemeListener />
        <div data-testid="comments-preview" className="w-80 bg-background p-3 text-foreground">
          <PageCommentsPanel
            comments={comments}
            localStatus={ready}
            shareStatus={ready}
            readOnly={false}
            busy={false}
            onReplyGuest={() => {}}
            onSubmit={async () => true}
          />
        </div>
      </MossLocaleScope>,
    );
    try {
      const backgrounds: string[] = [];
      for (const theme of ["light", "dark"] as const) {
        localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: theme }));
        window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
        await vi.waitFor(() =>
          expect(document.documentElement.getAttribute("data-theme-variant")).toBe(theme),
        );
        await expect.element(page.getByText("Guest comment fixture")).toBeVisible();
        backgrounds.push(
          getComputedStyle(document.querySelector('[data-testid="comments-preview"]')!)
            .backgroundColor,
        );
        await page.screenshot({ path: `node_modules/.cache/page-comments-${theme}.png` });
      }
      expect(backgrounds[0]).not.toBe(backgrounds[1]);
    } finally {
      if (previousTheme === null) localStorage.removeItem("moss:theme");
      else localStorage.setItem("moss:theme", previousTheme);
      window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
      await mounted.unmount();
    }
  });
});
