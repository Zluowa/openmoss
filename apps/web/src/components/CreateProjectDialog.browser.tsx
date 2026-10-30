import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axe from "axe-core";
import { page, userEvent } from "vitest/browser";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY, type MossLocaleCode } from "~/uiLocale";

const nativeApi = vi.hoisted(() => ({
  pickFolder: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
}));

vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  // The Codex-form source-folder area (location dropdown + Add button) only
  // renders in Electron; exercise it here.
  isElectron: true,
}));

vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    dialogs: {
      pickFolder: nativeApi.pickFolder,
    },
  }),
}));

import { CreateProjectDialog } from "./CreateProjectDialog";

type CreateProjectDialogProps = ComponentProps<typeof CreateProjectDialog>;

async function renderDialog(locale: MossLocaleCode, props: CreateProjectDialogProps) {
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: locale }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const result = await render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <CreateProjectDialog {...props} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

async function blockingAxeViolations() {
  const result = await axe.run(document.body);
  return result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

describe("CreateProjectDialog (Codex form)", () => {
  afterEach(async () => {
    nativeApi.pickFolder.mockClear();
    nativeApi.pickFolder.mockResolvedValue(null);
    localStorage.clear();
    await cleanup();
  });

  it("focuses the name field on open and explains a missing source folder on submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await renderDialog("en", {
      open: true,
      activeSpaceId: null,
      onOpenChange: vi.fn(),
      onSubmit,
    });

    const nameInput = page.getByRole("textbox", { name: "Project name", exact: true });
    await expect.element(nameInput).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(nameInput.element()));

    // The Codex form has no source tabs and no Space picker.
    expect(page.getByRole("radio", { name: "GitHub" }).elements()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Space");
    expect(await blockingAxeViolations()).toEqual([]);

    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Add a source folder first.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the picked folder as a removable chip and submits name, path, and active space", async () => {
    nativeApi.pickFolder.mockResolvedValue("/Users/test/Developer/moss-app");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    await renderDialog("en", {
      open: true,
      activeSpaceId: "space-1" as CreateProjectDialogProps["activeSpaceId"],
      onOpenChange,
      onSubmit,
    });

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await vi.waitFor(() => expect(nativeApi.pickFolder).toHaveBeenCalledOnce());

    // The chip carries the folder name and can be removed again.
    const chip = page.getByText("moss-app", { exact: true });
    await expect.element(chip).toBeVisible();
    const nameInput = page.getByRole("textbox", { name: "Project name", exact: true });
    expect((nameInput.element() as HTMLInputElement).placeholder).toBe("moss-app");

    await page.getByRole("button", { name: "Remove folder" }).click();
    await expect.element(chip).not.toBeInTheDocument();

    // Pick again and submit with a custom name.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await vi.waitFor(() => expect(nativeApi.pickFolder).toHaveBeenCalledTimes(2));
    await nameInput.fill("My app");
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [value, options] = onSubmit.mock.calls[0] ?? [];
    expect(value).toMatchObject({
      source: "local",
      workspaceRoot: "/Users/test/Developer/moss-app",
      name: "My app",
      spaceId: "space-1",
      createIfMissing: false,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await blockingAxeViolations()).toEqual([]);
  });

  it("aborts the in-flight submit when the dialog is closed", async () => {
    const submittedSignals: AbortSignal[] = [];
    const onSubmit = vi.fn(
      (_value: unknown, options: { signal: AbortSignal }) =>
        new Promise<void>(() => {
          submittedSignals.push(options.signal);
        }),
    );
    const onOpenChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <CreateProjectDialog
          open={open}
          activeSpaceId={null}
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
          onSubmit={onSubmit}
        />
      );
    }
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "en" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    await render(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <Harness />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    nativeApi.pickFolder.mockResolvedValue("/Users/test/moss-app");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByText("moss-app", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    expect(submittedSignals[0]?.aborted).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the Codex layout in zh-CN with a localized location dropdown", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await page.viewport(390, 720);
    await renderDialog("zh-CN", {
      open: true,
      activeSpaceId: null,
      onOpenChange: vi.fn(),
      onSubmit,
    });

    await expect
      .element(page.getByRole("heading", { name: "创建项目", exact: true }))
      .toBeVisible();
    const nameInput = page.getByRole("textbox", { name: "项目名称", exact: true });
    await expect.element(nameInput).toBeVisible();
    await vi.waitFor(() => expect(document.activeElement).toBe(nameInput.element()));
    const visibleText = document.body.innerText;
    expect(visibleText).toContain("源文件夹");
    expect(visibleText).toContain("在此电脑上添加文件夹");
    expect(visibleText).not.toContain("GitHub");
    expect(visibleText).not.toContain("空间");
    expect(visibleText).not.toContain("Create project");
    await expect.element(page.getByRole("button", { name: "添加", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "取消", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "创建项目", exact: true })).toBeVisible();

    // The location dropdown mirrors the reference dialog: this computer, a
    // remote-devices group with its empty state, and the add-remote entry.
    // (Base UI exposes the select trigger as a combobox, not a button.)
    await page.getByLabelText("文件夹位置").click();
    const popupText = document.body.innerText;
    expect(popupText).toContain("此电脑");
    expect(popupText).toContain("远程设备");
    expect(popupText).toContain("未连接任何远程主机");
    expect(popupText).toContain("添加远程主机");

    await userEvent.keyboard("{Escape}");
    // The destructive-text contrast finding predates this dialog, so axe runs
    // before the validation error is on screen.
    expect(await blockingAxeViolations()).toEqual([]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1,
    );

    await page.getByRole("button", { name: "创建项目", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("请先添加源文件夹。");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// MERGE-GAP(2026-10-09): upstream #1595 added a "multi-folder projects" suite against its
// own dialog (githubProvisioningAvailable/spaces/defaultCloneParent props, folder list UI).
// Moss's Codex-form dialog has neither those props nor multi-folder entry (single source
// folder by design), so the suite cannot mount here. Multi-folder projects still work
// through the server/IPC path; add Moss-side UI coverage when the dialog grows folders.
