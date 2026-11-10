// FILE: staticSnapshotProgress.ts
// Purpose: Tells the user what the first launch of a new version is doing while the
// static snapshot is copied, which is many minutes on a slow disk.
// Layer: Desktop startup utility
// Exports: buildStaticSnapshotProgressPageUrl, createStaticSnapshotProgressTracker
//
// This surface is a window of its own because it has to appear before bootstrap. The
// main window's preload makes synchronous IPC calls at load, and their handlers only
// exist once bootstrap has registered them.

import type { StaticSnapshotProgress } from "@moss/shared/staticSnapshot";

export interface StaticSnapshotProgressPageInput {
  readonly title: string;
  readonly heading: string;
  readonly detail: string;
  readonly background: string;
  readonly color: string;
  readonly markHtml: string;
}

export function buildStaticSnapshotProgressPageUrl(input: StaticSnapshotProgressPageInput): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
    <meta name="color-scheme" content="light dark" />
    <title>${input.title}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      body { display: grid; place-items: center; box-sizing: border-box; padding: 0 28px; background: ${input.background}; color: ${input.color}; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", sans-serif; user-select: none; }
      main { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; text-align: center; }
      img { display: block; border-radius: 10px; }
      h1 { margin: 0; font-size: 15px; font-weight: 600; }
      p { margin: 0; opacity: 0.7; }
      progress { width: 100%; height: 6px; accent-color: ${input.color}; }
      output { font-variant-numeric: tabular-nums; opacity: 0.7; }
    </style>
  </head>
  <body>
    <main>
      ${input.markHtml}
      <h1 id="heading">${input.heading}</h1>
      <p id="detail">${input.detail}</p>
      <progress id="bar" max="100" value="0" aria-labelledby="heading"></progress>
      <output id="percent">0%</output>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function buildPercentScript(percent: number): string {
  return `document.getElementById("bar").value=${percent};document.getElementById("percent").textContent="${percent}%";`;
}

function buildFinishingScript(heading: string): string {
  // A progress element without a value is indeterminate: the copy is done, and how
  // long the rest of startup takes isn't known.
  return `document.getElementById("heading").textContent=${JSON.stringify(heading)};document.getElementById("detail").remove();document.getElementById("percent").remove();document.getElementById("bar").removeAttribute("value");`;
}

export interface StaticSnapshotProgressWindow {
  readonly onPageLoaded: (listener: () => void) => void;
  readonly runPageScript: (script: string) => void;
  /** A fraction from 0 to 1, or a negative number to clear the taskbar indicator. */
  readonly setTaskbarProgress: (fraction: number) => void;
  readonly close: () => void;
}

export interface StaticSnapshotProgressTracker {
  /** Opens the window on the first call, so a reused snapshot never shows one. */
  readonly report: (progress: StaticSnapshotProgress) => void;
  /** The copy has settled; the window stays up until the main window replaces it. */
  readonly finish: () => void;
  readonly close: () => void;
}

export function createStaticSnapshotProgressTracker(options: {
  readonly openWindow: () => StaticSnapshotProgressWindow;
  readonly finishingHeading: () => string;
}): StaticSnapshotProgressTracker {
  let window: StaticSnapshotProgressWindow | null = null;
  let isClosed = false;
  let isPageLoaded = false;
  let pendingScript: string | null = null;
  let shownPercent = -1;

  const runScript = (target: StaticSnapshotProgressWindow, script: string): void => {
    if (isPageLoaded) {
      target.runPageScript(script);
    } else {
      // Only the newest state matters, and each script sets it completely.
      pendingScript = script;
    }
  };

  return {
    report: ({ copiedFiles, totalFiles }) => {
      if (isClosed) return;
      if (window === null) {
        const opened = options.openWindow();
        window = opened;
        opened.onPageLoaded(() => {
          isPageLoaded = true;
          if (pendingScript !== null && !isClosed) opened.runPageScript(pendingScript);
          pendingScript = null;
        });
      }
      const percent = totalFiles === 0 ? 100 : Math.floor((copiedFiles / totalFiles) * 100);
      // Thousands of files, but the page only ever needs a hundred updates.
      if (percent === shownPercent) return;
      shownPercent = percent;
      window.setTaskbarProgress(percent / 100);
      runScript(window, buildPercentScript(percent));
    },
    finish: () => {
      if (window === null || isClosed) return;
      window.setTaskbarProgress(-1);
      runScript(window, buildFinishingScript(options.finishingHeading()));
    },
    close: () => {
      isClosed = true;
      window?.close();
      window = null;
    },
  };
}
