import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadSummaryPanelContent } from "./ThreadSummaryPanel";

describe("ThreadSummaryPanelContent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a three-source preview and opens the complete Sources surface", async () => {
    const onOpenSource = vi.fn();
    const screen = await render(
      <ThreadSummaryPanelContent
        artifacts={[]}
        sources={[
          { id: "one", label: "one.txt", kind: "file", target: "/tmp/one.txt" },
          { id: "two", label: "two.txt", kind: "file", target: "/tmp/two.txt" },
          { id: "three", label: "three.txt", kind: "file", target: "/tmp/three.txt" },
          { id: "four", label: "four.txt", kind: "file", target: "/tmp/four.txt" },
        ]}
        subagents={[]}
        processes={[]}
        onOpenSource={onOpenSource}
      />,
    );

    try {
      await expect.element(page.getByText("one.txt", { exact: true })).toBeVisible();
      await expect.element(page.getByText("three.txt", { exact: true })).toBeVisible();
      await expect.element(page.getByText("four.txt", { exact: true })).not.toBeInTheDocument();

      await page.getByRole("button", { name: "查看全部" }).click();
      await expect.element(page.getByTestId("thread-summary-sources-sheet")).toBeVisible();
      await expect.element(page.getByText("four.txt", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "打开来源 four.txt" }).click();

      expect(onOpenSource).toHaveBeenCalledExactlyOnceWith({
        id: "four",
        label: "four.txt",
        kind: "file",
        target: "/tmp/four.txt",
      });
    } finally {
      await screen.unmount();
    }
  });
});
