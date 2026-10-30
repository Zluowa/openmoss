// @vitest-environment happy-dom
import React, { type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { importMossCanvasLocalImages, MossCanvasBinding } from "~/lib/mossCanvasClient";
import { MossCanvasWebSurface, type MossCanvasComposeContextReader } from "./MossCanvasWebSurface";

const mocks = vi.hoisted(() => ({
  key: "account-a",
  current: true,
  isCurrent: vi.fn(() => true),
  binding: vi.fn<() => Promise<MossCanvasBinding>>(),
  import: vi.fn<typeof importMossCanvasLocalImages>(),
  navigate: vi.fn(),
  selectRoute: vi.fn(),
  blocker: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useBlocker: (value: unknown) => mocks.blocker(value),
}));
vi.mock("../railShellStore", () => ({
  useRailShellStore: { getState: () => ({ selectRouteItem: mocks.selectRoute }) },
}));
vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarWindowControlsGutterClassName: () => "",
}));
vi.mock("../lib/wsHttpUrl", () => ({
  resolveWsHttpUrl: (path: string) => `http://moss.test${path}`,
}));
vi.mock("../lib/mossImagesAccountBoundary", () => ({
  useMossImagesAccountBoundary: () => ({
    key: mocks.key,
    isCurrent: mocks.isCurrent,
    transitioning: false,
  }),
}));
vi.mock("../lib/mossCanvasClient", () => ({
  loadMossCanvasBinding: mocks.binding,
  importMossCanvasLocalImages: mocks.import,
}));

type Props = ComponentProps<typeof MossCanvasWebSurface>;
type Request = {
  type: string;
  threadId?: string;
  requestId?: string;
  items?: Array<{ id: string; assetId: string; title: string }>;
  focus?: boolean;
  activeImageId?: string;
  expectedDocumentEpoch?: number;
  expectedSelectionSequence?: number;
};
const binding: MossCanvasBinding = {
  expectedAccount: { id: "account-a", realm: "memfire-phone" },
  expectedWorkspace: { threadId: "thread-a", fingerprint: "a".repeat(64) },
};
const images = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`,
    path: `/workspace/${index}.png`,
    name: `${index}.png`,
  }));
const local = (count: number, active = 0): NonNullable<Props["localImages"]> => ({
  images: images(count),
  activeImageId: `image-${active}`,
  action: "canvas",
});
const resultFor = (input: Parameters<typeof importMossCanvasLocalImages>[0]) => ({
  items: input.images.map((image) => ({
    sourceId: image.id,
    id: `imported:${image.id}`,
    title: image.name,
    assetId: `moss-canvas-asset:${"a".repeat(64)}.png`,
  })),
  unavailable: [] as string[],
});
const selectedImage = {
  shapeId: "shape:selected",
  assetId: `moss-canvas-asset:${"a".repeat(64)}.png`,
  title: "selected.png",
};
const selection = (sequence = 1, documentEpoch = 1) => ({
  type: "moss-canvas-selection",
  version: 1,
  threadId: "thread-a",
  sequence,
  documentEpoch,
  items: [selectedImage],
});
const tick = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.key = "account-a";
  mocks.current = true;
  mocks.isCurrent.mockReset().mockImplementation(() => mocks.current);
  mocks.binding.mockReset().mockResolvedValue(binding);
  mocks.import.mockReset().mockImplementation(async (input) => resultFor(input));
  mocks.navigate.mockReset();
  mocks.selectRoute.mockReset();
  mocks.blocker.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("canvas", { status: 200 })),
  );
  const happyWindow = window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean } };
  };
  happyWindow.happyDOM.settings.disableIframePageLoading = true;
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(overrides: Partial<Props> = {}) {
  const props = {
    threadId: "thread-a",
    onClose: vi.fn(),
    onImportStateChange: vi.fn(),
    onSelectionChange: vi.fn(),
    onLeaveGuardChange: vi.fn(),
    onComposeContextChange: vi.fn(),
    localImages: local(1),
    ...overrides,
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<MossCanvasWebSurface {...props} />);
  });
  const iframe = screen.getByTitle("Moss Canvas") as HTMLIFrameElement;
  const post = vi.fn<(message: Request, origin: string) => void>();
  const frameWindow = { postMessage: post } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, value: frameWindow });
  const emit = (
    data: unknown,
    origin = "http://moss.test",
    source: MessageEventSource = frameWindow,
  ) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    });
  const ready = () =>
    emit({ type: "moss-canvas-ready", version: 1, threadId: "thread-a", documentEpoch: 1 });
  const requests = (type = "moss-canvas-open-assets") =>
    post.mock.calls.map(([message]) => message).filter((message) => message.type === type);
  const acknowledge = (request: Request, ok = true, extra: object = {}) =>
    emit({
      type: "moss-canvas-open-assets-result",
      version: 1,
      threadId: "thread-a",
      documentEpoch: 1,
      requestId: request.requestId,
      ok,
      ...extra,
    });
  return { props, view, iframe, frameWindow, post, emit, ready, requests, acknowledge };
}

describe("Canvas conversation preparation", () => {
  it("keeps loading feedback until this Canvas completes its ready handshake", async () => {
    const host = await mount();
    expect(screen.getByRole("status").textContent).toBe("正在加载画布…");
    await host.emit({
      type: "moss-canvas-ready",
      version: 1,
      threadId: "another-thread",
      documentEpoch: 1,
    });
    expect(screen.getByRole("status").textContent).toBe("正在加载画布…");
    await host.ready();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not open an unbound Canvas when no conversation folder can be prepared", async () => {
    const prepareThread = vi.fn(async () => null);
    await act(async () => {
      render(
        <MossCanvasWebSurface threadId={null} prepareThread={prepareThread} onClose={vi.fn()} />,
      );
    });
    expect(prepareThread).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toContain("请先选择此会话的工作文件夹");
    expect(screen.queryByTitle("Moss Canvas")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits for preparation and opens only the returned conversation Canvas", async () => {
    let resolve!: (id: string | null) => void;
    const prepareThread = vi.fn(() => new Promise<string | null>((done) => (resolve = done)));
    await act(async () => {
      render(
        <MossCanvasWebSurface threadId={null} prepareThread={prepareThread} onClose={vi.fn()} />,
      );
    });
    expect(screen.queryByTitle("Moss Canvas")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      resolve("thread-prepared");
    });
    const iframe = screen.getByTitle("Moss Canvas") as HTMLIFrameElement;
    const url = new URL(iframe.src);
    expect(prepareThread).toHaveBeenCalledOnce();
    expect(url.searchParams.get("moss_thread")).toBe("thread-prepared");
    expect(url.searchParams.get("projectId")).toBe("thread:thread-prepared");
    expect(url.searchParams.get("projectKey")).toBe("thread-prepared");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Canvas closed and explains a failed conversation preparation", async () => {
    const prepareThread = vi.fn(async () => {
      throw new Error("workspace unavailable");
    });
    await act(async () => {
      render(
        <MossCanvasWebSurface threadId={null} prepareThread={prepareThread} onClose={vi.fn()} />,
      );
    });
    expect(prepareThread).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toContain("工作文件夹尚未就绪");
    expect(screen.queryByTitle("Moss Canvas")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens an existing conversation without requiring preparation", async () => {
    const prepareThread = vi.fn(async () => null);
    const host = await mount({ threadId: "thread-existing", prepareThread });
    expect(prepareThread).not.toHaveBeenCalled();
    expect(new URL(host.iframe.src).searchParams.get("moss_thread")).toBe("thread-existing");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("complete Canvas host boundaries", () => {
  it("opens 65 outputs in acknowledged batches of at most 32, focusing only the first explicit batch", async () => {
    const host = await mount({ localImages: local(65, 64) });
    await host.ready();
    expect(host.requests()).toHaveLength(1);
    expect(host.requests()[0]).toMatchObject({
      focus: true,
      activeImageId: "imported:image-64",
      expectedDocumentEpoch: 1,
    });
    expect(host.requests()[0]!.items).toHaveLength(32);
    expect(host.props.onImportStateChange).not.toHaveBeenCalledWith("ready");
    await host.acknowledge(host.requests()[0]!);
    expect(host.requests()).toHaveLength(2);
    expect(host.requests()[1]).toMatchObject({ focus: false });
    expect(host.requests()[1]!.items).toHaveLength(32);
    await host.acknowledge(host.requests()[1]!);
    expect(host.requests()).toHaveLength(3);
    expect(host.requests()[2]!.items).toHaveLength(1);
    expect(host.requests()[2]!.focus).toBe(false);
    await host.acknowledge(host.requests()[2]!);
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("ready");
    expect(host.post.mock.calls.every(([, origin]) => origin === "http://moss.test")).toBe(true);
    expect(host.requests()[0]!.items![0]).not.toHaveProperty("sourceId");
  });

  it("appends only new assets without changing selection and reuses the import cache", async () => {
    const host = await mount({ localImages: local(2) });
    await host.ready();
    await host.acknowledge(host.requests()[0]!);
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(3)} />);
    });
    expect(host.requests()).toHaveLength(2);
    expect(host.requests()[1]).toMatchObject({ focus: false, items: [{ id: "imported:image-2" }] });
    expect(mocks.import.mock.calls[1]![0].cache).toBe(mocks.import.mock.calls[0]![0].cache);
    await host.acknowledge(host.requests()[1]!);
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(3, 1)} />);
    });
    expect(host.requests()[2]).toMatchObject({
      focus: true,
      activeImageId: "imported:image-1",
      items: [{ id: "imported:image-1" }],
    });
    await host.acknowledge(host.requests()[2]!);
  });

  it("queues streamed history behind every outstanding acknowledgement without replaying the first batch", async () => {
    const host = await mount({ localImages: local(33) });
    await host.ready();
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(34)} />);
    });
    expect(host.requests()).toHaveLength(1);
    expect(mocks.import).toHaveBeenCalledTimes(1);
    await host.acknowledge(host.requests()[0]!);
    expect(host.requests()).toHaveLength(2);
    expect(host.requests()[1]!.items).toHaveLength(1);
    await host.acknowledge(host.requests()[1]!);
    expect(host.requests()).toHaveLength(3);
    expect(host.requests()[2]).toMatchObject({
      focus: false,
      items: [{ id: "imported:image-33" }],
    });
    await host.acknowledge(host.requests()[2]!);
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("ready");
  });

  it("keeps the latest initial selection until the account/workspace binding arrives", async () => {
    let resolveBinding!: (value: MossCanvasBinding) => void;
    mocks.binding.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBinding = resolve;
        }),
    );
    const host = await mount();
    await host.emit(selection(4));
    await host.ready();
    await host.emit(selection(5));
    expect(host.props.onSelectionChange).not.toHaveBeenCalled();
    await act(async () => {
      resolveBinding(binding);
    });
    expect(host.props.onSelectionChange).toHaveBeenCalledExactlyOnceWith(selection(5), binding);
    await host.acknowledge(host.requests()[0]!);
    await host.ready();
    await host.emit(selection(4));
    expect(host.props.onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it("does not accept readiness or acknowledgements without their thread and document lease", async () => {
    const host = await mount();
    await host.emit({ type: "moss-canvas-ready", version: 1, threadId: "thread-a" });
    expect(mocks.import).not.toHaveBeenCalled();
    await host.ready();
    const request = host.requests()[0]!;
    await host.emit({
      type: "moss-canvas-open-assets-result",
      version: 1,
      requestId: request.requestId,
      documentEpoch: 1,
      ok: true,
    });
    await host.emit({
      type: "moss-canvas-open-assets-result",
      version: 1,
      threadId: "thread-a",
      requestId: request.requestId,
      ok: true,
    });
    expect(host.props.onImportStateChange).not.toHaveBeenCalledWith("ready");
    await host.acknowledge(request);
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("ready");
  });

  it("rejects a document change while its initial owner binding is still loading", async () => {
    let resolveBinding!: (value: MossCanvasBinding) => void;
    mocks.binding.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBinding = resolve;
        }),
    );
    const host = await mount();
    await host.ready();
    await host.emit(selection(1, 2));
    await host.ready();
    await act(async () => {
      resolveBinding(binding);
    });
    expect(host.requests()).toHaveLength(0);
    expect(mocks.import).not.toHaveBeenCalled();
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("failed");
    expect(screen.getByRole("alert").textContent).toContain("文档已切换");
  });

  it("ignores foreign frames, origins, threads and mismatched request acknowledgements", async () => {
    const host = await mount({ localImages: local(33) });
    const ready = { type: "moss-canvas-ready", version: 1, threadId: "thread-a", documentEpoch: 1 };
    await host.emit(ready, "http://other.test");
    await host.emit(ready, "http://moss.test", window);
    await host.emit({ ...ready, threadId: "other" });
    expect(mocks.import).not.toHaveBeenCalled();
    await host.ready();
    const ack = {
      type: "moss-canvas-open-assets-result",
      version: 1,
      threadId: "thread-a",
      documentEpoch: 1,
      requestId: host.requests()[0]!.requestId,
      ok: true,
    };
    await host.emit(ack, "http://other.test");
    await host.emit(ack, "http://moss.test", window);
    await host.emit({ ...ack, threadId: "other" });
    await host.emit({ ...ack, requestId: "wrong" });
    expect(host.requests()).toHaveLength(1);
    await host.emit(ack);
    expect(host.requests()).toHaveLength(2);
    await host.acknowledge(host.requests()[1]!);
  });

  it("warns about unavailable history after confirming the available selected image", async () => {
    mocks.import.mockImplementation(async (input) => ({
      ...resultFor({ ...input, images: [input.images[0]!] }),
      unavailable: ["image-1"],
    }));
    const host = await mount({ localImages: local(2) });
    await host.ready();
    expect(screen.queryByText(/历史图片暂不可用/)).toBeNull();
    await host.acknowledge(host.requests()[0]!);
    expect(screen.getByText(/1 张历史图片暂不可用/)).not.toBeNull();
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("ready");
  });

  it("fails an unreadable selection and does not retry it when unrelated outputs arrive", async () => {
    mocks.import.mockRejectedValue(new Error("当前选中的图片无法读取"));
    const host = await mount();
    await host.ready();
    expect(host.requests()).toHaveLength(0);
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("failed");
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(2)} />);
    });
    expect(mocks.import).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("无法读取");
  });

  it("stops after an acknowledgement timeout and ignores a late success without retrying", async () => {
    const host = await mount({ localImages: local(33) });
    await host.ready();
    const first = host.requests()[0]!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_001);
    });
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("failed");
    expect(screen.getByRole("alert").textContent).toContain("尚未确认");
    await host.acknowledge(first);
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(34)} />);
    });
    expect(host.requests()).toHaveLength(1);
    expect(mocks.import).toHaveBeenCalledTimes(1);
    expect(host.props.onImportStateChange).not.toHaveBeenCalledWith("ready");
  });

  it("cancels an in-flight import when the document epoch changes and rejects old selection messages", async () => {
    const host = await mount({ localImages: local(33) });
    await host.ready();
    const first = host.requests()[0]!;
    const selected = {
      type: "moss-canvas-selection",
      version: 1,
      threadId: "thread-a",
      sequence: 4,
      documentEpoch: 2,
      items: [],
    };
    await host.emit(selected);
    expect(host.props.onSelectionChange).toHaveBeenCalledTimes(1);
    await host.emit({ ...selected, sequence: 99, documentEpoch: 1 });
    expect(host.props.onSelectionChange).toHaveBeenCalledTimes(1);
    await host.acknowledge(first);
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(34)} />);
    });
    expect(host.requests()).toHaveLength(1);
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("failed");
    expect(screen.getByRole("alert").textContent).toContain("文档已切换");
  });

  it("treats a changed document in the import acknowledgement as a terminal lease change", async () => {
    const host = await mount({ localImages: local(33) });
    await host.ready();
    await host.acknowledge(host.requests()[0]!, false, {
      documentEpoch: 2,
      errorCode: "canvas_document_changed",
    });
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} localImages={local(34, 1)} />);
    });
    expect(host.requests()).toHaveLength(1);
    expect(host.props.onImportStateChange).toHaveBeenLastCalledWith("failed");
    expect(screen.getByRole("alert").textContent).toContain("文档已切换");
  });

  it("awaits imports before saving and prevents close when the flush fails", async () => {
    const host = await mount();
    await host.ready();
    const guard = vi
      .mocked(host.props.onLeaveGuardChange)
      .mock.calls.at(-1)![0] as () => Promise<boolean>;
    let saved!: Promise<boolean>;
    await act(async () => {
      saved = guard();
    });
    expect(host.requests("moss-canvas-flush")).toHaveLength(0);
    await host.acknowledge(host.requests()[0]!);
    const flush = host.requests("moss-canvas-flush")[0]!;
    await host.emit({ type: "moss-canvas-flushed", requestId: flush.requestId, ok: false });
    expect(await saved).toBe(false);
    expect(host.props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("未保存完成");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "关闭画布" }));
    });
    const retry = host.requests("moss-canvas-flush")[1]!;
    await host.emit({ type: "moss-canvas-flushed", requestId: retry.requestId, ok: true });
    expect(host.props.onClose).toHaveBeenCalledTimes(1);
  });

  it("waits for a slow pinned Canvas save acknowledgement before allowing close", async () => {
    const host = await mount();
    await host.ready();
    await host.acknowledge(host.requests()[0]!);
    vi.useFakeTimers();
    const guard = vi.mocked(host.props.onLeaveGuardChange).mock.calls.at(-1)![0]!;
    let saving!: Promise<boolean>;
    let settled = false;
    await act(async () => {
      saving = guard();
      void saving.then(() => {
        settled = true;
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(settled).toBe(false);
    expect(host.props.onClose).not.toHaveBeenCalled();
    const flush = host.requests("moss-canvas-flush")[0]!;
    await host.emit({ type: "moss-canvas-flushed", requestId: flush.requestId, ok: true });
    expect(await saving).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("allows only the latest navigation after one successful flush", async () => {
    const host = await mount();
    await host.ready();
    await host.acknowledge(host.requests()[0]!);
    await host.emit({ type: "moss-canvas-navigation", destination: "account" });
    await host.emit({ type: "moss-canvas-navigation", destination: "plugins" });
    expect(host.requests("moss-canvas-flush")).toHaveLength(1);
    expect(host.props.onClose).not.toHaveBeenCalled();
    await host.emit({
      type: "moss-canvas-flushed",
      requestId: host.requests("moss-canvas-flush")[0]!.requestId,
      ok: true,
    });
    expect(host.props.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/plugins" });
  });

  it("keeps the canvas open if the destination route rejects after a successful save", async () => {
    const host = await mount();
    await host.ready();
    await host.acknowledge(host.requests()[0]!);
    mocks.navigate.mockRejectedValueOnce(new Error("route unavailable"));
    await host.emit({ type: "moss-canvas-navigation", destination: "plugins" });
    await host.emit({
      type: "moss-canvas-flushed",
      requestId: host.requests("moss-canvas-flush")[0]!.requestId,
      ok: true,
    });
    expect(host.props.onClose).not.toHaveBeenCalled();
    expect(mocks.selectRoute).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("画布和草稿已保留");
  });

  it("discards a pending file import after switching account without messaging the old frame", async () => {
    let resolveImport!: (value: Awaited<ReturnType<typeof importMossCanvasLocalImages>>) => void;
    mocks.import.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    const host = await mount();
    await host.ready();
    const input = mocks.import.mock.calls[0]![0];
    mocks.key = "account-b";
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} />);
    });
    expect(input.isCurrent()).toBe(false);
    await act(async () => {
      resolveImport(resultFor(input));
    });
    expect(host.requests()).toHaveLength(0);
    expect(host.props.onImportStateChange).not.toHaveBeenCalledWith("ready");
    await host.view.unmount();
    await tick();
  });

  it("authenticates bootstrap requests and does not send the old account's bootstrap after replacement", async () => {
    const host = await mount();
    await host.emit({ type: "moss-canvas-bootstrap-ready" }, "http://other.test");
    await host.emit({ type: "moss-canvas-bootstrap-ready" }, "http://moss.test", window);
    expect(host.requests("moss-canvas-bootstrap")).toHaveLength(0);
    await host.emit({ type: "moss-canvas-bootstrap-ready" });
    expect(host.requests("moss-canvas-bootstrap")).toHaveLength(1);
    mocks.key = "account-b";
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} />);
    });
    expect(screen.getByTitle("Moss Canvas")).not.toBe(host.iframe);
    await host.emit({ type: "moss-canvas-bootstrap-ready" });
    expect(host.requests("moss-canvas-bootstrap")).toHaveLength(1);
  });
});

describe("Canvas compose context", () => {
  async function startRead() {
    const host = await mount();
    await host.ready();
    await host.acknowledge(host.requests()[0]!);
    await host.emit(selection(7));
    const reader = vi
      .mocked(host.props.onComposeContextChange)
      .mock.calls.at(-1)![0] as MossCanvasComposeContextReader;
    let work!: ReturnType<MossCanvasComposeContextReader>;
    await act(async () => {
      work = reader();
    });
    expect(host.requests("moss-canvas-compose-context")).toHaveLength(0);
    const flush = host.requests("moss-canvas-flush")[0]!;
    await host.emit({ type: "moss-canvas-flushed", requestId: flush.requestId, ok: true });
    const request = host.requests("moss-canvas-compose-context")[0]!;
    const response = {
      type: "moss-canvas-compose-context-result",
      version: 1,
      threadId: "thread-a",
      requestId: request.requestId,
      documentEpoch: 1,
      selectionSequence: 7,
      ok: true,
      items: [
        {
          ...selectedImage,
          context: {
            annotations: [{ kind: "draw", x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
            comments: [
              { text: "把选中位置改为红色", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
            ],
            annotationAssetId: `moss-canvas-asset:${"b".repeat(64)}.png`,
            truncated: false,
          },
        },
      ],
    };
    return { ...host, reader, work, request, response };
  }

  it("flushes then reads bounded annotations and comments under the same document and selection lease", async () => {
    const host = await startRead();
    expect(host.request).toMatchObject({
      version: 1,
      threadId: "thread-a",
      expectedDocumentEpoch: 1,
      expectedSelectionSequence: 7,
    });
    expect(host.reader()).toBe(host.work);
    await host.emit(host.response);
    expect(await host.work).toEqual({ context: host.response, binding });
    expect(host.requests("moss-canvas-compose-context")).toHaveLength(1);
  });

  it("ignores other frames, origins, threads and requests without attaching their context", async () => {
    const host = await startRead();
    await host.emit(host.response, "http://other.test");
    await host.emit(host.response, "http://moss.test", window);
    await host.emit({ ...host.response, threadId: "other" });
    await host.emit({ ...host.response, requestId: "wrong" });
    await host.emit(host.response);
    expect(await host.work).toEqual({ context: host.response, binding });
  });

  it("rejects stale selections and retains the draft when the context request is delayed", async () => {
    const host = await startRead();
    await host.emit(selection(8));
    await host.emit(host.response);
    expect(await host.work).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("尚未确认");
    expect(host.props.onClose).not.toHaveBeenCalled();
  });

  it("times out once without automatically retrying a potentially completed context export", async () => {
    const host = await startRead();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(await host.work).toBeNull();
    await host.emit(host.response);
    expect(host.requests("moss-canvas-compose-context")).toHaveLength(1);
  });

  it("explains truncated context and refuses to send a partial annotation export", async () => {
    const host = await startRead();
    await host.emit({
      ...host.response,
      ok: false,
      errorCode: "canvas_context_truncated",
      items: undefined,
    });
    expect(await host.work).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("缩小选择");
  });

  it("discards a pending context request when its account frame is replaced", async () => {
    const host = await startRead();
    mocks.key = "account-b";
    await act(async () => {
      host.view.rerender(<MossCanvasWebSurface {...host.props} />);
    });
    await host.emit(host.response);
    expect(await host.work).toBeNull();
    expect(host.props.onClose).not.toHaveBeenCalled();
  });

  it("rejects a complete response whose image identity differs from the acknowledged selection", async () => {
    const host = await startRead();
    await host.emit({
      ...host.response,
      items: [{ ...host.response.items[0]!, assetId: `moss-canvas-asset:${"c".repeat(64)}.png` }],
    });
    expect(await host.work).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("尚未确认");
  });

  it("does not request context after a save failure", async () => {
    const host = await mount();
    await host.ready();
    await host.acknowledge(host.requests()[0]!);
    await host.emit(selection(1));
    const reader = vi
      .mocked(host.props.onComposeContextChange)
      .mock.calls.at(-1)![0] as MossCanvasComposeContextReader;
    let work!: ReturnType<MossCanvasComposeContextReader>;
    await act(async () => {
      work = reader();
    });
    await host.emit({
      type: "moss-canvas-flushed",
      requestId: host.requests("moss-canvas-flush")[0]!.requestId,
      ok: false,
    });
    expect(await work).toBeNull();
    expect(host.requests("moss-canvas-compose-context")).toHaveLength(0);
    expect(host.props.onClose).not.toHaveBeenCalled();
  });
});
