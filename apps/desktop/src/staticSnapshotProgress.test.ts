// FILE: staticSnapshotProgress.test.ts
// Purpose: Locks the first-launch progress surface: nothing on a reused snapshot, and
// a bounded number of updates that survive a page still loading.

import { describe, expect, it, vi } from "vitest";

import {
  buildStaticSnapshotProgressPageUrl,
  createStaticSnapshotProgressTracker,
  type StaticSnapshotProgressWindow,
} from "./staticSnapshotProgress";

function createFakeWindow() {
  let pageLoaded = () => {};
  const window = {
    onPageLoaded: vi.fn<StaticSnapshotProgressWindow["onPageLoaded"]>((listener) => {
      pageLoaded = listener;
    }),
    runPageScript: vi.fn<StaticSnapshotProgressWindow["runPageScript"]>(),
    setTaskbarProgress: vi.fn<StaticSnapshotProgressWindow["setTaskbarProgress"]>(),
    close: vi.fn<StaticSnapshotProgressWindow["close"]>(),
  };
  return { window, loadPage: () => pageLoaded() };
}

function createTracker() {
  const fake = createFakeWindow();
  const openWindow = vi.fn(() => fake.window);
  const tracker = createStaticSnapshotProgressTracker({
    openWindow,
    finishingHeading: () => "Starting Moss…",
  });
  return { ...fake, openWindow, tracker };
}

describe("createStaticSnapshotProgressTracker", () => {
  it("opens no window when nothing is ever copied", () => {
    const { openWindow, tracker } = createTracker();

    tracker.finish();
    tracker.close();

    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens one window on the first report, before any file is copied", () => {
    const { openWindow, tracker } = createTracker();

    tracker.report({ copiedFiles: 0, totalFiles: 5185 });
    tracker.report({ copiedFiles: 1, totalFiles: 5185 });

    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it("updates the page at most once per percent across thousands of files", () => {
    const { window, loadPage, tracker } = createTracker();
    tracker.report({ copiedFiles: 0, totalFiles: 5185 });
    loadPage();

    for (let copiedFiles = 1; copiedFiles <= 5185; copiedFiles += 1) {
      tracker.report({ copiedFiles, totalFiles: 5185 });
    }

    // 0% ran when the page loaded; the loop adds 1% through 100%.
    expect(window.runPageScript).toHaveBeenCalledTimes(101);
    expect(window.runPageScript).toHaveBeenLastCalledWith(expect.stringContaining("=100;"));
    expect(window.setTaskbarProgress).toHaveBeenLastCalledWith(1);
  });

  it("holds updates until the page has loaded, then shows only the newest", () => {
    const { window, loadPage, tracker } = createTracker();

    tracker.report({ copiedFiles: 0, totalFiles: 100 });
    tracker.report({ copiedFiles: 40, totalFiles: 100 });
    expect(window.runPageScript).not.toHaveBeenCalled();

    loadPage();

    expect(window.runPageScript).toHaveBeenCalledTimes(1);
    expect(window.runPageScript).toHaveBeenCalledWith(expect.stringContaining('"40%"'));
  });

  it("treats an empty source as complete", () => {
    const { window, tracker } = createTracker();

    tracker.report({ copiedFiles: 0, totalFiles: 0 });

    expect(window.setTaskbarProgress).toHaveBeenCalledWith(1);
  });

  it("switches to the starting state and clears the taskbar when the copy settles", () => {
    const { window, loadPage, tracker } = createTracker();
    tracker.report({ copiedFiles: 0, totalFiles: 10 });
    loadPage();

    tracker.finish();

    expect(window.setTaskbarProgress).toHaveBeenLastCalledWith(-1);
    expect(window.runPageScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"Starting Moss…"'),
    );
    expect(window.close).not.toHaveBeenCalled();
  });

  it("shows the starting state even when the copy settles before the page loads", () => {
    const { window, loadPage, tracker } = createTracker();
    tracker.report({ copiedFiles: 0, totalFiles: 10 });

    tracker.finish();
    loadPage();

    expect(window.runPageScript).toHaveBeenCalledTimes(1);
    expect(window.runPageScript).toHaveBeenCalledWith(expect.stringContaining('"Starting Moss…"'));
  });

  it("stays closed once closed", () => {
    const { window, loadPage, openWindow, tracker } = createTracker();
    tracker.report({ copiedFiles: 0, totalFiles: 10 });

    tracker.close();
    tracker.close();
    tracker.report({ copiedFiles: 5, totalFiles: 10 });
    tracker.finish();
    loadPage();

    expect(window.close).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(window.runPageScript).not.toHaveBeenCalled();
  });
});

describe("buildStaticSnapshotProgressPageUrl", () => {
  it("renders a script-free page whose elements match what the update scripts touch", () => {
    const url = buildStaticSnapshotProgressPageUrl({
      title: "Moss",
      heading: "正在准备这个版本的 Moss",
      detail: "第一次打开新版本时需要复制界面文件。",
      background: "#181818",
      color: "#f5f5f5",
      markHtml: '<img src="data:image/png;base64,AA" alt="Moss" />',
    });

    expect(url.startsWith("data:text/html;charset=UTF-8,")).toBe(true);
    const html = decodeURIComponent(url.slice("data:text/html;charset=UTF-8,".length));
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).toContain('<h1 id="heading">正在准备这个版本的 Moss</h1>');
    expect(html).toContain('<p id="detail">第一次打开新版本时需要复制界面文件。</p>');
    expect(html).toContain('<progress id="bar"');
    expect(html).toContain('<output id="percent">0%</output>');
    expect(html).toContain('<img src="data:image/png;base64,AA" alt="Moss" />');
  });
});
