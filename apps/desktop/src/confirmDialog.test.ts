import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { showMessageBoxMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
}));

import { showDesktopConfirmDialog } from "./confirmDialog";

describe("showDesktopConfirmDialog", () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset();
  });

  it("returns false and does not open a dialog for empty messages", async () => {
    const result = await showDesktopConfirmDialog("   ", null);

    expect(result).toBe(false);
    expect(showMessageBoxMock).not.toHaveBeenCalled();
  });

  it("opens a dialog for the focused window and returns true on confirm", async () => {
    const ownerWindow = { id: 1 } as BrowserWindow;
    showMessageBoxMock.mockResolvedValue({ response: 1 });

    const result = await showDesktopConfirmDialog("Delete worktree?", ownerWindow);

    expect(result).toBe(true);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      ownerWindow,
      expect.objectContaining({
        buttons: ["No", "Yes"],
        message: "Delete worktree?",
      }),
    );
  });

  it("opens an app-level dialog when there is no focused window", async () => {
    showMessageBoxMock.mockResolvedValue({ response: 0 });

    const result = await showDesktopConfirmDialog("Delete worktree?", null);

    expect(result).toBe(false);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["No", "Yes"],
        message: "Delete worktree?",
      }),
    );
  });

  it("localizes native confirmation buttons for Chinese UI", async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 });

    const result = await showDesktopConfirmDialog("删除这个工作树？", null, "zh-CN");

    expect(result).toBe(true);
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ["否", "是"],
        message: "删除这个工作树？",
      }),
    );
  });
});
