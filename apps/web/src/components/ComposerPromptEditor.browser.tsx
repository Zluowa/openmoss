import { useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY } from "./chat/composerPrediction";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

afterEach(async () => {
  await cleanup();
  localStorage.removeItem(COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY);
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

function PredictionHarness({
  showHint = true,
  onAccept,
  initialValue = "Please rev",
}: {
  showHint?: boolean;
  onAccept: () => void;
  initialValue?: string;
}) {
  const [draft, setDraft] = useState({
    value: initialValue,
    cursor: initialValue.length,
  });
  const predictionValue = "Please review the current changes";
  return (
    <ComposerPromptEditor
      {...draft}
      terminalContexts={[]}
      disabled={false}
      placeholder="Prompt"
      prediction={{
        base: draft.value,
        suffix: predictionValue.slice(draft.value.length),
        hint: "Press Tab to accept",
        showHint,
        onAccept: () => {
          setDraft({ value: predictionValue, cursor: predictionValue.length });
          onAccept();
        },
      }}
      onRemoveTerminalContext={() => {}}
      onPaste={() => {}}
      onChange={(value, cursor) => setDraft({ value, cursor })}
    />
  );
}

function EmptyPredictionHarness({
  onAccept,
  predictionValue = "Please review the current changes",
}: {
  onAccept: () => void;
  predictionValue?: string;
}) {
  const [draft, setDraft] = useState({ value: "", cursor: 0 });
  return (
    <ComposerPromptEditor
      {...draft}
      terminalContexts={[]}
      disabled={false}
      placeholder="Prompt"
      prediction={{
        base: "",
        suffix: predictionValue,
        hint: "Press Tab to accept",
        showHint: true,
        onAccept: () => {
          setDraft({ value: predictionValue, cursor: predictionValue.length });
          onAccept();
        },
      }}
      onRemoveTerminalContext={() => {}}
      onPaste={() => {}}
      onChange={(value, cursor) => setDraft({ value, cursor })}
    />
  );
}

function PersistentPredictionHarness() {
  const [hasAccepted, setHasAccepted] = useLocalStorage(
    COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  return <PredictionHarness showHint={!hasAccepted} onAccept={() => setHasAccepted(true)} />;
}

describe("composer prediction", () => {
  it("renders an independent Tab hint and accepts the gray completion", async () => {
    const onAccept = vi.fn();
    await render(<PredictionHarness onAccept={onAccept} />);

    await expect
      .element(page.getByTestId("composer-prediction-text"))
      .toHaveTextContent("iew the current changes");
    await expect
      .element(page.getByTestId("composer-prediction-hint"))
      .toHaveTextContent("Press Tab to accept");
    const descriptionId = page
      .getByTestId("composer-editor")
      .element()
      .getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)?.textContent).toContain("Press Tab to accept");

    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{Tab}");

    expect(onAccept).toHaveBeenCalledOnce();
    await expect
      .element(page.getByTestId("composer-editor"))
      .toHaveTextContent("Please review the current changes");
  });

  it("renders the gray prediction with the chips the accepted prompt gets", async () => {
    const onAccept = vi.fn();
    await render(
      <EmptyPredictionHarness
        onAccept={onAccept}
        predictionValue="Use $check-code on @AGENTS.md please"
      />,
    );

    const ghost = page.getByTestId("composer-prediction-text");
    await expect.element(ghost).toHaveTextContent("Use Check Code on AGENTS.md please");
    const ghostChips = [...ghost.element().querySelectorAll('[contenteditable="false"]')];
    expect(ghostChips.map((chip) => chip.textContent)).toEqual(["Check Code", "AGENTS.md"]);

    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{Tab}");
    expect(onAccept).toHaveBeenCalledOnce();
    await expect.element(page.getByTestId("composer-prediction")).not.toBeInTheDocument();
    const editorChips = [
      ...page
        .getByTestId("composer-editor")
        .element()
        .querySelectorAll('[contenteditable="false"]'),
    ];
    // Same builder, same DOM: the ghost previewed exactly what the prompt now shows. Lexical
    // only adds its own text-node marker to the editor's chips.
    expect(
      editorChips.map((chip) => {
        expect(chip.getAttribute("data-lexical-text")).toBe("true");
        const copy = chip.cloneNode(true) as Element;
        copy.removeAttribute("data-lexical-text");
        return copy.outerHTML;
      }),
    ).toEqual(ghostChips.map((chip) => chip.outerHTML));
  });

  it("accepts an empty-composer prediction with Enter", async () => {
    const onAccept = vi.fn();
    await render(<EmptyPredictionHarness onAccept={onAccept} />);
    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{Enter}");

    expect(onAccept).toHaveBeenCalledOnce();
    await expect
      .element(page.getByTestId("composer-editor"))
      .toHaveTextContent("Please review the current changes");
  });

  it("does not accept a prediction from Shift+Tab and can hide only the hint", async () => {
    const onAccept = vi.fn();
    await render(<PredictionHarness showHint={false} onAccept={onAccept} />);

    await expect.element(page.getByTestId("composer-prediction")).toBeVisible();
    expect(page.getByTestId("composer-prediction-hint").query()).toBeNull();
    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("hides and does not accept a prediction while text is selected", async () => {
    const onAccept = vi.fn();
    await render(<PredictionHarness onAccept={onAccept} />);
    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    await expect.element(page.getByTestId("composer-prediction")).not.toBeInTheDocument();

    await userEvent.keyboard("{Tab}");
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("rejects a stale prediction when a pending paste arrives before Tab", async () => {
    const onAccept = vi.fn();
    await render(<PredictionHarness onAccept={onAccept} />);
    await page.getByTestId("composer-editor").click();
    paste("iew");
    page
      .getByTestId("composer-editor")
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          code: "Tab",
          keyCode: 9,
          bubbles: true,
          cancelable: true,
        }),
      );

    expect(onAccept).not.toHaveBeenCalled();
  });

  it("hides the gray completion while an IME composition is open", async () => {
    const onAccept = vi.fn();
    await render(<PredictionHarness onAccept={onAccept} />);
    const editor = page.getByTestId("composer-editor").element();
    await expect.element(page.getByTestId("composer-prediction")).toBeVisible();

    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await expect.element(page.getByTestId("composer-prediction")).not.toBeInTheDocument();

    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        code: "Tab",
        keyCode: 9,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onAccept).not.toHaveBeenCalled();

    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    await expect.element(page.getByTestId("composer-prediction")).toBeVisible();
    await expect
      .element(page.getByTestId("composer-prediction-text"))
      .toHaveTextContent("iew the current changes");
  });

  it("accepts the gray completion with ArrowRight", async () => {
    const onAccept = vi.fn();
    await render(<PredictionHarness onAccept={onAccept} />);
    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{ArrowRight}");

    expect(onAccept).toHaveBeenCalledOnce();
    await expect
      .element(page.getByTestId("composer-editor"))
      .toHaveTextContent("Please review the current changes");
  });

  it.each(["Shift", "Control", "Alt", "Meta"])(
    "does not accept the gray completion from %s+ArrowRight",
    async (modifier) => {
      const onAccept = vi.fn();
      await render(<PredictionHarness onAccept={onAccept} />);
      await page.getByTestId("composer-editor").click();
      await userEvent.keyboard(`{${modifier}>}{ArrowRight}{/${modifier}}`);
      expect(onAccept).not.toHaveBeenCalled();
      await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("Please rev");
    },
  );

  it("uses the Codex hint treatment with text-sm=12px via text-ui-sm", async () => {
    await render(<PredictionHarness onAccept={() => {}} />);
    const hint = page.getByTestId("composer-prediction-hint").element();
    expect(hint.className).toContain("bg-text/3");
    expect(hint.className).toContain("px-1.75");
    expect(hint.className).toContain("py-0.5");
    expect(hint.className).toContain("leading-4");
    expect(hint.className).toContain("rounded-row");
    expect(hint.className).toContain("font-normal");
    expect(hint.className).toContain("inline-block");
    expect(hint.className).toContain("text-tertiary/50");
    expect(hint.className).toContain("whitespace-nowrap");
    expect(hint.className).toContain("text-ui-sm");
    expect(page.getByTestId("composer-prediction-text").element().className).toContain(
      "text-tertiary",
    );
  });

  it("remembers the first acceptance and keeps later predictions without the hint", async () => {
    await render(<PersistentPredictionHarness />);
    await page.getByTestId("composer-editor").click();
    await userEvent.keyboard("{Tab}");
    await vi.waitFor(() =>
      expect(localStorage.getItem(COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY)).toBe("true"),
    );

    await cleanup();
    await render(<PersistentPredictionHarness />);
    await expect.element(page.getByTestId("composer-prediction")).toBeVisible();
    expect(page.getByTestId("composer-prediction-hint").query()).toBeNull();
  });
});
