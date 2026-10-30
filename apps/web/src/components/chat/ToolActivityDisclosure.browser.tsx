import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ToolActivityDisclosure } from "./ToolActivityDisclosure";

const motionCommands = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};

function fixture(status: string, onExpand: () => void, defaultExpanded = false, height = 40) {
  return (
    <ToolActivityDisclosure
      label="Read repository files"
      leadingIcon={<span />}
      fontSizePx={16}
      status={status}
      defaultExpanded={defaultExpanded}
      onExpand={onExpand}
      renderChildren={() => (
        <input aria-label="Tool input" defaultValue="retained" style={{ height }} />
      )}
    />
  );
}

function trigger() {
  return document.querySelector<HTMLButtonElement>("[data-tool-group-trigger]")!;
}

function body() {
  return document.querySelector<HTMLElement>("[data-tool-group-body]")!;
}

describe("ToolActivityDisclosure decompiled behavior", () => {
  afterEach(async () => {
    await motionCommands.emulateReducedMotion("no-preference");
  });

  it("keeps running collapse and settled expansion independent across status changes", async () => {
    await motionCommands.emulateReducedMotion("reduce");
    const onExpand = vi.fn();
    const screen = await render(fixture("running", onExpand));
    try {
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-tool-group-summary]")?.className).toContain("shimmer");
      trigger().click();
      await expect.poll(() => trigger().getAttribute("aria-expanded")).toBe("false");
      expect(onExpand).not.toHaveBeenCalled();
      await screen.rerender(fixture("completed", onExpand));
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      trigger().click();
      await expect.poll(() => trigger().getAttribute("aria-expanded")).toBe("true");
      expect(onExpand).toHaveBeenCalledTimes(1);
      await screen.rerender(fixture("running", onExpand));
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      trigger().click();
      await expect.poll(() => trigger().getAttribute("aria-expanded")).toBe("true");
      expect(onExpand).toHaveBeenCalledTimes(2);
      await screen.rerender(fixture("completed", onExpand));
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
    } finally {
      await screen.unmount();
    }
  });

  it("collapses an untouched running disclosure on settlement and honors defaultExpanded", async () => {
    const onExpand = vi.fn();
    const screen = await render(fixture("running", onExpand));
    try {
      await screen.rerender(fixture("completed", onExpand));
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(onExpand).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
    const expanded = await render(fixture("completed", onExpand, true));
    try {
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(onExpand).not.toHaveBeenCalled();
    } finally {
      await expanded.unmount();
    }
  });

  it("measures changing content while closed, retains its state, and reverses motion without cleanup races", async () => {
    const onExpand = vi.fn();
    const screen = await render(fixture("completed", onExpand, true));
    try {
      const content = document.querySelector<HTMLElement>("[data-tool-group-content]")!;
      const input = document.querySelector<HTMLInputElement>("input[aria-label='Tool input']")!;
      await userEvent.fill(input, "edited");
      trigger().click();
      await expect.poll(() => body().hasAttribute("inert")).toBe(true);
      await screen.rerender(fixture("completed", onExpand, true, 120));
      await expect.poll(() => body().getBoundingClientRect().height).toBe(0);
      await expect.poll(() => getComputedStyle(body()).opacity).toBe("0");
      trigger().click();
      await expect.poll(() => body().hasAttribute("inert")).toBe(false);
      trigger().click();
      await expect.poll(() => body().hasAttribute("inert")).toBe(true);
      trigger().click();
      await expect
        .poll(() => body().getBoundingClientRect().height)
        .toBeCloseTo(content.getBoundingClientRect().height, 0);
      expect(content.getBoundingClientRect().height).toBe(132);
      expect(document.querySelector("input[aria-label='Tool input']")).toBe(input);
      expect(input.value).toBe("edited");
      expect(getComputedStyle(body()).overflow).toBe("visible");
      expect(body().getAttribute("aria-hidden")).toBe("false");
    } finally {
      await screen.unmount();
    }
  });

  it("renders a noninteractive header without content and allows unindented content", async () => {
    const screen = await render(
      <ToolActivityDisclosure label="Finished" leadingIcon={null} fontSizePx={16} />,
    );
    try {
      expect(document.querySelector("button")).toBeNull();
      expect(body()).toBeNull();
      await screen.rerender(
        <ToolActivityDisclosure
          label="Finished"
          leadingIcon={null}
          fontSizePx={16}
          indentContent={false}
          renderChildren={() => <span>Details</span>}
        />,
      );
      const content = document.querySelector<HTMLElement>("[data-tool-group-content]")!;
      expect(getComputedStyle(content).paddingInlineStart).toBe("0px");
    } finally {
      await screen.unmount();
    }
  });
});
