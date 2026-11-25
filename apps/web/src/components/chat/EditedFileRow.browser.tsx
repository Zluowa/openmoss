// FILE: EditedFileRow.browser.tsx
// Purpose: Verify changed-file review/open actions remain independent, accessible, and path-safe.
// Layer: Browser UI test

import "../../index.css";

import type { EditorId, NativeApi } from "@moss/contracts";
import type { PropsWithChildren } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  toastAdd: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { resolveEditorLabel } from "~/editorMetadata";
import { MossLocaleScope } from "~/localization";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "~/localization/zhCN";
import { WorkspaceFileOpenerContext } from "~/lib/workspaceFileOpener";
import { EditedFileRow } from "./EditedFileRow";

const AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [
  "file-manager",
  "vscode",
  "cursor",
  "webstorm",
  "terminal",
  "iterm",
];
const FILE_PATH = "apps/web/src/components/chat/EditedFileRow.tsx";
const ROOTLESS_FILE_PATH = "a/very/long/path/that/does/not/exist/EditedFileRow.tsx";
const WORKSPACE_ROOT = "/workspace/moss";
const FILE_MANAGER_LABEL = resolveEditorLabel("file-manager", navigator.platform);

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let restoreNativeApi: (() => void) | undefined;

function mockOpenInEditor() {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  const openInEditor = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { shell: { openInEditor } } as unknown as NativeApi,
  });
  restoreNativeApi = () => {
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
  return openInEditor;
}

function setClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function TestProviders(props: PropsWithChildren<{ openFile: (path: string) => boolean }>) {
  return (
    <WorkspaceFileOpenerContext.Provider value={{ openFile: props.openFile }}>
      {props.children}
    </WorkspaceFileOpenerContext.Provider>
  );
}

function editedFileRow(props: {
  openFile: (path: string) => boolean;
  onReview?: () => void;
  filePath?: string;
  fileKind?: string;
  workspaceRoot?: string;
}) {
  return (
    <TestProviders openFile={props.openFile}>
      <EditedFileRow
        filePath={props.filePath ?? FILE_PATH}
        fileKind={props.fileKind ?? "modified"}
        additions={12}
        deletions={3}
        workspaceRoot={props.workspaceRoot}
        keybindings={[]}
        availableEditors={AVAILABLE_EDITORS}
        resolvedTheme="light"
        fontSize={13}
        withFirstReset
        onReview={props.onReview ?? vi.fn()}
      />
    </TestProviders>
  );
}

async function openFileOptions(filePath = FILE_PATH) {
  const menuButton = page.getByRole("button", { name: `Open ${filePath} options` });
  await menuButton.click();
  return menuButton;
}

function fileManagerMenuItem() {
  return page.getByRole("menuitemradio", { name: FILE_MANAGER_LABEL });
}

beforeEach(() => {
  localStorage.clear();
  harness.toastAdd.mockReset();
});

afterEach(() => {
  restoreNativeApi?.();
  restoreNativeApi = undefined;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  vi.restoreAllMocks();
});

describe("EditedFileRow", () => {
  it("keeps row review, Open, and menu trigger as keyboard-reachable sibling buttons", async () => {
    const onReview = vi.fn();
    const openFile = vi.fn(() => true);
    const openInEditor = mockOpenInEditor();

    const screen = await render(
      editedFileRow({ openFile, onReview, workspaceRoot: WORKSPACE_ROOT }),
    );
    const pathButton = page.getByRole("button", { name: `Review changes to ${FILE_PATH}` });
    const openButton = page.getByRole("button", { name: "Open in Cursor", exact: true });
    const menuButton = page.getByRole("button", {
      name: `Open ${FILE_PATH} options`,
      exact: true,
    });

    expect(screen.container.querySelector("button button")).toBeNull();
    await pathButton.click();
    expect(onReview).toHaveBeenCalledTimes(1);

    await openButton.click();
    // The primary action opens the preferred editor, never the in-app viewer.
    // With no stored preference the first catalog editor available wins (Cursor).
    expect(openInEditor).toHaveBeenCalledExactlyOnceWith(
      "/workspace/moss/apps/web/src/components/chat/EditedFileRow.tsx",
      "cursor",
    );
    expect(openFile).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledTimes(1);

    pathButton.element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(openButton.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(menuButton.element());
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText(FILE_MANAGER_LABEL, { exact: true })).toBeInTheDocument();
  });

  it("lists installed launchers in file-action order, then copies both path forms", async () => {
    const openInEditor = mockOpenInEditor();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await render(editedFileRow({ openFile: () => true, workspaceRoot: WORKSPACE_ROOT }));

    const menuButton = await openFileOptions();
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[role='menuitemradio']"), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual([FILE_MANAGER_LABEL, "VS Code", "Cursor", "WebStorm", "Terminal", "iTerm"]);
    const menuTexts = Array.from(
      document.querySelectorAll<HTMLElement>("[role='menu'] [role^='menuitem']"),
      (item) => item.textContent?.trim(),
    );
    expect(menuTexts.slice(-2)).toEqual(["Copy absolute path", "Copy relative path"]);

    await page.getByRole("menuitem", { name: "Copy absolute path" }).click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "/workspace/moss/apps/web/src/components/chat/EditedFileRow.tsx",
      );
    });
    await menuButton.click();
    await page.getByRole("menuitem", { name: "Copy relative path" }).click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(FILE_PATH);
    });
    expect(harness.toastAdd).toHaveBeenLastCalledWith({
      type: "success",
      title: "Path copied",
      description: FILE_PATH,
    });

    await menuButton.click();
    await page.getByText("VS Code", { exact: true }).click();
    expect(openInEditor).toHaveBeenCalledWith(
      "/workspace/moss/apps/web/src/components/chat/EditedFileRow.tsx",
      "vscode",
    );
  });

  it("keeps copy actions usable while disabling opens for deleted files", async () => {
    const openFile = vi.fn(() => true);
    const openInEditor = mockOpenInEditor();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await render(
      editedFileRow({
        openFile,
        fileKind: "deleted",
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );

    expect(
      page.getByRole("button", { name: "Open in Cursor", exact: true }).element(),
    ).toBeDisabled();
    await openFileOptions();
    expect(fileManagerMenuItem().element()).toBeDisabled();
    await page.getByText("Copy relative path", { exact: true }).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(FILE_PATH));
    expect(openFile).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("disables relative Open actions without a workspace root and stays contained when narrow", async () => {
    const openFile = vi.fn(() => false);
    mockOpenInEditor();
    const host = document.createElement("div");
    host.style.cssText = "width:250px;overflow:hidden;";
    document.body.append(host);

    const screen = await render(
      editedFileRow({
        openFile,
        filePath: ROOTLESS_FILE_PATH,
      }),
      { container: host },
    );
    try {
      expect(
        page.getByRole("button", { name: "Open in Cursor", exact: true }).element(),
      ).toBeDisabled();
      expect(openFile).not.toHaveBeenCalled();

      const row = screen.container.querySelector<HTMLElement>("[data-edited-file-row='true']");
      expect(row).not.toBeNull();
      expect(row!.scrollWidth).toBeLessThanOrEqual(row!.clientWidth);
      expect(
        page.getByRole("button", { name: `Review changes to ${ROOTLESS_FILE_PATH}` }).element(),
      ).toBeVisible();

      await openFileOptions(ROOTLESS_FILE_PATH);
      expect(fileManagerMenuItem().element()).toBeDisabled();
      expect(page.getByRole("menuitem", { name: "Copy absolute path" }).element()).toBeDisabled();
      expect(
        page.getByRole("menuitem", { name: "Copy relative path" }).element(),
      ).not.toBeDisabled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("uses Moss Central icons and clean basename display for external Windows script paths", async () => {
    mockOpenInEditor();
    const externalScriptPath = "C:\\DevTemp\\moss-runs\\ui-showcase\\sample-colors.ps1";
    const screen = await render(
      editedFileRow({
        openFile: () => true,
        filePath: externalScriptPath,
      }),
    );

    try {
      const row = screen.container.querySelector<HTMLElement>("[data-edited-file-row='true']")!;
      const nameEl = row.querySelector<HTMLElement>("[data-edited-file-name]")!;
      const dirEl = row.querySelector<HTMLElement>("[data-edited-file-dir]")!;

      // Clean basename + immediate parent folder; no raw drive or full OS path clutter.
      expect(nameEl.textContent).toBe("sample-colors.ps1");
      expect(dirEl.textContent).toBe("ui-showcase");
      expect(row.textContent).not.toContain("C:\\DevTemp");
      expect(
        page.getByRole("button", { name: `Review changes to ${externalScriptPath}` }).element(),
      ).toHaveAttribute("title", externalScriptPath);

      // Script icon uses Central console (>_), never Mac cmd (⌘).
      const icons = [...row.querySelectorAll<HTMLElement>('[data-slot="central-icon"]')].map(
        (icon) => icon.getAttribute("style") ?? "",
      );
      expect(icons.some((style) => style.includes("/console.svg"))).toBe(true);
      expect(icons.some((style) => style.includes("/cmd.svg"))).toBe(false);

      // Trailing actions use Moss Central icons (external link + more), no third-party app logo
      // and no duplicate disclosure chevron.
      expect(icons.some((style) => style.includes("/square-arrow-top-right.svg"))).toBe(true);
      expect(icons.some((style) => style.includes("/dot-grid-1x3-horizontal.svg"))).toBe(true);
      expect(icons.some((style) => style.includes("/chevron-down-medium.svg"))).toBe(false);
      expect(row.querySelectorAll("svg, img")).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("names the changed file's open actions in Chinese to a screen reader (walk N12-5)", async () => {
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        {editedFileRow({
          openFile: vi.fn(() => true),
          filePath: "index.js",
          workspaceRoot: WORKSPACE_ROOT,
        })}
      </MossLocaleScope>,
    );
    try {
      await expect
        .element(page.getByRole("group", { name: "打开 index.js", exact: true }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "打开 index.js 的选项", exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
      uninstallZhCnUiLocalization();
      document.documentElement.lang = "en";
      delete document.documentElement.dataset.mossLocale;
    }
  });

  it("names the ↗ button 「在 Cursor 中打开」 in Chinese, on the shared tooltip (walk N13-4)", async () => {
    // WALK-13 N13-4: the ↗ beside an edited file had an English native tooltip,
    // title="Open in Cursor", and no Chinese name for a screen reader.
    document.documentElement.lang = "zh-CN";
    document.documentElement.dataset.mossLocale = "zh-CN";
    installZhCnUiLocalization();
    mockOpenInEditor();
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        {editedFileRow({
          openFile: vi.fn(() => true),
          filePath: "index.js",
          workspaceRoot: WORKSPACE_ROOT,
        })}
      </MossLocaleScope>,
    );
    try {
      const open = page.getByRole("button", { name: "在 Cursor 中打开", exact: true });
      await expect.element(open).toBeVisible();
      expect(open.element().hasAttribute("title")).toBe(false);
      await userEvent.hover(open.element());
      await expect
        .poll(() =>
          [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-popup"]')].map((popup) =>
            popup.textContent?.trim(),
          ),
        )
        .toEqual(["在 Cursor 中打开"]);
      const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
      expect(tooltip.getBoundingClientRect().width).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
      uninstallZhCnUiLocalization();
      document.documentElement.lang = "en";
      delete document.documentElement.dataset.mossLocale;
    }
  });
});
