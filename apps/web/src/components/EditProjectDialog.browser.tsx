import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY, type MossLocaleCode } from "~/uiLocale";

import { EditProjectDialog, type EditProjectValue } from "./EditProjectDialog";

function renderDialog(
  onSave: (value: EditProjectValue) => void,
  options: { onRemove?: () => void; locale?: MossLocaleCode } = {},
) {
  const { onRemove, locale = "en" } = options;
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  return render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <EditProjectDialog
          open
          cwd="/tmp/ws-alpha"
          folderName="ws-alpha"
          initialValue={{ name: "", appearance: null }}
          onOpenChange={() => {}}
          onSave={onSave}
          {...(onRemove ? { onRemove } : {})}
        />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

describe("EditProjectDialog", () => {
  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("saves the typed name with the icon and color chosen in the picker", async () => {
    const onSave = vi.fn();
    const screen = await renderDialog(onSave);
    try {
      await page.getByRole("textbox", { name: "Project name" }).fill("Alpha");
      await page.getByRole("button", { name: "Choose icon" }).click();
      await page.getByRole("radio", { name: "Blue" }).click();
      await page.getByRole("radio", { name: "Launch" }).click();
      await page.getByRole("button", { name: "Save" }).click();

      expect(onSave).toHaveBeenCalledWith({
        name: "Alpha",
        appearance: { kind: "icon", icon: "rocket", color: "blue" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the source folder as a read-only chip and routes the red button to onRemove", async () => {
    const onSave = vi.fn();
    const onRemove = vi.fn();
    const screen = await renderDialog(onSave, { onRemove });
    try {
      // Single-root project: the folder chip is display-only, and the dialog's
      // only destructive action is the red "Remove local project".
      await expect.element(page.getByText("ws-alpha", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Remove local project" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Remove local project" }).click();
      expect(onRemove).toHaveBeenCalledOnce();
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("localizes the destructive action in zh-CN", async () => {
    const onRemove = vi.fn();
    const screen = await renderDialog(() => {}, { onRemove, locale: "zh-CN" });
    try {
      await expect.element(page.getByRole("heading", { name: "编辑项目" })).toBeVisible();
      await expect.element(page.getByText("源文件夹", { exact: true })).toBeVisible();
      const removeButton = page.getByRole("button", { name: "移除本地项目" });
      await expect.element(removeButton).toBeVisible();
      await expect.element(page.getByRole("button", { name: "取消" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "保存" })).toBeVisible();

      await removeButton.click();
      expect(onRemove).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("hides the remove button when no onRemove handler is provided", async () => {
    const screen = await renderDialog(() => {});
    try {
      expect(page.getByRole("button", { name: "Remove local project" }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps focus in the picker when its empty space is clicked", async () => {
    const screen = await renderDialog(() => {});
    try {
      await page.getByRole("button", { name: "Choose icon" }).click();
      const search = page.getByRole("searchbox", { name: "Search icons" });
      await expect.element(search).toHaveFocus();

      // The right end of the tab row is picker background, not a control.
      const tabs = page.getByRole("tablist", { name: "Project icon type" });
      const { width, height } = tabs.element().getBoundingClientRect();
      await tabs.click({ position: { x: width - 8, y: height / 2 } });

      await expect.element(page.getByRole("textbox", { name: "Project name" })).not.toHaveFocus();
      await expect.element(search).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
