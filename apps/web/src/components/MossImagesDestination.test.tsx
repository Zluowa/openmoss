// @vitest-environment happy-dom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MossImagesDestination } from "./MossImagesDestination";
import { MossImagesError } from "~/lib/mossImagesClient";
import { openMossImagesOriginCanvas } from "~/lib/mossImagesCanvasNavigation";
const bridge = vi.hoisted(() => ({ open: vi.fn() }));
const origin = vi.hoisted(() => ({
  load: vi.fn(),
  selectionCurrent: true,
  accountKey: "account-a",
}));
vi.mock("~/lib/mossImagesClient", async (original) => ({
  ...(await original<typeof import("~/lib/mossImagesClient")>()),
  loadMossImagesCanvasOrigin: origin.load,
}));
vi.mock("~/lib/mossImagesAccountBoundary", () => ({
  useMossImagesAccountBoundary: () => {
    const key = origin.accountKey;
    return { key, transitioning: false, isCurrent: () => key === origin.accountKey };
  },
}));
vi.mock("~/lib/mossCanvasBridge", () => ({ openMossCanvas: bridge.open }));
vi.mock("./MossImagesWorkspace", () => ({
  MossImagesWorkspace: ({
    onEditInCanvas,
  }: {
    onEditInCanvas: (
      focus: { jobId: string; imageIndex: number },
      isCurrent?: () => boolean,
    ) => void;
  }) => (
    <div>
      普通图片页
      <button
        onClick={() =>
          onEditInCanvas({ jobId: "moss_owned", imageIndex: 0 }, () => origin.selectionCurrent)
        }
      >
        编辑已有图像
      </button>
      <button onClick={() => onEditInCanvas({ jobId: "moss_other", imageIndex: 0 })}>
        编辑另一张
      </button>
    </div>
  ),
}));
vi.mock("./MossCanvasWebSurface", () => ({
  MossCanvasWebSurface: ({
    onClose,
    image,
  }: {
    onClose: () => void;
    image?: { jobId: string };
  }) => (
    <div data-testid="full-canvas">
      {image?.jobId}
      <button onClick={onClose}>返回图像</button>
    </div>
  ),
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  origin.load
    .mockReset()
    .mockResolvedValue({ account: { id: "owner", realm: "memfire-phone" }, threadId: null });
  origin.selectionCurrent = true;
  origin.accountKey = "account-a";
});
const props = {
  threadId: "thread-a",
  prepareThread: async () => "thread-a",
  onClose: vi.fn(),
  onLeaveGuardChange: vi.fn(),
};
describe("ordinary Images and explicit Canvas activation", () => {
  it("hands image editing to the same conversation Canvas tab when the chat host is present", async () => {
    render(<MossImagesDestination {...props} openCanvasInConversation />);
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() =>
      expect(bridge.open).toHaveBeenCalledWith({
        surface: "canvas",
        threadId: "thread-a",
        image: { jobId: "moss_owned", imageIndex: 0 },
      }),
    );
    expect(screen.queryByTestId("full-canvas")).toBeNull();
  });
  it("starts without Canvas, opens it only for image editing and preserves Images on return", async () => {
    const view = render(<MossImagesDestination {...props} />);
    expect(screen.queryByTestId("full-canvas")).toBeNull();
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() =>
      expect(screen.getByTestId("full-canvas").textContent).toContain("moss_owned"),
    );
    fireEvent.click(screen.getByText("返回图像"));
    expect(screen.queryByTestId("full-canvas")).toBeNull();
    expect(screen.getByText("普通图片页")).not.toBeNull();
    view.unmount();
  });
  it("reopens the bound original without promoting an unrelated active draft", async () => {
    origin.load.mockResolvedValue({
      account: { id: "owner", realm: "memfire-phone" },
      threadId: "original-thread",
    });
    const prepareThread = vi.fn(async () => "unrelated-draft");
    const openOriginal = vi.fn(async () => undefined);
    render(
      <MossImagesDestination
        {...props}
        threadId={null}
        contextThreadId="unrelated-draft"
        prepareThread={prepareThread}
        openCanvasInConversation
        onOpenOriginCanvas={openOriginal}
      />,
    );
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() =>
      expect(openOriginal).toHaveBeenCalledWith(
        "original-thread",
        { jobId: "moss_owned", imageIndex: 0 },
        expect.any(Function),
        expect.any(Function),
      ),
    );
    expect(prepareThread).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("full-canvas")).toBeNull();
  });
  it("retains the page when a bound original is invalid instead of importing into the active draft", async () => {
    origin.load.mockRejectedValue(
      new MossImagesError("unavailable", "canvas_origin_unavailable", 409),
    );
    const prepareThread = vi.fn(async () => "unrelated-draft");
    const openOriginal = vi.fn(async () => undefined);
    render(
      <MossImagesDestination
        {...props}
        threadId={null}
        prepareThread={prepareThread}
        openCanvasInConversation
        onOpenOriginCanvas={openOriginal}
      />,
    );
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("原会话"));
    expect(prepareThread).not.toHaveBeenCalled();
    expect(openOriginal).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(screen.getByText("普通图片页")).toBeTruthy();
  });
  it.each(["account", "selection", "route", "unmount"] as const)(
    "rejects late origin metadata after %s changes",
    async (change) => {
      let finish!: (value: { threadId: string }) => void;
      origin.load.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const prepareThread = vi.fn(async () => "unrelated-draft");
      const openOriginal = vi.fn(async () => undefined);
      const view = render(
        <MossImagesDestination
          {...props}
          contextThreadId="unrelated-draft"
          prepareThread={prepareThread}
          openCanvasInConversation
          onOpenOriginCanvas={openOriginal}
        />,
      );
      fireEvent.click(screen.getByText("编辑已有图像"));
      await waitFor(() => expect(origin.load).toHaveBeenCalledTimes(1));
      if (change === "account") {
        origin.accountKey = "account-b";
        view.rerender(
          <MossImagesDestination
            {...props}
            contextThreadId="unrelated-draft"
            prepareThread={prepareThread}
            openCanvasInConversation
            onOpenOriginCanvas={openOriginal}
          />,
        );
      } else if (change === "selection") origin.selectionCurrent = false;
      else if (change === "route")
        view.rerender(
          <MossImagesDestination
            {...props}
            contextThreadId="another-draft"
            prepareThread={prepareThread}
            openCanvasInConversation
            onOpenOriginCanvas={openOriginal}
          />,
        );
      else view.unmount();
      finish({ threadId: "original-thread" });
      await waitFor(() => expect(origin.load.mock.settledResults[0]?.type).toBe("fulfilled"));
      expect(openOriginal).not.toHaveBeenCalled();
      expect(prepareThread).not.toHaveBeenCalled();
      expect(bridge.open).not.toHaveBeenCalled();
    },
  );
  it("keeps only the newest image edit request", async () => {
    let finishFirst!: (value: { threadId: string }) => void;
    origin.load
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ threadId: "second-original" });
    const openOriginal = vi.fn(async (_threadId: string) => undefined);
    render(
      <MossImagesDestination
        {...props}
        openCanvasInConversation
        onOpenOriginCanvas={openOriginal}
      />,
    );
    fireEvent.click(screen.getByText("编辑已有图像"));
    fireEvent.click(screen.getByText("编辑另一张"));
    await waitFor(() => expect(openOriginal).toHaveBeenCalledTimes(1));
    finishFirst({ threadId: "first-original" });
    await waitFor(() => expect(origin.load.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(openOriginal.mock.calls[0]?.[0]).toBe("second-original");
    expect(bridge.open).not.toHaveBeenCalled();
  });
  it("does not resume an original-thread navigation after Images closes during its leave check", async () => {
    origin.load.mockResolvedValue({ threadId: "original-thread" });
    let finishLeave!: (ok: boolean) => void;
    const navigate = vi.fn(async () => true);
    const openCanvas = vi.fn();
    const onOpened = vi.fn();
    const openOriginal = vi.fn(
      (threadId: string, image: { jobId: string; imageIndex: number }, isCurrent: () => boolean) =>
        openMossImagesOriginCanvas({
          threadId,
          image,
          isCurrent,
          beforeLeave: () =>
            new Promise((resolve) => {
              finishLeave = resolve;
            }),
          flushCurrent: async () => true,
          navigate,
          openChat: vi.fn(),
          openCanvas,
          onOpened,
        }),
    );
    const view = render(
      <MossImagesDestination
        {...props}
        openCanvasInConversation
        onOpenOriginCanvas={openOriginal}
      />,
    );
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() => expect(finishLeave).toBeTypeOf("function"));
    view.unmount();
    finishLeave(true);
    await waitFor(() => expect(openOriginal.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(navigate).not.toHaveBeenCalled();
    expect(openCanvas).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });
  it("allows the route's expected unmount only after leave checks authorize navigation", async () => {
    origin.load.mockResolvedValue({ threadId: "original-thread" });
    const openCanvas = vi.fn();
    const openOriginal = vi.fn(
      (
        threadId: string,
        image: { jobId: string; imageIndex: number },
        isCurrent: () => boolean,
        beginNavigation: () => void,
      ) =>
        openMossImagesOriginCanvas({
          threadId,
          image,
          isCurrent,
          beginNavigation,
          beforeLeave: async () => true,
          flushCurrent: async () => true,
          navigate: async () => {
            view.unmount();
            return true;
          },
          openChat: vi.fn(),
          openCanvas,
          onOpened: vi.fn(),
        }),
    );
    const view = render(
      <MossImagesDestination
        {...props}
        openCanvasInConversation
        onOpenOriginCanvas={openOriginal}
      />,
    );
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() =>
      expect(openCanvas).toHaveBeenCalledWith("original-thread", {
        jobId: "moss_owned",
        imageIndex: 0,
      }),
    );
  });
  it("keeps the existing selected-folder promotion only for an explicitly unbound legacy image", async () => {
    const prepareThread = vi.fn(async () => "selected-folder-thread");
    const openOriginal = vi.fn(async () => undefined);
    render(
      <MossImagesDestination
        {...props}
        threadId={null}
        contextThreadId="unrelated-draft"
        prepareThread={prepareThread}
        openCanvasInConversation
        onOpenOriginCanvas={openOriginal}
      />,
    );
    fireEvent.click(screen.getByText("编辑已有图像"));
    await waitFor(() =>
      expect(bridge.open).toHaveBeenCalledWith({
        surface: "canvas",
        threadId: "selected-folder-thread",
        image: { jobId: "moss_owned", imageIndex: 0 },
      }),
    );
    expect(prepareThread).toHaveBeenCalledTimes(1);
    expect(openOriginal).not.toHaveBeenCalled();
  });
  it("ignores another conversation's MCP request and consumes the matching request once", () => {
    const view = render(
      <MossImagesDestination {...props} canvasRequest={{ id: "request-1", threadId: "other" }} />,
    );
    expect(screen.queryByTestId("full-canvas")).toBeNull();
    view.rerender(
      <MossImagesDestination
        {...props}
        canvasRequest={{ id: "request-2", threadId: "thread-a" }}
      />,
    );
    expect(screen.getByTestId("full-canvas")).not.toBeNull();
    fireEvent.click(screen.getByText("返回图像"));
    view.rerender(
      <MossImagesDestination
        {...props}
        canvasRequest={{ id: "request-2", threadId: "thread-a" }}
      />,
    );
    expect(screen.queryByTestId("full-canvas")).toBeNull();
  });
});
