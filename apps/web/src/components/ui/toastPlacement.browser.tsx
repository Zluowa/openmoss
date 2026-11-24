// FILE: toastPlacement.browser.tsx
// Purpose: A toast never covers what it is about or what the person needs next (WALK-3 N3-5):
//          with a toast showing on 资料空间 home, on a chat with the dock open and on Settings,
//          the page heading, the composer and the dock's tabs stay uncovered, at the owner's
//          window size and at the narrowest Moss window.
// Layer: Browser UI test (real ToastProvider and stylesheet; the page is a stand-in drawn at the
//        app shell's own measurements).

import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@moss/shared/desktopChrome";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { flushSync } from "react-dom";

import "../../index.css";

vi.mock("@tanstack/react-router", () => ({ useParams: () => undefined }));
vi.mock("../../hooks/useDiffRouteSearch", () => ({ useDiffRouteSearch: () => ({}) }));

import { ToastProvider, toastManager } from "./toast";

const SIDEBAR_WIDTH = 260;
const DOCK_WIDTH = 420;

type Screen = "space" | "chat" | "settings";

/** The parts a person must still see, drawn where the shell draws them. */
function Page({ screen }: { screen: Screen }) {
  const top = CHAT_SURFACE_HEADER_HEIGHT_PX;
  if (screen === "settings") {
    // Settings dialog: inset card; title row; page heading at the shared column's start.
    return (
      <div style={{ position: "fixed", inset: "44px 40px 40px 40px" }}>
        <h1 data-guard="heading" style={{ position: "absolute", left: 32 + 260, top: 72 }}>
          通用
        </h1>
      </div>
    );
  }
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      {/* Top bar; with the dock open its tabs sit at the right end of it. */}
      {screen === "chat" ? (
        <div
          data-guard="dock-tabs"
          style={{ position: "absolute", top: 0, right: 140, width: DOCK_WIDTH - 140, height: top }}
        >
          文件 终端
        </div>
      ) : null}
      {screen === "space" ? (
        <h1
          data-guard="heading"
          style={{ position: "absolute", left: SIDEBAR_WIDTH + 32, top: top + 28 }}
        >
          资料空间
        </h1>
      ) : (
        <div
          data-guard="composer"
          style={{
            position: "absolute",
            bottom: 24,
            left: SIDEBAR_WIDTH + 24,
            right: DOCK_WIDTH + 24,
            height: 120,
          }}
        >
          在 Moss 里做任何事
        </div>
      )}
    </div>
  );
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

afterEach(() => {
  document.body.innerHTML = "";
});

it.each([
  [1101, 782],
  [854, 760],
] as const)("keeps headings, the composer and the dock tabs clear at %sx%s", async (w, h) => {
  await page.viewport(w, h);
  for (const screen of ["space", "chat", "settings"] as const) {
    const view = await render(
      <ToastProvider position="top-right">
        <Page screen={screen} />
      </ToastProvider>,
    );
    let toastId = "";
    flushSync(() => {
      toastId = toastManager.add({
        title: "已移到回收站",
        description: "可以在回收站里恢复。",
        timeout: 0,
      });
    });
    const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]')!;
    const popup = viewport.querySelector<HTMLElement>("[data-position]")!;
    const box = popup.getBoundingClientRect();
    // Resting place (the entry slide is a transform; offsetTop is the layout position).
    const resting = new DOMRect(
      box.left,
      viewport.getBoundingClientRect().top + popup.offsetTop,
      box.width,
      box.height,
    );
    expect(resting.height, screen).toBeGreaterThan(0);
    for (const guard of document.querySelectorAll<HTMLElement>("[data-guard]")) {
      expect(
        overlaps(resting, guard.getBoundingClientRect()),
        `${screen} ${w}px: toast covers ${guard.dataset.guard}`,
      ).toBe(false);
    }
    // Below the top bar, so the dock tabs and window controls in it stay usable.
    expect(resting.top, screen).toBeGreaterThanOrEqual(CHAT_SURFACE_HEADER_HEIGHT_PX);
    flushSync(() => toastManager.close(toastId));
    await view.unmount();
  }
});
