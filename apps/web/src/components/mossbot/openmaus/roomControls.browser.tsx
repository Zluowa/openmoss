// FILE: roomControls.browser.tsx
// Purpose: Mossbot room controls on the shared parts (WO-24 §2): 「Jump to latest」 and the send
//          button are the shared IconButton, named by the Moss tooltip (no native title), and
//          「Load earlier messages」 is the shared ghost Button at 13 px and normal weight.
// Layer: Web appearance tests (real Chromium, real Moss CSS).

import "../../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossbotLoadEarlierButton } from "../MossbotRooms";
import { ComposerSendButton } from "./ComposerSendButton";
import { JumpToLatestButton } from "./JumpToLatestButton";

afterEach(async () => {
  await cleanup();
});

async function tooltipOnHover(target: HTMLElement): Promise<void> {
  await userEvent.hover(page.elementLocator(target));
  await expect
    .poll(() => document.querySelector("[data-slot='tooltip-popup']")?.textContent ?? "")
    .toBe(target.getAttribute("aria-label"));
}

it("names Jump to latest with the Moss tooltip and keeps its click", async () => {
  const onClick = vi.fn();
  await render(
    <div className="relative h-40 w-80 bg-background">
      <JumpToLatestButton onClick={onClick} />
    </div>,
  );
  const button = document.querySelector<HTMLElement>("button")!;
  // The shared IconButton, rendered as its tooltip's trigger.
  expect(button.getAttribute("data-slot")).toBe("tooltip-trigger");
  expect(button.hasAttribute("title")).toBe(false);
  await tooltipOnHover(button);
  await userEvent.click(page.elementLocator(button));
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("names the send button with the Moss tooltip and sends on click", async () => {
  const onSend = vi.fn();
  await render(
    <div className="bg-background p-10">
      <ComposerSendButton waits={false} label="Send message" disabled={false} onSend={onSend} />
    </div>,
  );
  const button = document.querySelector<HTMLElement>("button")!;
  // The shared IconButton, rendered as its tooltip's trigger.
  expect(button.getAttribute("data-slot")).toBe("tooltip-trigger");
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.getBoundingClientRect().height).toBe(32);
  await tooltipOnHover(button);
  await userEvent.click(page.elementLocator(button));
  expect(onSend).toHaveBeenCalledWith(false);
});

it("draws Load earlier messages as the shared ghost Button, 13 px and normal weight", async () => {
  const onLoad = vi.fn();
  await render(
    <div className="flex flex-col bg-background p-6">
      <MossbotLoadEarlierButton onLoad={onLoad} />
    </div>,
  );
  const button = document.querySelector<HTMLElement>("[data-mossbot-load-earlier]")!;
  expect(button.getAttribute("data-slot")).toBe("button");
  expect(getComputedStyle(button).fontSize).toBe("13px");
  expect(Number(getComputedStyle(button).fontWeight)).toBeLessThan(500);
  await userEvent.click(page.elementLocator(button));
  expect(onLoad).toHaveBeenCalledTimes(1);
});
