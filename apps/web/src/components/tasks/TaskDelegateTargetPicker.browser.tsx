import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { toastManager } from "~/components/ui/toast";

const pickFolder = vi.hoisted(() => vi.fn<() => Promise<string | null>>());

vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  readNativeApi: () => ({ dialogs: { pickFolder } }),
}));

// The project menu is not under test here.
vi.mock("~/components/ProjectMenuPicker", () => ({
  ProjectMenuPicker: () => null,
}));

import { TaskDelegateTargetPicker } from "./TaskDelegateTargetPicker";
import type { TaskDelegateTargetState } from "./useTaskDelegateTarget";

function runIn(setTarget = vi.fn()): TaskDelegateTargetState {
  return {
    target: null,
    setTarget,
    projectOptions: [],
    targetProject: null,
  } as unknown as TaskDelegateTargetState;
}

describe("TaskDelegateTargetPicker folder picker", () => {
  afterEach(async () => {
    pickFolder.mockReset();
    vi.restoreAllMocks();
    await cleanup();
  });

  it("explains in the reader's language when the folder picker cannot open", async () => {
    const add = vi.spyOn(toastManager, "add");
    pickFolder.mockRejectedValue(new Error("bridge unavailable"));
    const state = runIn();
    await render(
      <MossLocaleScope locale="zh-CN">
        <TaskDelegateTargetPicker runIn={state} />
      </MossLocaleScope>,
    );

    await page.getByRole("button", { name: "Folder…" }).click();
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "无法打开文件夹选择器。" }),
      ),
    );
    expect(state.setTarget).not.toHaveBeenCalled();
  });

  it("uses the picked folder", async () => {
    pickFolder.mockResolvedValue("/Users/test/moss-app");
    const state = runIn();
    await render(<TaskDelegateTargetPicker runIn={state} />);

    await page.getByRole("button", { name: "Folder…" }).click();
    await vi.waitFor(() =>
      expect(state.setTarget).toHaveBeenCalledWith({
        kind: "folder",
        path: "/Users/test/moss-app",
      }),
    );
  });
});
