import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { ThreadDetailHydrationState } from "./ThreadDetailHydrationState";

const UNREADABLE = { id: "thread-bad", reason: 'Expected string, got null at ["modelSelection"]' };

describe("ThreadDetailHydrationState", () => {
  for (const state of ["loading", "failed"] as const) {
    it(`shows one plain line and Copy details for an unreadable conversation (${state})`, async () => {
      const onRetry = vi.fn();
      const screen = await render(
        <MossLocaleScope locale="zh-CN">
          <ThreadDetailHydrationState state={state} onRetry={onRetry} unreadable={UNREADABLE} />
        </MossLocaleScope>,
      );
      await expect
        .element(page.getByText("这个对话的数据已损坏，无法打开。其他对话不受影响。"))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "复制详情" })).toBeVisible();
      // No spinner and no retry: retrying cannot make the stored data readable.
      expect(screen.container.querySelector("[aria-label='Loading conversation']")).toBeNull();
      expect(page.getByRole("button", { name: "Try again" }).elements()).toHaveLength(0);
      await screen.unmount();
    });
  }

  it("keeps the loading and failed states for a conversation that is not unreadable", async () => {
    const screen = await render(<ThreadDetailHydrationState state="failed" onRetry={vi.fn()} />);
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await screen.unmount();
  });
});
