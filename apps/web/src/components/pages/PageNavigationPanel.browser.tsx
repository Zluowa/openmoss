// FILE: PageNavigationPanel.browser.tsx
// Purpose: Verifies clickable outline headings, active highlight, and standalone DOM scroll fallback.
// Layer: Web page browser tests

import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { pageDocument } from "~/test/mossDataSpaceFixture";
import { TooltipProvider } from "../ui/tooltip";
import { PageNavigationPanel, type PageOutlineHeading } from "./PageSidePanels";

const markdown = ["# 概览", "正文", "## 数据指标", "一些指标", "### 细节拆分"].join("\n");
const fixturePage = pageDocument("page-nav-1", "Q4 规划", markdown).page;

describe("PageNavigationPanel", () => {
  it("clicks outline headings to jump and updates active highlight", async () => {
    const onSelectHeading = vi.fn<(heading: PageOutlineHeading) => void>();
    const mounted = await render(
      <TooltipProvider>
        <PageNavigationPanel
          page={fixturePage}
          pages={[fixturePage]}
          markdown={markdown}
          onSelect={() => {}}
          onSelectHeading={onSelectHeading}
        />
      </TooltipProvider>,
    );
    try {
      const target = page.getByRole("button", { name: "数据指标", exact: true });
      await expect.element(target).toBeVisible();
      await target.click();
      expect(onSelectHeading).toHaveBeenCalledWith({ line: 2, level: 2, text: "数据指标" });
      await expect.element(target).toHaveAttribute("aria-current", "location");
    } finally {
      await mounted.unmount();
    }
  });

  it("scrolls matching heading DOM element when onSelectHeading is omitted", async () => {
    const mounted = await render(
      <TooltipProvider>
        <div>
          <PageNavigationPanel
            page={fixturePage}
            pages={[fixturePage]}
            markdown={markdown}
            onSelect={() => {}}
          />
          <article>
            <h2>数据指标</h2>
          </article>
        </div>
      </TooltipProvider>,
    );
    try {
      const headingEl = document.querySelector("article h2") as HTMLElement;
      const scrollSpy = vi.fn();
      headingEl.scrollIntoView = scrollSpy;
      await page.getByRole("button", { name: "数据指标", exact: true }).click();
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    } finally {
      await mounted.unmount();
    }
  });
});
