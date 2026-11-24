// FILE: codeReviewTabs.browser.tsx
// Purpose: 代码审查's two tab rows on the shared Tabs (lead 11-24, one tab look for views inside
//          a page): the kind filter is the segmented control with its row counts, an item's views
//          are the 资料空间 tabs with the changed-lines count riding after 文件.
// Layer: GitHub inbox presentation browser regression

import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { GitHubItemTabs } from "../pullRequest/GitHubItemPageLayout";
import { GitHubInboxFilterBar } from "./GitHubInboxFilterBar";

afterEach(async () => {
  await cleanup();
});

it("draws the kind filter as the shared segmented control, each choice with its count", async () => {
  const onKindChange = vi.fn();
  await render(
    <MossLocaleScope locale="en">
      <div className="w-[360px] bg-background">
        <GitHubInboxFilterBar
          filters={{
            kind: "all",
            state: "open",
            involvement: "everything",
            projectIds: [],
            labels: [],
          }}
          sort="updated"
          onSortChange={() => {}}
          query=""
          kindCounts={{ all: 4, pullRequest: 2, issue: 2 }}
          projectOptions={[]}
          labelOptions={[]}
          refreshing={false}
          refreshBlockedReason={null}
          onQueryChange={() => {}}
          onKindChange={onKindChange}
          onStateChange={() => {}}
          onInvolvementChange={() => {}}
          onProjectIdsChange={() => {}}
          onLabelsChange={() => {}}
          onClearFilters={() => {}}
          onRefresh={() => {}}
          onPasteReference={() => false}
        />
      </div>
    </MossLocaleScope>,
  );
  const all = page.getByRole("tab", { name: "All, 4" });
  await expect.element(all).toHaveAttribute("aria-selected", "true");
  const strip = all.element().closest<HTMLElement>("[data-slot='tabs']")!;
  expect(strip.getAttribute("data-variant")).toBe("segmented");
  const pullRequests = page.getByRole("tab", { name: "Pull requests, 2" }).element() as HTMLElement;
  // The shared segment: 24 high at the 6 px radius, the count after the label, quieter.
  expect(pullRequests.getBoundingClientRect().height).toBe(24);
  expect(getComputedStyle(pullRequests).borderTopLeftRadius).toBe("6px");
  const count = pullRequests.querySelector<HTMLElement>("[data-slot='tab-trailing']")!;
  expect(count.textContent).toBe("2");
  // On an unselected tab the label is muted ink; the count is quieter still (the 70% muted
  // token), so the two never measure the same.
  expect(getComputedStyle(count).color).not.toBe(getComputedStyle(pullRequests).color);
  // And on the selected tab, whose label is full ink.
  const selectedCount = all.element().querySelector<HTMLElement>("[data-slot='tab-trailing']")!;
  expect(getComputedStyle(selectedCount).color).not.toBe(getComputedStyle(all.element()).color);
  await userEvent.click(pullRequests);
  expect(onKindChange).toHaveBeenCalledWith("pullRequest");
  expect(document.querySelector("[role='radiogroup']")).toBeNull();
});

it("draws an item's views as the shared tabs, with the changed lines after 文件", async () => {
  const onChange = vi.fn();
  await render(
    <MossLocaleScope locale="zh-CN">
      <GitHubItemTabs
        label="Pull request detail tabs"
        value="summary"
        onChange={onChange}
        tabs={[
          { value: "summary", label: "概览" },
          { value: "code", label: "文件", trailing: <span>+12 −3</span> },
          { value: "timeline", label: "时间线" },
        ]}
      />
    </MossLocaleScope>,
  );
  const strip = page.getByRole("tablist", { name: "Pull request detail tabs" });
  await expect.element(strip).toBeVisible();
  expect(strip.element().getAttribute("data-variant")).toBe("tabs");
  const overview = page.getByRole("tab", { name: "概览" }).element() as HTMLElement;
  expect(overview.getAttribute("aria-selected")).toBe("true");
  // The 资料空间 tab: 28 high, radius 8, 14 px.
  expect(overview.getBoundingClientRect().height).toBe(28);
  expect(getComputedStyle(overview).borderTopLeftRadius).toBe("8px");
  expect(getComputedStyle(overview).fontSize).toBe("14px");
  const files = page.getByRole("tab", { name: /文件/ }).element() as HTMLElement;
  expect(files.querySelector("[data-slot='tab-trailing']")?.textContent).toBe("+12 −3");
  // Arrow keys move between the views, as in any tablist.
  overview.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenCalledWith("code");
  expect(document.querySelector("nav[aria-label='Pull request detail tabs']")).toBeNull();
});
