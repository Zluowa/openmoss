import { describe, expect, it, vi } from "vitest";
import { openMossImagesOriginCanvas } from "./mossImagesCanvasNavigation";
import { useRailShellStore } from "../railShellStore";

function setup() {
  const order: string[] = [];
  let current = true;
  const input = {
    threadId: "original-thread",
    image: { jobId: "moss_owned", imageIndex: 0, action: "edit" as const },
    isCurrent: () => current,
    beforeLeave: vi.fn(async () => {
      order.push("leave");
      return true;
    }),
    flushCurrent: vi.fn(async () => {
      order.push("flush");
      return true;
    }),
    beginNavigation: vi.fn(() => {
      order.push("handoff");
    }),
    navigate: vi.fn(async (_threadId: string) => {
      order.push("navigate");
      return true;
    }),
    openChat: vi.fn((_threadId: string) => {
      order.push("chat");
    }),
    openCanvas: vi.fn((_threadId: string, _image: unknown) => {
      order.push("canvas");
    }),
    onOpened: vi.fn(() => {
      order.push("close-images");
    }),
  };
  return {
    input,
    order,
    invalidate: () => {
      current = false;
    },
  };
}

describe("historical image original conversation navigation", () => {
  it("saves the current surface before switching to the original chat and its Canvas", async () => {
    const value = setup();
    await openMossImagesOriginCanvas(value.input);
    expect(value.order).toEqual([
      "leave",
      "flush",
      "handoff",
      "navigate",
      "chat",
      "canvas",
      "close-images",
    ]);
    expect(value.input.navigate).toHaveBeenCalledWith("original-thread");
    expect(value.input.openCanvas).toHaveBeenCalledWith("original-thread", value.input.image);
  });
  it.each(["leave", "flush"] as const)("keeps the current page when %s refuses", async (stage) => {
    const value = setup();
    (stage === "leave" ? value.input.beforeLeave : value.input.flushCurrent).mockResolvedValue(
      false,
    );
    await openMossImagesOriginCanvas(value.input);
    expect(value.input.navigate).not.toHaveBeenCalled();
    expect(value.input.beginNavigation).not.toHaveBeenCalled();
    expect(value.input.openCanvas).not.toHaveBeenCalled();
    expect(value.input.onOpened).not.toHaveBeenCalled();
  });
  it.each(["leave", "flush", "navigate"] as const)(
    "rejects a changed account or selected image during %s",
    async (stage) => {
      const value = setup();
      if (stage === "navigate")
        value.input.navigate.mockImplementation(async () => {
          value.invalidate();
          return true;
        });
      else
        (stage === "leave" ? value.input.beforeLeave : value.input.flushCurrent).mockImplementation(
          async () => {
            value.invalidate();
            return true;
          },
        );
      await openMossImagesOriginCanvas(value.input);
      expect(value.input.openChat).not.toHaveBeenCalled();
      expect(value.input.openCanvas).not.toHaveBeenCalled();
      expect(value.input.onOpened).not.toHaveBeenCalled();
    },
  );
  it("does not close Images or open another Canvas when normal navigation fails", async () => {
    const value = setup();
    value.input.navigate.mockRejectedValue(new Error("navigation failed"));
    await expect(openMossImagesOriginCanvas(value.input)).rejects.toThrow("navigation failed");
    expect(value.input.openCanvas).not.toHaveBeenCalled();
    expect(value.input.onOpened).not.toHaveBeenCalled();
  });
  it("retains Images when another existing router guard cancels navigation", async () => {
    const value = setup();
    value.input.navigate.mockResolvedValue(false);
    await openMossImagesOriginCanvas(value.input);
    expect(value.input.openChat).not.toHaveBeenCalled();
    expect(value.input.openCanvas).not.toHaveBeenCalled();
    expect(value.input.onOpened).not.toHaveBeenCalled();
  });

  it.each(["home", "spaces", "images"] as const)(
    "does not resume a pending Canvas handoff after an explicit %s rail selection",
    async (item) => {
      useRailShellStore.setState({ activeItem: "images", selectionVersion: 0 });
      const value = setup();
      const selectionVersion = useRailShellStore.getState().selectionVersion;
      value.input.isCurrent = () =>
        useRailShellStore.getState().selectionVersion === selectionVersion;
      let finishNavigation!: (ok: boolean) => void;
      value.input.navigate.mockImplementation(
        async () =>
          new Promise<boolean>((resolve) => {
            finishNavigation = resolve;
          }),
      );
      const pending = openMossImagesOriginCanvas(value.input);
      await vi.waitFor(() => expect(finishNavigation).toBeTypeOf("function"));
      if (item === "images") useRailShellStore.getState().selectRouteItem(item);
      else useRailShellStore.getState().selectPanelItem(item);
      finishNavigation(true);
      await pending;
      expect(value.input.openChat).not.toHaveBeenCalled();
      expect(value.input.openCanvas).not.toHaveBeenCalled();
      expect(value.input.onOpened).not.toHaveBeenCalled();
    },
  );

  it("keeps a pending Canvas handoff valid when its route automatically reconciles the rail", async () => {
    useRailShellStore.setState({
      activeItem: "images",
      panelView: "home",
      selectionVersion: 0,
      reconciledRouteKey: "/current-thread",
    });
    const value = setup();
    const selectionVersion = useRailShellStore.getState().selectionVersion;
    value.input.isCurrent = () =>
      useRailShellStore.getState().selectionVersion === selectionVersion;
    value.input.navigate.mockImplementation(async () => {
      useRailShellStore.getState().reconcile({
        pathname: "/original-thread",
        onStudioSurface: false,
        projectIds: null,
      });
      return true;
    });
    await openMossImagesOriginCanvas(value.input);
    expect(useRailShellStore.getState().activeItem).toBe("home");
    expect(value.input.openCanvas).toHaveBeenCalledWith("original-thread", value.input.image);
    expect(value.input.onOpened).toHaveBeenCalledOnce();
  });
});
