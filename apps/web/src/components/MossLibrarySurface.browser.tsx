// FILE: MossLibrarySurface.browser.tsx
// Purpose: Browser-level parity tests for Codex Library interactions —
// multi-select bar, card context menu, folder drill-down, grouped 全部 tab,
// 新建 folder creation, inline rename, and single-phase first-load (no
// intermediate frames between skeleton and content).

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MOSS_LIBRARY_ITEMS_STORAGE_KEY, useMossLibraryItemsStore } from "~/mossLibraryItemsStore";

import { MossLibrarySurface } from "./MossLibrarySurface";
import {
  assignMossLibraryItemsToFolder,
  createMossLibraryFolder,
  ingestMossLibraryItemFromCliFile,
  type MossLibraryItem,
} from "./MossLibrarySurface.logic";

const NOW = 1_800_000_000_000;

function doc(id: string, title: string, updatedAt: number): MossLibraryItem {
  return ingestMossLibraryItemFromCliFile({
    id,
    title,
    sourceCli: "codex",
    path: `library/cli-outputs/codex/${title}`,
    mimeType: "text/markdown",
    updatedAt,
  });
}

function fixture(): { items: MossLibraryItem[]; folder: MossLibraryItem } {
  const folder = createMossLibraryFolder("Pets", NOW - 60_000);
  const alpha = doc("doc-alpha", "alpha.md", NOW - 30_000);
  const beta = doc("doc-beta", "beta.md", NOW - 20_000);
  const filed = doc("doc-filed", "filed-inside.md", NOW - 10_000);
  const items = assignMossLibraryItemsToFolder([folder, alpha, beta, filed], [filed.id], folder.id);
  return { items, folder };
}

function rightClick(element: Element) {
  element.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 160, clientY: 180 }),
  );
}

describe("MossLibrarySurface Codex interactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("multi-selects cards and drives the bottom selection bar", async () => {
    const { items } = fixture();
    const startConversation = vi.fn(async (_items: readonly MossLibraryItem[]) => undefined);
    await render(
      <MossLibrarySurface
        onClose={() => undefined}
        initialItems={items}
        now={NOW}
        onStartConversation={startConversation}
      />,
    );

    await expect.element(page.getByText("alpha.md")).toBeInTheDocument();
    expect(document.querySelector("[data-moss-library-selection-bar]")).toBeNull();

    // Click toggles selection; the Codex bottom bar summarizes the count.
    await page.getByText("alpha.md").click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-selection-count-label]")?.textContent).toBe(
        "已选择 1 个",
      );
    });
    expect(
      document
        .querySelector('[data-moss-library-item="doc-alpha"]')
        ?.getAttribute("data-moss-library-item-selected"),
    ).toBe("true");

    await page.getByText("beta.md").click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-selection-count-label]")?.textContent).toBe(
        "已选择 2 个",
      );
    });

    // The route owns the actual normal conversation and receives both selected files.
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-selection-action="chat"]')
      ?.click();
    await vi.waitFor(() => {
      expect(startConversation).toHaveBeenCalledTimes(1);
      expect(startConversation.mock.calls[0]?.[0].map((item) => item.id)).toEqual([
        "doc-alpha",
        "doc-beta",
      ]);
    });

    // Dismiss (×) clears the selection and hides the bar.
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-selection-action="dismiss"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-selection-bar]")).toBeNull();
    });
  });

  it("deletes selected cards from the selection bar", async () => {
    const { items } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    await page.getByText("alpha.md").click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-selection-bar]")).not.toBeNull();
    });
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-selection-action="delete"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-item="doc-alpha"]')).toBeNull();
      expect(document.querySelector("[data-moss-library-toast]")?.textContent).toContain(
        "已删除 1 项",
      );
    });
    expect(document.querySelector('[data-moss-library-item="doc-beta"]')).not.toBeNull();
  });

  it("opens the Codex context menu on right-click and toggles 收藏", async () => {
    const { items } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    const card = document.querySelector('[data-moss-library-item="doc-alpha"]');
    expect(card).not.toBeNull();
    rightClick(card!);

    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-context-menu]")).not.toBeNull();
    });
    const labels = [...document.querySelectorAll("[data-moss-library-context-action]")].map(
      (entry) => entry.textContent?.trim(),
    );
    expect(labels).toEqual([
      "围绕此内容展开对话",
      "添加到收藏夹",
      "下载",
      "分享",
      "重命名",
      "添加到文件夹",
      "删除",
    ]);

    document
      .querySelector<HTMLButtonElement>('[data-moss-library-context-action="favorite"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-toast]")?.textContent).toContain(
        "已收藏 1 项",
      );
    });

    // Favorite label flips once the item is starred.
    rightClick(document.querySelector('[data-moss-library-item="doc-alpha"]')!);
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-moss-library-context-action="favorite"]')?.textContent,
      ).toContain("从收藏夹移除");
    });
  });

  it("renames a card inline from the context menu", async () => {
    const { items } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    rightClick(document.querySelector('[data-moss-library-item="doc-alpha"]')!);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-context-menu]")).not.toBeNull();
    });
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-context-action="rename"]')
      ?.click();

    const input = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>("[data-moss-library-rename-input]");
      expect(found).not.toBeNull();
      return found!;
    });
    input.value = "renamed-alpha.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-rename-input]")).toBeNull();
    });
    await expect.element(page.getByText("renamed-alpha.md")).toBeInTheDocument();
  });

  it("groups the 全部 tab into 文件夹 and 项目, and drills into folders", async () => {
    const { items, folder } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    document.querySelector<HTMLButtonElement>('[data-moss-library-section="all"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-group="folders"]')).not.toBeNull();
      expect(document.querySelector('[data-moss-library-group="projects"]')).not.toBeNull();
    });
    // Items filed inside a folder stay out of the top-level 项目 grid.
    const projects = document.querySelector('[data-moss-library-group="projects"]')!;
    expect(projects.querySelector('[data-moss-library-item="doc-filed"]')).toBeNull();
    expect(projects.querySelector('[data-moss-library-item="doc-alpha"]')).not.toBeNull();

    // Clicking a folder card drills into the folder view.
    await page.getByText(folder.title).click();
    await vi.waitFor(() => {
      expect(
        document.querySelector(`[data-moss-library-folder-view="${folder.id}"]`),
      ).not.toBeNull();
    });
    expect(
      document.querySelector(
        '[data-moss-library-folder-view] [data-moss-library-item="doc-filed"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-moss-library-folder-view] [data-moss-library-item="doc-alpha"]',
      ),
    ).toBeNull();

    // Back returns to the grouped 全部 tab.
    document.querySelector<HTMLButtonElement>("[data-moss-library-folder-back]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-folder-view]")).toBeNull();
      expect(document.querySelector('[data-moss-library-group="projects"]')).not.toBeNull();
    });
  });

  it("creates a folder from the 新建 menu and files cards into it", async () => {
    const { items } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    document.querySelector<HTMLButtonElement>("[data-moss-library-new]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-new-menu]")).not.toBeNull();
    });
    const newActions = [...document.querySelectorAll("[data-moss-library-new-action]")].map(
      (entry) => entry.getAttribute("data-moss-library-new-action"),
    );
    expect(newActions).toEqual(["folder", "import", "from-chatgpt", "from-canvas"]);

    document.querySelector<HTMLButtonElement>('[data-moss-library-new-action="folder"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-toast]")?.textContent).toContain(
        "已创建文件夹",
      );
    });

    // The new folder can receive cards via the context menu folder picker.
    document.querySelector<HTMLButtonElement>('[data-moss-library-section="all"]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-group="projects"]')).not.toBeNull();
    });
    rightClick(document.querySelector('[data-moss-library-item="doc-alpha"]')!);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-context-menu]")).not.toBeNull();
    });
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-context-action="add-to-folder"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-folder-picker]")).not.toBeNull();
    });
    const folderOptions = document.querySelectorAll("[data-moss-library-folder-option]");
    expect(folderOptions.length).toBe(2);
    (folderOptions[0] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-toast]")?.textContent).toContain(
        "已添加到文件夹",
      );
    });
  });

  it("ends first-open loading with a readable connection error instead of permanent placeholders", async () => {
    // Store-backed load (no initialItems) — the real first-open path.
    window.localStorage.removeItem(MOSS_LIBRARY_ITEMS_STORAGE_KEY);
    useMossLibraryItemsStore.getState().resetAccountBoundary();

    await render(<MossLibrarySurface onClose={() => undefined} />);

    const host = document.querySelector("[data-moss-library-host]");
    expect(host).not.toBeNull();

    // First frame: header + skeleton only — no content, no empty state, no list remnants.
    expect(host!.getAttribute("data-moss-library-loading")).toBe("true");
    expect(document.querySelector("[data-moss-library-skeleton]")).not.toBeNull();
    expect(document.querySelector("[data-moss-library-item]")).toBeNull();
    expect(document.querySelector("[data-moss-library-placeholder]")).toBeNull();
    expect(document.querySelector("[data-moss-library-empty-footnote]")).toBeNull();
    expect(document.querySelector("[data-moss-library-list]")).toBeNull();

    // The host chrome must not change when the skeleton swaps out (single background).
    const hostClassDuringSkeleton = host!.className;
    expect(hostClassDuringSkeleton).not.toContain("#e8ebed");

    await vi.waitFor(
      () => {
        expect(host!.getAttribute("data-moss-library-loading")).toBe("false");
      },
      { timeout: 3000 },
    );

    expect(document.querySelector("[data-moss-library-skeleton]")).toBeNull();
    expect(host!.className).toBe(hostClassDuringSkeleton);

    expect(document.querySelector("[data-moss-library-placeholder]")).toBeNull();
    await expect.element(page.getByRole("button", { name: "刷新资料库" })).toBeVisible();
    await expect.element(page.getByRole("alert")).toHaveTextContent("资料库连接尚未就绪");
  });

  it("refuses a rename that changes the extension", async () => {
    const { items } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    rightClick(document.querySelector('[data-moss-library-item="doc-alpha"]')!);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-context-menu]")).not.toBeNull();
    });
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-context-action="rename"]')
      ?.click();

    const input = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>("[data-moss-library-rename-input]");
      expect(found).not.toBeNull();
      return found!;
    });
    input.value = "renamed-alpha.txt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-toast]")?.textContent).toContain(
        "无法更改文件扩展名",
      );
    });
    // The title is untouched.
    await expect.element(page.getByText("alpha.md")).toBeInTheDocument();
  });

  it("shows the Codex drop prompt while files are dragged over the page", async () => {
    const { items } = fixture();
    await render(<MossLibrarySurface onClose={() => undefined} initialItems={items} now={NOW} />);

    const host = document.querySelector("[data-moss-library-host]")!;
    // A real file drag marks dataTransfer.types with "Files"; adding a File
    // item to a synthetic DataTransfer sets the same marker.
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["x"], "drop.png", { type: "image/png" }));
    host.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }),
    );
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-drop-prompt]")?.textContent).toContain(
        "将任意文件拖放到此处，即可添加到你的资料库",
      );
    });
  });

  it("moves store-mode deletes into the 回收站 view and restores them", async () => {
    const { items } = fixture();
    const original = useMossLibraryItemsStore.getState();
    // Explicit acknowledged server responses replace the old offline local replay.
    const trash = vi.fn(async (ids: readonly string[]) => {
      const state = useMossLibraryItemsStore.getState();
      useMossLibraryItemsStore.setState({
        items: state.items.filter((item) => !ids.includes(item.id)),
        trashedItems: state.items
          .filter((item) => ids.includes(item.id))
          .map((item) => ({ ...item, trashedAt: NOW })),
      });
      return true;
    });
    const restore = vi.fn(async (ids: readonly string[]) => {
      const state = useMossLibraryItemsStore.getState();
      useMossLibraryItemsStore.setState({
        items: [...state.items, ...state.trashedItems.filter((item) => ids.includes(item.id))],
        trashedItems: state.trashedItems.filter((item) => !ids.includes(item.id)),
      });
      return true;
    });
    useMossLibraryItemsStore.setState({
      items,
      trashedItems: [],
      hydrated: true,
      catalogSource: "server",
      trashItems: trash,
      restoreItems: restore,
    });
    await render(<MossLibrarySurface onClose={() => undefined} now={NOW} />);

    await expect.element(page.getByText("alpha.md")).toBeInTheDocument();
    await page.getByText("alpha.md").click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-selection-bar]")).not.toBeNull();
    });
    document
      .querySelector<HTMLButtonElement>('[data-moss-library-selection-action="delete"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-item="doc-alpha"]')).toBeNull();
      expect(document.querySelector("[data-moss-library-toast]")?.textContent).toContain(
        "已移至回收站",
      );
    });

    // 回收站 entry lives in the settings (⚙) menu per Codex §2.8.
    document.querySelector<HTMLButtonElement>("[data-moss-library-settings]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-trash-open]")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>("[data-moss-library-trash-open]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-trash-view]")).not.toBeNull();
      expect(document.querySelector('[data-moss-library-trash-item="doc-alpha"]')).not.toBeNull();
    });

    document
      .querySelector<HTMLButtonElement>('[data-moss-library-trash-restore="doc-alpha"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-trash-item="doc-alpha"]')).toBeNull();
    });
    document.querySelector<HTMLButtonElement>("[data-moss-library-trash-back]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-item="doc-alpha"]')).not.toBeNull();
    });
    expect(trash).toHaveBeenCalledExactlyOnceWith(["doc-alpha"]);
    expect(restore).toHaveBeenCalledExactlyOnceWith(["doc-alpha"]);
    useMossLibraryItemsStore.setState({
      trashItems: original.trashItems,
      restoreItems: original.restoreItems,
    });
  });

  it("permanently deletes from the 回收站 and shows the empty trash state", async () => {
    const { items } = fixture();
    const alpha = items.find((item) => item.id === "doc-alpha")!;
    const originalDelete = useMossLibraryItemsStore.getState().deleteItemsPermanently;
    const remove = vi.fn(async () => {
      useMossLibraryItemsStore.setState({ trashedItems: [] });
      return true;
    });
    useMossLibraryItemsStore.setState({
      items: [],
      trashedItems: [{ ...alpha, trashedAt: NOW - 60_000 }],
      hydrated: true,
      catalogSource: "server",
      deleteItemsPermanently: remove,
    });
    await render(<MossLibrarySurface onClose={() => undefined} now={NOW} />);

    document.querySelector<HTMLButtonElement>("[data-moss-library-settings]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-trash-open]")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>("[data-moss-library-trash-open]")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-moss-library-trash-item="doc-alpha"]')).not.toBeNull();
    });

    document
      .querySelector<HTMLButtonElement>('[data-moss-library-trash-delete="doc-alpha"]')
      ?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-moss-library-trash-empty-state]")).not.toBeNull();
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith(["doc-alpha"]);
    useMossLibraryItemsStore.setState({ deleteItemsPermanently: originalDelete });
  });
});
