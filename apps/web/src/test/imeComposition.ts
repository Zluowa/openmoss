// Chinese input method (IME) driver for browser tests. While pinyin candidates show, the Enter
// that picks a candidate belongs to the input method: it must not submit a form, send a
// message or pick a list option. The command sends trusted CDP composition events, so the
// browser's own default actions (implicit form submission) run exactly as they would for a
// person typing 「你好」 with a pinyin keyboard.
import { commands } from "vitest/browser";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    imeComposeAndConfirm: (
      pinyin: string,
      committed: string,
      confirmKey?: "Enter" | "Process",
    ) => Promise<void>;
  }
}

/** Type `pinyin` through a composition into the focused field and confirm `committed` with Enter. */
export async function composeChineseWithEnter(
  field: HTMLElement,
  pinyin = "nihao",
  committed = "你好",
  confirmKey: "Enter" | "Process" = "Enter",
): Promise<void> {
  field.focus();
  if (document.activeElement !== field && !field.contains(document.activeElement)) {
    throw new Error("IME target did not take focus");
  }
  await commands.imeComposeAndConfirm(pinyin, committed, confirmKey);
}

/** Records the keyboard and composition events a field sees, to prove the driver is real. */
export function recordImeEvents(target: EventTarget): {
  readonly events: string[];
  readonly stop: () => void;
} {
  const events: string[] = [];
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    events.push(`${key.type}:${key.key}:${key.keyCode}:${key.isComposing ? "composing" : "idle"}`);
  };
  const onComposition = (event: Event) => events.push(event.type);
  const types = ["compositionstart", "compositionend"] as const;
  target.addEventListener("keydown", onKey, true);
  for (const type of types) target.addEventListener(type, onComposition, true);
  return {
    events,
    stop: () => {
      target.removeEventListener("keydown", onKey, true);
      for (const type of types) target.removeEventListener(type, onComposition, true);
    },
  };
}
