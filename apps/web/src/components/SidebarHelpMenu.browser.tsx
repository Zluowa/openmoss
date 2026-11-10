import "../index.css";
import { page } from "vitest/browser";
import * as React from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "../localization";
import { AppRailMoreMenu } from "./AppRailMoreMenu";
import { SidebarHelpMenu } from "./Sidebar";

it.each(["zh-CN", "en"] as const)("renders the localized rail More menu (%s)", async (locale) => {
  const screen = await render(
    <MossLocaleScope locale={locale}>
      <AppRailMoreMenu
        open={false}
        onOpenChange={vi.fn()}
        onCustomize={vi.fn()}
        destinations={[]}
        plugins={[]}
        utilities={[]}
      />
    </MossLocaleScope>,
  );
  try {
    await expect.element(page.getByRole("button", { name: /More|更多/ })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

function RailMoreWithHelp(props: {
  readonly onOpenShortcuts: () => void;
  readonly onOpenFeedback: () => void;
}) {
  return (
    <SidebarHelpMenu
      onOpenShortcuts={props.onOpenShortcuts}
      onOpenFeedback={props.onOpenFeedback}
      onCustomizeSidebar={null}
      renderMenu={(helpMenu) => <ControlledMore helpMenu={helpMenu} />}
    />
  );
}

function ControlledMore({ helpMenu }: { readonly helpMenu: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <AppRailMoreMenu
      open={open}
      onOpenChange={setOpen}
      onCustomize={vi.fn()}
      destinations={[]}
      plugins={[]}
      utilities={[]}
      helpMenu={helpMenu}
    />
  );
}

it.each(["zh-CN", "en"] as const)(
  "opens localized Help from the rail More menu without navigating first (%s)",
  async (locale) => {
    const labels =
      locale === "zh-CN"
        ? { help: "帮助", shortcuts: "按键绑定", docs: "文档", changelog: "完整发行说明" }
        : { help: "Help", shortcuts: "Keybindings", docs: "Docs", changelog: "Full changelog" };
    const onOpenShortcuts = vi.fn();
    const onOpenFeedback = vi.fn();
    const screen = await render(
      <MossLocaleScope locale={locale}>
        <RailMoreWithHelp onOpenShortcuts={onOpenShortcuts} onOpenFeedback={onOpenFeedback} />
      </MossLocaleScope>,
    );
    try {
      const more = page.getByRole("button", { name: /More|更多/ });
      await more.click();
      await page.getByRole("menuitem", { name: labels.help, exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: labels.shortcuts, exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: labels.docs, exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("menuitem", { name: labels.changelog, exact: true }))
        .toBeVisible();
      expect(onOpenShortcuts).not.toHaveBeenCalled();
      expect(onOpenFeedback).not.toHaveBeenCalled();
      await page.getByRole("menuitem", { name: labels.shortcuts, exact: true }).click();
      expect(onOpenShortcuts).toHaveBeenCalledOnce();

      await more.click();
      await page.getByRole("menuitem", { name: labels.help, exact: true }).click();
      await page.getByRole("menuitem", { name: labels.changelog, exact: true }).click();
      await expect
        .element(
          page.getByRole("dialog").getByRole("heading", {
            name: locale === "zh-CN" ? "发布历史" : "Release history",
            exact: true,
          }),
        )
        .toBeVisible();
      if (locale === "zh-CN")
        expect(
          page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).elements(),
        ).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  },
);
