import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX } from "./chatSelectionActions";
import { TranscriptSelectionActionLayer } from "./TranscriptSelectionActionLayer";
import { type PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";

const QUOTE = "Cache TTL, snapshots, and process lifetime remain unchanged.";

const pillAction: PendingTranscriptSelectionAction = {
  selection: { assistantMessageId: "assistant-1", text: QUOTE },
  left: 120,
  top: 320,
  placement: "top",
  range: null,
  boundary: null,
  mode: "pill",
};

function props(action: PendingTranscriptSelectionAction = pillAction) {
  return {
    action,
    canAddToSide: true,
    onDismiss: vi.fn(),
    onAddToSide: vi.fn().mockResolvedValue(undefined),
    onOpenReply: vi.fn(),
    onQuoteToComposer: vi.fn((_comment: string) => true),
    onSendReply: vi.fn((_comment: string) => true),
  };
}

// A transcript passage with its text selected, as the real controller captures it.
function Passage() {
  return (
    <div data-testid="transcript" style={{ width: 640, padding: "160px 24px 24px" }}>
      <p data-testid="passage">{QUOTE}</p>
    </div>
  );
}

function rangeOverPassage(): { range: Range; boundary: HTMLElement } {
  const passage = document.querySelector('[data-testid="passage"]')!;
  const range = document.createRange();
  range.selectNodeContents(passage);
  return { range, boundary: document.querySelector('[data-testid="transcript"]')! };
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
    // Labels must never clip, and the rendered height must match the height the
    // layout reserves when placing the pill above the selection.
    for (const button of toolbar.element().querySelectorAll("button")) {
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth);
    }
    const bar = toolbar.element().firstElementChild!;
    expect(bar.getBoundingClientRect().height).toBe(TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX);
    // One hairline between the two actions.
    expect(bar.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    await page.getByRole("button", { name: "Start a side chat", exact: true }).click();
    expect(callbacks.onAddToSide).toHaveBeenCalledExactlyOnceWith(pillAction.selection);
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

it("Reply opens the reply card instead of quoting straight away", async () => {
  const callbacks = props();
  const screen = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  try {
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    expect(callbacks.onOpenReply).toHaveBeenCalledOnce();
    expect(callbacks.onQuoteToComposer).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("pins the pill above the selected text, centred on it", async () => {
  const screen = await render(<Passage />);
  const anchor = rangeOverPassage();
  const layer = await render(
    <TranscriptSelectionActionLayer {...props({ ...pillAction, ...anchor })} />,
  );
  try {
    const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
    await expect.element(toolbar).toBeVisible();
    const pill = toolbar.element().getBoundingClientRect();
    const line = anchor.range.getClientRects()[0]!;
    expect(pill.bottom).toBeLessThanOrEqual(line.top - 7);
    expect(Math.abs(pill.left + pill.width / 2 - (line.left + line.width / 2))).toBeLessThan(2);
  } finally {
    await layer.unmount();
    await screen.unmount();
  }
});

async function renderReplyCard(callbacks = props()) {
  const passage = await render(<Passage />);
  const anchor = rangeOverPassage();
  const action: PendingTranscriptSelectionAction = { ...pillAction, ...anchor, mode: "reply" };
  callbacks.action = action;
  const layer = await render(<TranscriptSelectionActionLayer {...callbacks} />);
  const field = page.getByRole("textbox", { name: "Your reply" });
  await expect.element(field).toHaveFocus();
  return {
    callbacks,
    field,
    async unmount() {
      await layer.unmount();
      await passage.unmount();
    },
  };
}

it("the reply card quotes two lines at most and adds the quote on Enter", async () => {
  const card = await renderReplyCard();
  try {
    const dialog = page.getByRole("dialog", { name: "Reply to selection" });
    await expect.element(dialog).toBeVisible();
    expect(dialog.element().getBoundingClientRect().width).toBe(320);
    expect(dialog.element().querySelector("blockquote")?.textContent).toBe(QUOTE);
    expect(card.field.element().getAttribute("placeholder")).toBe("Reply to Moss");
    await userEvent.keyboard("{Enter}");
    expect(card.callbacks.onQuoteToComposer).toHaveBeenCalledExactlyOnceWith("");
    expect(card.callbacks.onSendReply).not.toHaveBeenCalled();
  } finally {
    await card.unmount();
  }
});

it("adds the typed reply with the quote, and Ctrl+Enter sends it", async () => {
  const card = await renderReplyCard();
  try {
    await userEvent.keyboard("Keep the offsets");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(card.callbacks.onSendReply).toHaveBeenCalledExactlyOnceWith("Keep the offsets");
    expect(card.callbacks.onQuoteToComposer).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Add to prompt" }).click();
    expect(card.callbacks.onQuoteToComposer).toHaveBeenCalledExactlyOnceWith("Keep the offsets");
  } finally {
    await card.unmount();
  }
});

it("closes on a press outside while empty, and on Escape", async () => {
  const card = await renderReplyCard();
  try {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(card.callbacks.onDismiss).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(card.callbacks.onDismiss).toHaveBeenCalledTimes(2);
  } finally {
    await card.unmount();
  }
});

it("keeps a typed reply open through a press outside", async () => {
  const card = await renderReplyCard();
  try {
    await userEvent.keyboard("half a thought");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(card.callbacks.onDismiss).not.toHaveBeenCalled();
  } finally {
    await card.unmount();
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

it("Enter on the pill opens Reply and a held Enter never sends", async () => {
  const send = vi.fn();
  const callbacks = props();
  // Worst case: another field takes focus synchronously, inside the same keydown.
  callbacks.onOpenReply.mockImplementation(() => {
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
    // Held: the first keydown opens Reply, the repeats land on the focused field.
    await userEvent.keyboard("{Enter>5}");
    await expect.element(page.getByRole("textbox", { name: "Composer" })).toHaveFocus();
    await userEvent.keyboard("{/Enter}");
    expect(callbacks.onOpenReply).toHaveBeenCalledOnce();
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
    expect(callbacks.onOpenReply).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
