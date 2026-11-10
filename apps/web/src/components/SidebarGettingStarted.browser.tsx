import "../index.css";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "../localization";
import { SidebarGettingStarted } from "./SidebarGettingStarted";
import { SplashScreen } from "./SplashScreen";

it.each(["zh-CN", "en"] as const)(
  "opens each localized getting-started guide and runs only its selected action (%s)",
  async (locale) => {
    const disclosureLabel = locale === "zh-CN" ? "入门" : "Getting started";
    const callbacks = {
      onOpenAutomations: vi.fn(),
      onOpenConnectors: vi.fn(),
      onCreateChat: vi.fn(),
    };
    const screen = await render(
      <MossLocaleScope locale={locale}>
        <SidebarGettingStarted {...callbacks} />
      </MossLocaleScope>,
    );
    try {
      await page.getByRole("button", { name: disclosureLabel, exact: true }).click();
      const tasks =
        locale === "zh-CN"
          ? ([
              ["设置每日更新", "打开自动任务", callbacks.onOpenAutomations],
              ["帮我跟上 Linear", "打开连接器", callbacks.onOpenConnectors],
              ["查看最新计划", "打开新对话", callbacks.onCreateChat],
            ] as const)
          : ([
              ["Set up a daily update", "Open automations", callbacks.onOpenAutomations],
              ["Catch me up on Linear", "Open connectors", callbacks.onOpenConnectors],
              ["Review the latest plans", "Open new chat", callbacks.onCreateChat],
            ] as const);
      for (const [label, action, callback] of tasks) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await expect
          .element(page.getByRole("dialog").getByRole("heading", { name: label }))
          .toBeVisible();
        expect(callback).not.toHaveBeenCalled();
        const description =
          page.getByRole("dialog").element().querySelector('[data-slot="dialog-description"]')
            ?.textContent ?? "";
        expect(
          locale === "zh-CN"
            ? /[\u4e00-\u9fff]/.test(description)
            : !/[\u4e00-\u9fff]/.test(description),
        ).toBe(true);
        await page.getByRole("button", { name: action, exact: true }).click();
        expect(callback).toHaveBeenCalledOnce();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: disclosureLabel, exact: true }))
          .toHaveAttribute("aria-expanded", "true");
      }
    } finally {
      await screen.unmount();
    }
  },
);

it("cancels a guide without navigating or starting agent work", async () => {
  const callbacks = {
    onOpenAutomations: vi.fn(),
    onOpenConnectors: vi.fn(),
    onCreateChat: vi.fn(),
  };
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <SidebarGettingStarted {...callbacks} />
    </MossLocaleScope>,
  );
  try {
    await page.getByRole("button", { name: "入门", exact: true }).click();
    await page.getByRole("button", { name: "设置每日更新", exact: true }).click();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("keeps the React loading logo at the same 72px viewport center as HTML and native", async () => {
  const screen = await render(<SplashScreen />);
  try {
    const bounds = page.getByRole("img", { name: "Moss" }).element().getBoundingClientRect();
    expect(bounds.width).toBe(72);
    expect(bounds.height).toBe(72);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(innerWidth / 2, 0);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(innerHeight / 2, 0);
  } finally {
    await screen.unmount();
  }
});

it("keeps sidebar navigation clickable while a route is loading", async () => {
  const navigate = vi.fn();
  const screen = await render(
    <div className="flex">
      <button onClick={navigate}>Sidebar destination</button>
      <div className="min-w-0 flex-1">
        <SplashScreen />
      </div>
    </div>,
  );
  try {
    await page.getByRole("button", { name: "Sidebar destination", exact: true }).click();
    expect(navigate).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
