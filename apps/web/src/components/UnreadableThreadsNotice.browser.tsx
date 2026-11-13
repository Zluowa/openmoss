import "../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", () => ({ useParams: () => undefined }));
vi.mock("../hooks/useDiffRouteSearch", () => ({ useDiffRouteSearch: () => ({}) }));

import { MossLocaleScope } from "~/localization";
import { ToastProvider } from "./ui/toast";
import {
  UnreadableThreadsNotice,
  formatUnreadableThreadDetails,
  publishUnreadableThreads,
} from "./UnreadableThreadsNotice";

const UNREADABLE = [
  { id: "thread-bad", reason: 'Expected string, got null at ["modelSelection"]' },
];

describe("UnreadableThreadsNotice", () => {
  it("says once, in one line, that a conversation was hidden, and offers its details", async () => {
    await render(
      <MossLocaleScope locale="zh-CN">
        <ToastProvider>
          <UnreadableThreadsNotice />
        </ToastProvider>
      </MossLocaleScope>,
    );
    publishUnreadableThreads(UNREADABLE);
    const notice = page.getByText("有 1 个对话的数据已损坏，已暂时隐藏。其他对话不受影响。");
    await expect.element(notice).toBeVisible();
    await expect.element(page.getByRole("button", { name: "复制详情" })).toBeVisible();

    // The next snapshot with the same set does not stack a second notice.
    publishUnreadableThreads([...UNREADABLE]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.getByText("有 1 个对话的数据已损坏").elements()).toHaveLength(1);

    // Once the conversation reads again, the notice goes away.
    publishUnreadableThreads(undefined);
    await expect.element(notice).not.toBeInTheDocument();
  });

  it("copies ids and reasons only", () => {
    expect(formatUnreadableThreadDetails(UNREADABLE)).toBe(
      "Moss could not read these conversations. Their data is still on this computer, unchanged.\n" +
        'thread-bad: Expected string, got null at ["modelSelection"]',
    );
  });
});
