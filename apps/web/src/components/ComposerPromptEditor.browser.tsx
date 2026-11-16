import "../index.css";

import { createRef, useRef, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME } from "./chat/composerPickerStyles";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

afterEach(async () => {
  await cleanup();
});

function ComposerHarness({ onSend }: { onSend: (text: string) => void }) {
  const editor = useRef<ComposerPromptEditorHandle>(null);
  const [draft, setDraft] = useState({ value: "", cursor: 0 });
  const send = () => onSend(editor.current!.readSnapshot({ flushPending: true }).value);
  return (
    <>
      <ComposerPromptEditor
        ref={editor}
        {...draft}
        terminalContexts={[]}
        disabled={false}
        placeholder="Prompt"
        onRemoveTerminalContext={() => {}}
        onPaste={() => {}}
        onChange={(value, cursor) => setDraft({ value, cursor })}
        onCommandKeyDown={(key, event) => {
          if (key === "ArrowDown") editor.current!.readSnapshot();
          if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
          send();
          return true;
        }}
      />
      <button onClick={send}>Send</button>
      <output data-testid="controlled-draft">{draft.value}</output>
    </>
  );
}

function paste(text: string) {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  // Rich clipboard content must not replace or truncate the plain prompt.
  data.setData("text/html", "<p>first paragraph only</p>");
  page
    .getByTestId("composer-editor")
    .element()
    .dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
}

describe("multiline composer submission", () => {
  const prompt = "First paragraph.\n\nSecond paragraph.\nLast line: 你好.";

  it.each(["Enter", "button"])("sends all pasted paragraphs with %s", async (method) => {
    const onSend = vi.fn();
    await render(<ComposerHarness onSend={onSend} />);
    await page.getByTestId("composer-editor").click();
    paste(prompt);
    if (method === "Enter") await userEvent.keyboard("{Enter}");
    else await page.getByRole("button", { name: "Send" }).click();
    expect(onSend).toHaveBeenCalledExactlyOnceWith(prompt);
  });

  it.each(["Enter", "button"])(
    "includes pending pasted content when %s runs before the editor commit",
    async (method) => {
      const onSend = vi.fn();
      await render(<ComposerHarness onSend={onSend} />);
      await page.getByTestId("composer-editor").click();
      paste("First paragraph.");
      await expect
        .element(page.getByTestId("composer-editor"))
        .toHaveTextContent("First paragraph.");
      // Native input and a submit can arrive in the same task, before Lexical's
      // update microtask and React's controlled draft have caught up.
      paste("\n\nSecond paragraph.\nLast line: 你好.");
      if (method === "Enter") {
        page
          .getByTestId("composer-editor")
          .element()
          .dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
              cancelable: true,
            }),
          );
      } else {
        (page.getByRole("button", { name: "Send" }).element() as HTMLButtonElement).click();
      }
      expect(onSend).toHaveBeenCalledExactlyOnceWith(prompt);
    },
  );

  it("publishes the full controlled value after a command reads the pending paste", async () => {
    await render(<ComposerHarness onSend={() => {}} />);
    await page.getByTestId("composer-editor").click();
    paste(prompt);
    page
      .getByTestId("composer-editor")
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          keyCode: 40,
          bubbles: true,
          cancelable: true,
        }),
      );
    await vi.waitFor(
      () => expect(page.getByTestId("controlled-draft").element().textContent).toBe(prompt),
      { timeout: 2_000 },
    );
  });

  it("retains Shift+Enter line breaks and does not submit an IME confirmation", async () => {
    const onSend = vi.fn();
    await render(<ComposerHarness onSend={onSend} />);
    await page.getByTestId("composer-editor").click();
    paste("First paragraph.");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    paste("Second paragraph.");
    page
      .getByTestId("composer-editor")
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    expect(onSend).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Send" }).click();
    expect(onSend.mock.calls[0]?.[0]).toContain("First paragraph.\nSecond paragraph.");
  });
});

const overlay = () => document.querySelector<HTMLElement>('[data-testid="composer-prediction"]');
const field = () =>
  document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!.parentElement!;
const footer = () => document.querySelector<HTMLElement>('[data-testid="composer-footer"]')!;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

type EditorProps = ComponentProps<typeof ComposerPromptEditor>;

/** Mounts the editor at a fixed width with a stand-in for the controls below it. */
async function mountPredictionEditor(
  props: Partial<EditorProps>,
  options: { readonly width?: number } = {},
) {
  const ref = createRef<ComposerPromptEditorHandle>();
  let current: EditorProps = {
    value: "",
    cursor: 0,
    terminalContexts: [],
    disabled: false,
    placeholder: "Write a message",
    ariaLabel: "Message",
    onRemoveTerminalContext: vi.fn(),
    onChange: vi.fn(),
    onPaste: vi.fn(),
    ...props,
  };
  const content = () => (
    <div style={{ width: options.width ?? 640 }}>
      <ComposerPromptEditor {...current} ref={ref} />
      <div data-testid="composer-footer" style={{ height: 32 }} />
    </div>
  );
  const screen = await render(content());
  await expect.poll(() => (current.prediction ? overlay() : field())).not.toBeNull();
  await nextFrame();
  return {
    ref,
    editor: document.querySelector<HTMLElement>('[data-testid="composer-editor"]')!,
    update: async (updates: Partial<EditorProps>) => {
      current = { ...current, ...updates };
      await screen.rerender(content());
      await nextFrame();
    },
  };
}

function lineHeightOf(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).lineHeight);
}

function ghostRows(): number {
  return Math.round(overlay()!.getBoundingClientRect().height / lineHeightOf(overlay()!));
}

function ghostParts() {
  const box = overlay()!;
  const text = box.querySelector<HTMLElement>("[data-prediction-text]")!;
  const chip = box.querySelector<HTMLElement>("kbd")!;
  const range = document.createRange();
  range.selectNodeContents(text);
  const textRows = Array.from(range.getClientRects());
  return { box, text, chip, lastTextRow: textRows[textRows.length - 1]! };
}

/** The chip is fully inside the ghost and sits after the last word, never over it. */
function expectChipAttachedToText() {
  const { box, chip, lastTextRow } = ghostParts();
  const boxRect = box.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  expect(chipRect.right).toBeLessThanOrEqual(boxRect.right + 0.5);
  expect(chipRect.bottom).toBeLessThanOrEqual(boxRect.bottom + 0.5);
  const sameRow = chipRect.top < lastTextRow.bottom && chipRect.bottom > lastTextRow.top;
  if (sameRow) expect(chipRect.left).toBeGreaterThanOrEqual(lastTextRow.right);
  else expect(chipRect.top).toBeGreaterThanOrEqual(lastTextRow.bottom - 0.5);
}

describe("composer prediction ghost", () => {
  const prediction = "Fix the fixture and rerun that test.";

  it("shows the ghost text and a Tab chip instead of the placeholder", async () => {
    const mounted = await mountPredictionEditor({ prediction });

    await expect.poll(() => overlay()?.textContent).toBe(`${prediction}Tab`);
    expect(overlay()?.querySelector('kbd[aria-label="Tab"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Write a message");
    expect(mounted.editor.getAttribute("aria-placeholder")).toBe(prediction);
    // Drawn in the editor's cell only: the document and the draft stay empty.
    expect(mounted.editor.textContent).toBe("");
    expect(mounted.ref.current?.readSnapshot().value).toBe("");
  });

  it("uses the placeholder tone and the shared shortcut capsule", async () => {
    await mountPredictionEditor({ prediction });

    const { text, chip } = ghostParts();
    expect(text.className).toContain(COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME);
    expect(chip.getAttribute("data-slot")).toBe("kbd");
    expect(chip.className).toContain("rounded-full");
  });

  it("keeps the normal placeholder when there is no prediction", async () => {
    const mounted = await mountPredictionEditor({});

    await expect.poll(() => document.body.textContent).toContain("Write a message");
    expect(overlay()).toBeNull();
    expect(mounted.editor.getAttribute("aria-placeholder")).toBe("Write a message");
  });

  it("anchors an RTL prediction on the right with the Tab chip after it", async () => {
    await mountPredictionEditor({ prediction: "مرحبا بالعالم" });

    const { box, chip, lastTextRow } = ghostParts();
    expect(box.getBoundingClientRect().right - lastTextRow.right).toBeLessThan(1);
    expect(chip.getBoundingClientRect().right).toBeLessThan(lastTextRow.left);
  });

  it("hides the ghost text once the editor has content", async () => {
    const mounted = await mountPredictionEditor({ prediction });
    await expect.poll(() => overlay()).not.toBeNull();

    await mounted.update({ value: "My own message", cursor: 3 });

    await expect.poll(() => overlay()).toBeNull();
    expect(mounted.editor.textContent).toBe("My own message");
  });

  it("hides the ghost text while an IME composition is open", async () => {
    const mounted = await mountPredictionEditor({ prediction });
    await expect.poll(() => overlay()).not.toBeNull();
    mounted.editor.focus();

    mounted.editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await expect.poll(() => overlay()).toBeNull();

    mounted.editor.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "" }),
    );
    await expect.poll(() => overlay()).not.toBeNull();
  });

  describe.each([
    ["block composer", false],
    ["single-row composer", true],
  ])("in the %s", (_layout, singleLine) => {
    it("draws a one-row suggestion without changing the field's height", async () => {
      const mounted = await mountPredictionEditor({ singleLine });
      const emptyHeight = field().getBoundingClientRect().height;

      await mounted.update({ prediction });

      await expect.poll(() => overlay()?.textContent).toBe(`${prediction}Tab`);
      expect(ghostRows()).toBe(1);
      expect(field().getBoundingClientRect().height).toBeCloseTo(emptyHeight, 1);
      const { chip, lastTextRow } = ghostParts();
      // Inline right after the last word, centered on its row.
      const chipRect = chip.getBoundingClientRect();
      expect(chipRect.left - lastTextRow.right).toBeGreaterThan(4);
      expect(chipRect.left - lastTextRow.right).toBeLessThan(10);
      expect((chipRect.top + chipRect.bottom) / 2).toBeCloseTo(
        overlay()!.getBoundingClientRect().top + lineHeightOf(overlay()!) / 2,
        0,
      );

      await mounted.update({ prediction: null });
      expect(field().getBoundingClientRect().height).toBeCloseTo(emptyHeight, 1);
    });

    it("wraps a two-row suggestion in full and grows the field above the controls", async () => {
      const twoRows =
        "Go ahead with the schema change and the backfill script, both look safe to me, and leave the index rebuild for later.";
      await mountPredictionEditor({ singleLine, prediction: twoRows });

      await expect.poll(() => ghostRows()).toBe(2);
      expect(ghostParts().text.textContent).toBe(twoRows);
      expectChipAttachedToText();
      expect(field().getBoundingClientRect().height).toBeGreaterThanOrEqual(
        overlay()!.getBoundingClientRect().height - 0.5,
      );
      expect(footer().getBoundingClientRect().top).toBeGreaterThanOrEqual(
        overlay()!.getBoundingClientRect().bottom - 0.5,
      );
    });

    it.each([640, 375])(
      "ends a longer suggestion with an ellipsis on the third row at %ipx",
      async (width) => {
        const longSuggestion =
          "ok go ahead with the first two steps, but leave the third out for now, I do not want to touch the production table until we have a backup. tell me when both are done so I can check, and also rerun the migration dry run against staging before you open the pull request for review please";
        const mounted = await mountPredictionEditor(
          { singleLine, prediction: longSuggestion },
          { width },
        );

        await expect.poll(() => ghostRows()).toBe(3);
        const shown = ghostParts().text.textContent ?? "";
        expect(shown.endsWith("…")).toBe(true);
        expect(longSuggestion.startsWith(shown.slice(0, -1).trimEnd())).toBe(true);
        expectChipAttachedToText();
        expect(footer().getBoundingClientRect().top).toBeGreaterThanOrEqual(
          overlay()!.getBoundingClientRect().bottom - 0.5,
        );
        // Screen readers and Tab still get the whole suggestion.
        expect(mounted.editor.getAttribute("aria-placeholder")).toBe(longSuggestion);
      },
    );
  });
});
