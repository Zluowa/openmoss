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
    onQuoteToComposer: vi.fn(),
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

it("quotes into the composer from Reply without sending", async () => {
  const callbacks = props();
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    expect(callbacks.onQuoteToComposer).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await screen.unmount();
  }
});

// A stand-in for the chat composer: Enter in it sends, like the real one.
function FakeComposer(props: { onSend: () => void }) {
  return (
    <div
      contentEditable
      suppressContentEditableWarning
      aria-label="Composer"
      role="textbox"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          props.onSend();
        }
      }}
    />
  );
}

it("quote, then Enter in the popover doesn't send", async () => {
  const send = vi.fn();
  const callbacks = props();
  // Worst case: the composer takes focus synchronously, inside the same keydown.
  callbacks.onQuoteToComposer.mockImplementation(() => {
    document.querySelector<HTMLElement>('[aria-label="Composer"]')?.focus();
  });
  const screen = await render(
    <>
      <FakeComposer onSend={send} />
      <TranscriptSelectionActionLayer {...callbacks} />
    </>,
  );
  try {
    await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
    // Held: the first keydown quotes, the repeats land on the focused composer.
    await userEvent.keyboard("{Enter>5}");
    await expect.element(page.getByRole("textbox", { name: "Composer" })).toHaveFocus();
    await userEvent.keyboard("{/Enter}");
    expect(callbacks.onQuoteToComposer).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    // The reader's own next Enter is theirs again.
    await userEvent.keyboard("{Enter}");
    expect(send).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});

it("leaves an IME-composing Enter alone", async () => {
  const callbacks = props();
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await expect.element(page.getByRole("toolbar", { name: "Selection actions" })).toBeVisible();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(callbacks.onQuoteToComposer).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
