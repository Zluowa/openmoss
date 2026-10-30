import "../../index.css";

import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpAppNavigationControls } from "./McpAppNavigationControls";

describe("MCP App navigation controls", () => {
  it("renders exact labels, independent disabled state, and stops disclosure propagation", async () => {
    await page.viewport(640, 400);
    const host = document.createElement("div");
    document.body.append(host);
    let parentEvents = 0;
    const navigations: number[] = [];
    const mounted = await render(
      <div onClick={() => (parentEvents += 1)} onPointerDown={() => (parentEvents += 1)}>
        <McpAppNavigationControls
          canGoBack
          canGoForward={false}
          onNavigate={(delta) => navigations.push(delta)}
        />
      </div>,
      { container: host },
    );
    try {
      const group = document.querySelector<HTMLElement>(
        '[data-mcp-app-navigation-controls="true"]',
      );
      if (!group) throw new Error("navigation group is missing");
      expect(group.className).toContain("flex");
      expect(group.className).toContain("gap-px");
      expect(group.className).toContain("pointer-events-auto");
      const back = document.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
      const next = document.querySelector<HTMLButtonElement>('button[aria-label="Next"]');
      if (!back || !next) throw new Error("navigation buttons are missing");
      expect(back.title).toBe("Back");
      expect(next.title).toBe("Next");
      expect(back.disabled).toBe(false);
      expect(next.disabled).toBe(true);
      expect(back.getBoundingClientRect().width).toBe(28);
      expect(back.getBoundingClientRect().height).toBe(28);
      expect(next.querySelector('[data-slot="central-icon"]')?.getAttribute("class")).toContain(
        "-scale-x-100",
      );
      await userEvent.click(back);
      back.focus();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(navigations).toEqual([-1, -1, -1]);
      // Disabled controls are not focusable. Blur the enabled control first so
      // a subsequent keyboard event cannot accidentally activate it again.
      back.blur();
      next.focus();
      expect(document.activeElement).not.toBe(next);
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      next.click();
      expect(navigations).toEqual([-1, -1, -1]);
      expect(parentEvents).toBe(0);
      group.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      expect(parentEvents).toBe(0);
    } finally {
      await mounted.unmount();
      host.remove();
    }
  });

  it("does not render an empty group without history", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const mounted = await render(
      <McpAppNavigationControls canGoBack={false} canGoForward={false} onNavigate={() => {}} />,
      { container: host },
    );
    try {
      expect(host.querySelector('[data-mcp-app-navigation-controls="true"]')).toBeNull();
    } finally {
      await mounted.unmount();
      host.remove();
    }
  });
});
