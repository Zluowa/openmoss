// FILE: cursorMoves.browser.tsx
// Purpose: The cursor rule on targets the cursor-pointer move touched: a moved control (the
//          sidebar's icon button) shows the arrow in the desktop app and the hand on the web;
//          the links in text that keep `cursor-pointer` (a file mention, a URL chip) show the hand
//          in both, as Claude desktop's text links do.
// Layer: Web appearance tests (real Chromium, real Moss CSS)

import "../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { InlineMentionChip } from "./chat/InlineMentionChip";
import { InlineLinkChip } from "./InlineLinkChip";
import { SidebarIconButton } from "./SidebarIconButton";
import { PlusIcon } from "~/lib/icons";

function Targets() {
  return (
    <div className="flex flex-col items-start gap-2 p-4">
      <SidebarIconButton icon={PlusIcon} label="新对话" />
      <p>
        看 <InlineMentionChip path="src/index.js" href="#src/index.js" theme="light" />
      </p>
      <p>
        <InlineLinkChip url="https://example.com/docs" interactive />
      </p>
    </div>
  );
}

function cursors() {
  const mention = document.querySelector<HTMLElement>("[data-mention-path='src/index.js']");
  const urlChip = document.querySelector<HTMLElement>("p:last-of-type button, p:last-of-type a");
  if (!mention || !urlChip) throw new Error("link targets not rendered");
  return {
    control: getComputedStyle(page.getByRole("button", { name: "新对话" }).element()).cursor,
    fileMention: getComputedStyle(mention).cursor,
    urlChip: getComputedStyle(urlChip).cursor,
  };
}

afterEach(async () => {
  await cleanup();
  delete document.documentElement.dataset.runtime;
});

describe("cursor on moved targets", () => {
  it("on the web: the control and the links show the hand", async () => {
    await render(<Targets />);
    await expect.element(page.getByRole("button", { name: "新对话" })).toBeVisible();
    expect(cursors()).toEqual({ control: "pointer", fileMention: "pointer", urlChip: "pointer" });
  });

  it("in the desktop app: the control shows the arrow, the links keep the hand", async () => {
    document.documentElement.dataset.runtime = "electron";
    await render(<Targets />);
    await expect.element(page.getByRole("button", { name: "新对话" })).toBeVisible();
    expect(cursors()).toEqual({ control: "default", fileMention: "pointer", urlChip: "pointer" });
  });
});
