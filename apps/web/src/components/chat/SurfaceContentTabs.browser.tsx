import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SurfaceContentTabs } from "./SurfaceContentTabs";

const TITLES = [
  "Cambiar resolución de pantalla",
  "Ocultar chats archivados",
  "Revisar la cola de tareas",
  "Arreglar el menú de pestañas",
  "Medir el uso de contexto",
  "Mover la vista previa flotante",
];

function mountStrip(widthPx: number, onSelect: (key: string) => void) {
  return render(
    <div style={{ width: `${widthPx}px`, display: "flex" }}>
      <SurfaceContentTabs
        ariaLabel="Open threads"
        activeKey="tab-0"
        tabs={TITLES.map((title, index) => ({
          key: `tab-${index}`,
          title,
          icon: <span aria-hidden className="size-4" />,
          onSelect: () => onSelect(`tab-${index}`),
        }))}
      />
    </div>,
  );
}

describe("SurfaceContentTabs overflow", () => {
  // The strips are wider than the default 414px viewport, and the app root clips horizontal
  // overflow, so a control past the right edge cannot be scrolled into view and a click misses it.
  beforeEach(async () => {
    await page.viewport(1280, 900);
  });

  it("keeps titles readable and lists tabs that do not fit in an overflow menu", async () => {
    const onSelect = vi.fn();
    const screen = await mountStrip(360, onSelect);
    try {
      const overflow = page.getByRole("button", { name: /more tabs?$/ });
      await expect.element(overflow).toBeVisible();
      // Each tab keeps its floor width instead of shrinking to a few letters.
      const tabWidths = Array.from(
        document.querySelectorAll<HTMLElement>("[data-surface-tab]"),
        (tab) => tab.getBoundingClientRect().width,
      );
      const fontSizePx = Number.parseFloat(
        getComputedStyle(document.querySelector<HTMLElement>("[data-surface-tab]")!).fontSize,
      );
      expect(Math.min(...tabWidths)).toBeGreaterThanOrEqual(fontSizePx * 6 - 1);

      await overflow.click();
      const lastTitle = TITLES.at(-1)!;
      await page.getByRole("menuitem", { name: lastTitle }).click();
      expect(onSelect).toHaveBeenCalledWith(`tab-${TITLES.length - 1}`);
    } finally {
      await screen.unmount();
    }
  });

  it("fits two chat tabs whole in a narrow title bar, titles cut at the end (walk D-11)", async () => {
    // The title bar beside the dock left about 200px for the tabs (1101px window, 2026-11-24).
    const screen = await render(
      <div style={{ width: "200px", display: "flex" }}>
        <SurfaceContentTabs
          ariaLabel="Open threads"
          activeKey="tab-1"
          tabs={["把这张图放到画布上，帮我加一个标题", "新建对话"].map((title, index) => ({
            key: `tab-${index}`,
            title,
            icon: <span aria-hidden className="size-4" />,
            onSelect: () => {},
            onClose: () => {},
          }))}
        />
      </div>,
    );
    try {
      await expect.element(page.getByRole("navigation", { name: "Open threads" })).toBeVisible();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const nav = page.getByRole("navigation", { name: "Open threads" }).element();
      const navRect = nav.getBoundingClientRect();
      const tabs = Array.from(nav.querySelectorAll<HTMLElement>("[data-surface-tab]"));
      expect(tabs).toHaveLength(2);
      // Both tabs whole inside the strip: nothing scrolled off at either side.
      for (const tab of tabs) {
        const rect = tab.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(navRect.left - 0.5);
        expect(rect.right).toBeLessThanOrEqual(navRect.right + 0.5);
      }
      expect(page.getByRole("button", { name: /more tabs?$/ }).elements()).toHaveLength(0);
      // The long title starts at its first character and ends in an ellipsis.
      const title = page.getByText("把这张图放到画布上，帮我加一个标题", { exact: true }).element();
      const style = getComputedStyle(title);
      expect(style.textOverflow).toBe("ellipsis");
      expect(style.maskImage === "none" || style.maskImage === "").toBe(true);
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
      expect(title.scrollLeft).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("shows no overflow menu while every tab fits", async () => {
    const screen = await mountStrip(4000, () => {});
    try {
      await expect.element(page.getByRole("navigation", { name: "Open threads" })).toBeVisible();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(page.getByRole("button", { name: /more tabs?$/ }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("renders a trailing control inside the strip, after the last tab", async () => {
    const onTrailingClick = vi.fn();
    const screen = await render(
      <div style={{ width: "4000px", display: "flex" }}>
        <SurfaceContentTabs
          ariaLabel="Open threads"
          activeKey="tab-0"
          tabs={TITLES.slice(0, 2).map((title, index) => ({
            key: `tab-${index}`,
            title,
            icon: <span aria-hidden className="size-4" />,
            onSelect: () => {},
          }))}
          trailing={
            <button
              type="button"
              aria-label="New thread in this workspace"
              onClick={onTrailingClick}
            >
              +
            </button>
          }
        />
      </div>,
    );
    try {
      const strip = document.querySelector<HTMLElement>(".surface-content-tabs")!;
      const trailing = strip.querySelector<HTMLElement>(
        '[aria-label="New thread in this workspace"]',
      );
      expect(trailing).not.toBeNull();
      const lastTab = Array.from(strip.querySelectorAll<HTMLElement>("[data-surface-tab]")).at(-1)!;
      expect(
        Boolean(lastTab.compareDocumentPosition(trailing!) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
      await page.getByRole("button", { name: "New thread in this workspace" }).click();
      expect(onTrailingClick).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
