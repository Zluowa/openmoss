// FILE: GitHubInboxFilterBar.browser.tsx
// Purpose: The code review filter bar's 清除 is the shared ghost Button (13 px, the normal weight role),
//          not a hand-drawn button.
// Layer: GitHub inbox presentation browser regression

import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { GitHubInboxFilterBar } from "./GitHubInboxFilterBar";

/** The weight a type role resolves to in Moss's CSS (font-normal is 380, font-medium 475). */
function roleWeight(className: string): string {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const weight = getComputedStyle(probe).fontWeight;
  probe.remove();
  return weight;
}

afterEach(async () => {
  await cleanup();
});

it("draws 清除 as the shared ghost Button and clears the filters", async () => {
  const onClearFilters = vi.fn();
  await render(
    <MossLocaleScope locale="zh-CN">
      <div className="w-[360px] bg-background">
        <GitHubInboxFilterBar
          filters={{
            kind: "all",
            state: "closed",
            involvement: "everything",
            projectIds: [],
            labels: [],
          }}
          sort="updated"
          onSortChange={() => {}}
          query=""
          kindCounts={null}
          projectOptions={[]}
          labelOptions={[]}
          refreshing={false}
          refreshBlockedReason={null}
          onQueryChange={() => {}}
          onKindChange={() => {}}
          onStateChange={() => {}}
          onInvolvementChange={() => {}}
          onProjectIdsChange={() => {}}
          onLabelsChange={() => {}}
          onClearFilters={onClearFilters}
          onRefresh={() => {}}
          onPasteReference={() => false}
        />
      </div>
    </MossLocaleScope>,
  );
  const clear = page.getByRole("button", { name: "清除", exact: true });
  await expect.element(clear).toBeVisible();
  const element = clear.element() as HTMLElement;
  expect(element.getAttribute("data-slot")).toBe("button");
  const style = getComputedStyle(element);
  expect(style.fontSize).toBe("13px");
  expect(style.fontWeight).toBe(roleWeight("font-normal"));
  await clear.click();
  expect(onClearFilters).toHaveBeenCalledTimes(1);
});
