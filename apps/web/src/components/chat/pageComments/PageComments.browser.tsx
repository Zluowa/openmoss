// Comments on a visual page in the side panel: comment mode outlines and picks an element
// inside the sandboxed page, a posted comment leaves a pin on it, All comments lists it,
// and a comment sent to Moss becomes the thread's next message.
import "../../../index.css";
import { injectHtmlRenderBootstrap } from "@moss/shared/htmlRender";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const PAGE_URL = URL.createObjectURL(
  new Blob(
    [
      injectHtmlRenderBootstrap(
        `<main style="padding:24px;font-family:sans-serif">
          <h1 id="title">Gaiwan timer</h1>
          <p>Pick a tea, then press start.</p>
          <section class="card" style="margin-top:24px;padding:24px;border:1px solid #ccc;border-radius:12px">
            <h2 id="tea-name">Longjing</h2>
            <div class="dial" style="width:120px;height:120px;border-radius:50%;border:10px solid #2f6f5e;display:grid;place-items:center;font:600 28px monospace">0:20</div>
            <button type="button" style="margin-top:16px">Start</button>
          </section>
        </main>`,
      ),
    ],
    { type: "text/html" },
  ),
);

vi.mock("~/lib/htmlRenderFrameUrl", () => ({
  resolveHtmlRenderFrameUrl: async () => PAGE_URL,
}));

import { usePageCommentsStore } from "~/pageCommentsStore";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { useThreadSendRequestStore } from "~/threadSendRequestStore";

import { HtmlRenderPreviewPane } from "../HtmlRenderPreviewPane";

// The app's theme store owns the root's dark class; switch it the way another window would.
async function switchAppTheme(mode: "light" | "dark") {
  localStorage.setItem("moss:theme", mode);
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await vi.waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(mode === "dark"),
  );
}

afterEach(async () => {
  usePageCommentsStore.setState({ commentsByPage: {} });
  useThreadSendRequestStore.setState({ requests: [] });
  localStorage.removeItem("moss:theme");
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});

async function mountPane() {
  await page.viewport(900, 640);
  const client = new QueryClient();
  client.setQueryData(serverConfigQueryOptions().queryKey, { keybindings: [] } as never);
  return render(
    <QueryClientProvider client={client}>
      <div
        style={{ position: "fixed", top: 0, left: 0, width: 900, height: 640, display: "flex" }}
        className="bg-background"
      >
        <HtmlRenderPreviewPane
          threadId="thread-comments"
          document={{ kind: "html-render", attachmentId: "attachment-tea", title: "Gaiwan timer" }}
        />
      </div>
    </QueryClientProvider>,
  );
}

async function shot(name: string) {
  // Cards fade in over 280ms; let them settle first.
  await new Promise((resolve) => setTimeout(resolve, 320));
  // Kept beside the test (git-ignored) for side-by-side review against the reference.
  await page.screenshot({ path: `__screenshots__/annotate-and-comment/${name}.png` });
}

for (const theme of ["light", "dark"] as const) {
  it(`comments on an element of the page and sends it to Moss (${theme})`, async () => {
    const screen = await mountPane();
    await switchAppTheme(theme);
    try {
      const iframe = await vi.waitFor(() => {
        const element = document.querySelector("iframe");
        expect(element).not.toBeNull();
        return element!;
      });
      const frame = page.frameLocator(page.elementLocator(iframe));

      await page.getByRole("button", { name: "Comment on the page" }).click();
      await frame.getByText("Longjing", { exact: true }).hover();
      await shot(`comments-hover-${theme}`);
      await frame.getByText("Longjing", { exact: true }).click();

      const field = page.getByRole("textbox", { name: "Comment" });
      await expect.element(field).toBeVisible();
      await expect.element(page.getByText("h2#tea-name")).toBeVisible();
      await userEvent.type(field, "@Moss make the name larger");
      await expect.element(page.getByText("@Moss", { exact: true })).toBeVisible();
      await shot(`comments-new-${theme}`);
      await page.getByRole("button", { name: "Post comment" }).click();

      // The comment went to the thread as its next message, with where it points.
      const request = useThreadSendRequestStore.getState().requests[0];
      expect(request?.threadId).toBe("thread-comments");
      expect(request?.message).toContain("make the name larger");
      expect(request?.message).toContain("h2#tea-name");

      // Its thread card is open, with Moss thinking on it.
      await expect.element(page.getByRole("group", { name: "Comment thread" })).toBeVisible();
      await expect.element(page.getByText("thinking…")).toBeVisible();
      await shot(`comments-thread-${theme}`);

      // A pin sits on the element.
      const pin = await vi.waitFor(() => {
        const element = document.querySelector<HTMLElement>("[data-page-comment-pin]");
        expect(element).not.toBeNull();
        return element!;
      });
      const heading = document.querySelector("iframe")!.getBoundingClientRect();
      expect(pin.getBoundingClientRect().top).toBeGreaterThan(heading.top);

      // All comments lists it with its reply.
      await page.getByRole("button", { name: "Comment options" }).click();
      await page.getByRole("menuitem", { name: "All comments" }).click();
      const panel = page.getByRole("dialog", { name: "All comments" });
      await expect.element(panel).toBeVisible();
      await expect.element(panel.getByText("1 reply")).toBeVisible();
      await shot(`comments-panel-${theme}`);
    } finally {
      await screen.unmount();
    }
  });
}

it("marks comments unread until the page's comments are opened", async () => {
  usePageCommentsStore.getState().addComment({
    id: "c1",
    pageKey: "html-render:attachment-tea",
    threadId: "thread-comments",
    anchor: { selector: "#tea-name", label: "h2#tea-name", text: "Longjing" },
    author: { name: "Hongyan", initials: "HO" },
    body: "测试",
    createdAt: new Date().toISOString(),
    sentToAgentAt: null,
    replies: [],
    read: false,
  });
  const screen = await mountPane();
  await switchAppTheme("dark");
  try {
    await expect
      .element(page.getByRole("button", { name: "Unread comment from Hongyan" }))
      .toBeVisible();
    expect(document.querySelector("[data-page-comments-unread]")).not.toBeNull();
    await shot("comments-unread-pin-dark");
    await page.getByRole("button", { name: "Unread comment from Hongyan" }).click();
    await expect.element(page.getByRole("group", { name: "Comment thread" })).toBeVisible();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-page-comments-unread]")).toBeNull(),
    );
  } finally {
    await screen.unmount();
  }
});
