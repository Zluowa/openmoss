import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX } from "./chatSelectionActions";
import { TranscriptSelectionActionLayer } from "./TranscriptSelectionActionLayer";

const action = {
  selection: {
    assistantMessageId: "assistant-1",
    text: "Cache TTL, snapshots, and process lifetime remain unchanged.",
  },
  left: 120,
  top: 320,
  placement: "top" as const,
};

function props() {
  return {
    action,
    canAddToSide: true,
    onDismiss: vi.fn(),
    onAddToSide: vi.fn().mockResolvedValue(undefined),
    onSendReply: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

it("shows the desktop chat's two actions and routes the quote to a side chat", async () => {
  const callbacks = props();
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
    await expect.element(toolbar).toBeVisible();
    expect(toolbar.element().textContent).toBe("Start a side chatReply");
    expect(toolbar.element().querySelectorAll("svg")).toHaveLength(0);
    // Labels must never clip, and the rendered height must match the height the
    // layout reserves when placing the toolbar above the selection.
    for (const button of toolbar.element().querySelectorAll("button")) {
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    }
    const bar = toolbar.element().firstElementChild!;
    expect(bar.getBoundingClientRect().height).toBe(TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX);
    await page.getByRole("button", { name: "Start a side chat", exact: true }).click();
    expect(callbacks.onAddToSide).toHaveBeenCalledExactlyOnceWith(action.selection);
  } finally {
    await screen.unmount();
  }
});

it("sends into the open side chat once one exists", async () => {
  const screen = await render(<TranscriptSelectionActionLayer {...props()} sideChatStarted />);
  try {
    await expect
      .element(page.getByRole("button", { name: "Send to side chat", exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("replies to the quote with Enter and sends the desktop chat's reply format", async () => {
  const callbacks = props();
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const box = page.getByRole("dialog", { name: "Reply" });
    await expect.element(box).toBeVisible();
    expect(box.element().querySelector("[data-reply-quote]")?.textContent).toBe(
      action.selection.text,
    );
    const input = page.getByRole("textbox", { name: "Reply" });
    await expect.element(input).toHaveFocus();
    expect(input.element().getAttribute("placeholder")).toBe("Reply to the agent");
    await input.fill("Why does the TTL stay?");
    await userEvent.keyboard("{Enter}");
    expect(callbacks.onSendReply).toHaveBeenCalledExactlyOnceWith(
      `<!-- reply -->\n> ${action.selection.text}\n\nWhy does the TTL stay?`,
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("opens Reply from the Enter key while the toolbar is up", async () => {
  const screen = await render(<TranscriptSelectionActionLayer {...props()} />);
  try {
    await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "Reply" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("keeps the reply text when sending fails", async () => {
  const callbacks = props();
  callbacks.onSendReply.mockResolvedValue(false);
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Reply" });
    await input.fill("Keep this message");
    await page.getByRole("button", { name: "Send reply" }).click();
    expect(callbacks.onSendReply).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("dialog", { name: "Reply" })).toBeVisible();
    await expect.element(input).toHaveValue("Keep this message");
  } finally {
    await screen.unmount();
  }
});

it("keeps a rejected reply for retry without exposing transport errors", async () => {
  const callbacks = props();
  callbacks.onSendReply.mockRejectedValueOnce(new Error("private transport detail"));
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Reply" });
    await input.fill("Keep this reply");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The reply couldn't be sent. Try again.");
    await expect.element(input).toHaveValue("Keep this reply");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(callbacks.onSendReply).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});

it("fits the reply box inside a narrow viewport", async () => {
  await page.viewport(360, 480);
  const screen = await render(
    <TranscriptSelectionActionLayer {...props()} action={{ ...action, left: 8, top: 8 }} />,
  );
  try {
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    const rect = page.getByRole("dialog", { name: "Reply" }).element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(8);
    expect(rect.top).toBeGreaterThanOrEqual(8);
    expect(rect.bottom).toBeLessThanOrEqual(472);
  } finally {
    await screen.unmount();
    await page.viewport(1280, 720);
  }
});
