// Walk 2026-11-24 (N6-2): 复制消息 under a reply raised an English 「Copied!」 bubble that covered
// the start of 「index.js」 in the edited-files card. The confirmation is now the button's own:
// a check mark and its shared tooltip reading 「已复制」, floating over nothing new.

import "../../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "../../localization";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../../localization/zhCN";
import { AnchoredToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { MessageCopyButton } from "./MessageCopyButton";

const written: string[] = [];

afterEach(() => {
  uninstallZhCnUiLocalization();
  document.documentElement.lang = "en";
  delete document.documentElement.dataset.mossLocale;
  written.length = 0;
});

it("confirms 复制消息 with 「已复制」 on its own tooltip and no bubble over the transcript (walk N6-2)", async () => {
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (value: string) => {
    written.push(value);
  });
  await page.viewport(800, 400);
  // AnchoredToastProvider reads the route, so it needs a router around it.
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <TooltipProvider>
          <AnchoredToastProvider>
            <div style={{ padding: "120px 40px" }}>
              <p data-testid="edited-file">index.js</p>
              <MessageCopyButton text="给 index.js 加了减法和乘法。" />
            </div>
          </AnchoredToastProvider>
        </TooltipProvider>
      ),
    }),
  });
  const screen = await render(<RouterProvider router={router} />);
  try {
    const button = page.getByRole("button").element() as HTMLButtonElement;
    await userEvent.hover(button);
    await userEvent.click(button);
    await expect.poll(() => written).toEqual(["给 index.js 加了减法和乘法。"]);

    // The button's own tooltip says it, in Chinese.
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-popup"]')?.textContent?.trim())
      .toBe("已复制");
    // No toast-style bubble anywhere, in any language.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(document.body.textContent).not.toContain("Copied!");
    expect(document.querySelectorAll('[data-slot="toast-title"]')).toHaveLength(0);
  } finally {
    vi.restoreAllMocks();
    await screen.unmount();
  }
});

it("says in one Chinese sentence what to do when the copy fails, without the raw error", async () => {
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("NotAllowedError: denied"),
  );
  vi.spyOn(document, "execCommand").mockReturnValue(false);
  await page.viewport(800, 400);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <TooltipProvider>
          <AnchoredToastProvider>
            <MossLocaleScope locale="zh-CN">
              <MessageCopyButton text="x" />
            </MossLocaleScope>
          </AnchoredToastProvider>
        </TooltipProvider>
      ),
    }),
  });
  const screen = await render(<RouterProvider router={router} />);
  try {
    await userEvent.click(page.getByRole("button").element() as HTMLButtonElement);
    await expect
      .poll(() => document.querySelector('[data-slot="toast-title"]')?.textContent?.trim())
      .toBe("复制失败，请选中文字后手动复制。");
    expect(document.body.textContent).not.toContain("NotAllowedError");
    expect(document.body.textContent).not.toContain("Failed to copy");
  } finally {
    vi.restoreAllMocks();
    await screen.unmount();
  }
});
