// @vitest-environment happy-dom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MossCanvasBinding } from "~/lib/mossCanvasClient";
import type { MossCanvasSelection } from "~/lib/mossCanvasSelection";

interface CanvasProps {
  threadId?: string | null;
  prepareThread?: () => Promise<string | null>;
  onLeaveGuardChange: (guard: (() => Promise<boolean>) | null) => void;
  onSelectionChange: (selection: MossCanvasSelection, binding: MossCanvasBinding) => void;
  onImportStateChange: (state: "loading" | "ready" | "failed") => void;
}
const calls = vi.hoisted(() => ({
  share: vi.fn(),
  download: vi.fn(),
  readSelection: vi.fn(),
  importFiles: vi.fn(),
  favorite: vi.fn(),
  flush: vi.fn(),
  canvas: null as CanvasProps | null,
}));
vi.mock("~/lib/mossLibraryAssetActions", () => ({
  shareMossLibraryImage: calls.share,
  downloadMossLibraryItem: calls.download,
}));
vi.mock("~/lib/mossCanvasClient", () => ({ readMossCanvasSelectionFile: calls.readSelection }));
vi.mock("./MossCanvasWebSurface", () => ({
  MossCanvasWebSurface: (props: CanvasProps) => {
    calls.canvas = props;
    const leaveGuard = props.onLeaveGuardChange;
    React.useEffect(() => {
      leaveGuard(calls.flush);
      return () => leaveGuard(null);
    }, [leaveGuard]);
    return <div data-testid="full-canvas-host" />;
  },
}));
import { MossLibrarySurface } from "./MossLibrarySurface";
import { useMossLibraryItemsStore } from "~/mossLibraryItemsStore";
import type { MossLibraryItem } from "./MossLibrarySurface.logic";

const image: MossLibraryItem = {
  id: "owned",
  title: "synthetic.png",
  kind: "image",
  sourceCli: "moss",
  updatedAt: 1,
  favorite: false,
  sectionIds: ["images"],
  subtitleZh: "图片",
  path: "D:/synthetic/owned.png",
};
const binding: MossCanvasBinding = {
  expectedAccount: { id: "synthetic-owner", realm: "test" },
  expectedWorkspace: { threadId: "thread-a", fingerprint: "a".repeat(64) },
};
const selection: MossCanvasSelection = {
  type: "moss-canvas-selection",
  version: 1,
  threadId: "thread-a",
  sequence: 1,
  documentEpoch: 1,
  items: [
    {
      shapeId: "shape:owned",
      assetId: `moss-canvas-asset:${"b".repeat(64)}.png`,
      title: "selected.png",
    },
  ],
};
const initialStore = useMossLibraryItemsStore.getState();
beforeEach(() => {
  vi.resetAllMocks();
  calls.canvas = null;
  calls.flush.mockResolvedValue(true);
  calls.importFiles.mockResolvedValue({ imported: 1, skipped: 0 });
  calls.readSelection.mockResolvedValue(
    new File([new Uint8Array([1, 3, 7, 9])], "selected.png", { type: "image/png" }),
  );
  useMossLibraryItemsStore.setState({
    ...initialStore,
    items: [image],
    hydrated: true,
    catalogSource: "server",
    loadError: null,
    refresh: vi.fn(async () => undefined),
    ensureThumbnail: vi.fn(),
    favoriteItems: calls.favorite,
    importFileBlobs: calls.importFiles,
  });
});
afterEach(() => {
  cleanup();
  useMossLibraryItemsStore.setState(initialStore, true);
});

async function context(action: string) {
  fireEvent.contextMenu(document.querySelector(`[data-moss-library-item="${image.id}"]`)!, {
    clientX: 20,
    clientY: 20,
  });
  fireEvent.click(
    await waitFor(() => {
      const button = document.querySelector(`[data-moss-library-context-action="${action}"]`);
      expect(button).not.toBeNull();
      return button!;
    }),
  );
}
async function openCanvas() {
  fireEvent.click(document.querySelector("[data-moss-library-new]")!);
  fireEvent.click(document.querySelector('[data-moss-library-new-action="from-canvas"]')!);
  await screen.findByTestId("full-canvas-host");
  act(() => calls.canvas!.onSelectionChange(selection, binding));
}

describe("Library runtime actions", () => {
  it("loads thumbnails when opening an image folder from the folders tab", async () => {
    const folder: MossLibraryItem = {
      id: "owned-folder",
      title: "Imported images",
      kind: "folder",
      sourceCli: "moss",
      updatedAt: 1,
      favorite: false,
      sectionIds: ["folders"],
      subtitleZh: "文件夹",
    };
    const child = { ...image, folderId: folder.id };
    const ensureThumbnail = vi.fn();
    useMossLibraryItemsStore.setState({ items: [folder, child], ensureThumbnail });
    render(<MossLibrarySurface onClose={() => undefined} />);

    fireEvent.click(document.querySelector('[data-moss-library-section="folders"]')!);
    fireEvent.click(
      await waitFor(() => {
        const card = document.querySelector(`[data-moss-library-item="${folder.id}"]`);
        expect(card).not.toBeNull();
        return card!;
      }),
    );
    await waitFor(() => expect(ensureThumbnail).toHaveBeenCalledExactlyOnceWith(child));

    const thumbnailUrl = "data:image/png;base64,AQMHCQ==";
    act(() => useMossLibraryItemsStore.setState({ thumbnails: { [child.id]: thumbnailUrl } }));
    const thumbnail = document.querySelector<HTMLImageElement>(
      `[data-moss-library-folder-view="${folder.id}"] [data-moss-library-item="${child.id}"] img[data-moss-library-thumb]`,
    );
    expect(thumbnail?.getAttribute("src")).toBe(thumbnailUrl);
  });
  it("announces image sharing only after the real clipboard operation resolves", async () => {
    let finish!: () => void;
    calls.share.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<MossLibrarySurface onClose={() => undefined} initialItems={[image]} />);
    await context("share");
    expect(calls.share.mock.calls[0]?.[0]).toEqual([image]);
    expect(document.querySelector("[data-moss-library-toast]")).toBeNull();
    await act(async () => finish());
    expect(screen.getByText("图片已复制到剪贴板，可粘贴分享")).toBeTruthy();
  });
  it("reports an image sharing error without copying titles or announcing success", async () => {
    calls.share.mockRejectedValueOnce(new Error("剪贴板拒绝图片"));
    render(<MossLibrarySurface onClose={() => undefined} initialItems={[image]} />);
    await context("share");
    await screen.findByText("剪贴板拒绝图片");
    expect(screen.queryByText("图片已复制到剪贴板，可粘贴分享")).toBeNull();
  });
  it("does not announce a runtime favorite until its server acknowledgement, or fake success on false", async () => {
    let finish!: (value: boolean) => void;
    calls.favorite.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<MossLibrarySurface onClose={() => undefined} />);
    await waitFor(() =>
      expect(document.querySelector('[data-moss-library-item="owned"]')).not.toBeNull(),
    );
    await context("favorite");
    expect(document.querySelector("[data-moss-library-toast]")).toBeNull();
    await act(async () => finish(false));
    expect(screen.getByText("操作尚未确认，请刷新资料库核对后再试。")).toBeTruthy();
    expect(screen.queryByText("已收藏 1 项")).toBeNull();
  });
  it("uses the bound complete Canvas selection and imports its exact original bytes after flush", async () => {
    const guard = vi.fn();
    const prepare = vi.fn(async () => "thread-a");
    render(
      <MossLibrarySurface
        onClose={() => undefined}
        initialItems={[image]}
        threadId="thread-a"
        prepareThread={prepare}
        onCanvasLeaveGuardChange={guard}
      />,
    );
    await openCanvas();
    expect(calls.canvas?.threadId).toBe("thread-a");
    expect(calls.canvas?.prepareThread).toBe(prepare);
    fireEvent.click(document.querySelector("[data-moss-library-canvas-save]")!);
    await waitFor(() =>
      expect(calls.importFiles).toHaveBeenCalledExactlyOnceWith([
        { name: "selected.png", mimeType: "image/png", dataBase64: "AQMHCQ==" },
      ]),
    );
    expect(calls.flush).toHaveBeenCalledTimes(1);
    expect(calls.readSelection).toHaveBeenCalledExactlyOnceWith(selection.items[0], binding);
    await waitFor(() =>
      expect(document.querySelector("[data-moss-library-canvas-picker]")).toBeNull(),
    );
    expect(guard).toHaveBeenLastCalledWith(null);
  });
  it("keeps the Canvas selection on import failure and never retries automatically", async () => {
    calls.importFiles.mockRejectedValueOnce(new Error("storage unavailable"));
    render(
      <MossLibrarySurface onClose={() => undefined} initialItems={[image]} threadId="thread-a" />,
    );
    await openCanvas();
    fireEvent.click(document.querySelector("[data-moss-library-canvas-save]")!);
    await screen.findByText("画布图片保存尚未确认，请返回资料库核对；当前选择仍保留。");
    expect(document.querySelector("[data-moss-library-canvas-picker]")).not.toBeNull();
    expect(
      (document.querySelector("[data-moss-library-canvas-save]") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(calls.importFiles).toHaveBeenCalledTimes(1);
  });
  it("rejects a selection that changes while awaiting Canvas save acknowledgement", async () => {
    let finish!: (value: boolean) => void;
    calls.flush.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <MossLibrarySurface onClose={() => undefined} initialItems={[image]} threadId="thread-a" />,
    );
    await openCanvas();
    fireEvent.click(document.querySelector("[data-moss-library-canvas-save]")!);
    act(() => calls.canvas!.onSelectionChange({ ...selection, sequence: 2, items: [] }, binding));
    await act(async () => finish(true));
    expect(calls.readSelection).not.toHaveBeenCalled();
    expect(calls.importFiles).not.toHaveBeenCalled();
  });
  it("does not import a Canvas image after its account is retired during the byte read", async () => {
    let active = true;
    calls.readSelection.mockImplementationOnce(async () => {
      active = false;
      return new File(["old"], "old.png", { type: "image/png" });
    });
    render(
      <MossLibrarySurface
        onClose={() => undefined}
        initialItems={[image]}
        threadId="thread-a"
        isCurrent={() => active}
      />,
    );
    await openCanvas();
    fireEvent.click(document.querySelector("[data-moss-library-canvas-save]")!);
    await waitFor(() => expect(calls.readSelection).toHaveBeenCalledTimes(1));
    expect(calls.importFiles).not.toHaveBeenCalled();
    expect(document.querySelector("[data-moss-library-toast]")).toBeNull();
  });
  it("retires the previous thread selection when the library's active conversation changes", async () => {
    const view = render(
      <MossLibrarySurface onClose={() => undefined} initialItems={[image]} threadId="thread-a" />,
    );
    await openCanvas();
    view.rerender(
      <MossLibrarySurface onClose={() => undefined} initialItems={[image]} threadId="thread-b" />,
    );
    expect(
      (document.querySelector("[data-moss-library-canvas-save]") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.readSelection).not.toHaveBeenCalled();
  });
  it("rejects later selection messages after Canvas reports that the bound document failed", async () => {
    render(
      <MossLibrarySurface onClose={() => undefined} initialItems={[image]} threadId="thread-a" />,
    );
    await openCanvas();
    act(() => {
      calls.canvas!.onImportStateChange("failed");
      calls.canvas!.onSelectionChange({ ...selection, documentEpoch: 2 }, binding);
    });
    expect(
      (document.querySelector("[data-moss-library-canvas-save]") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.readSelection).not.toHaveBeenCalled();
  });
});
