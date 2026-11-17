// Chinese input method (IME) driver for browser tests. While pinyin candidates show, the Enter
// that picks a candidate belongs to the input method: it must not submit a form, send a message
// or pick a list option.
//
// The composition and the commit are trusted CDP input (Input.imeSetComposition, then
// Input.insertText), so the field holds a real composition. The confirming key is dispatched from
// the page with an explicit shape, because Chrome reports it per platform: Windows input methods
// send `key: "Process"` (keyCode 229), macOS and Linux send `key: "Enter"` with keyCode 229 and
// `isComposing: true`. Each case can name the shape, and both run the same on every system.
import { commands } from "vitest/browser";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    imeCompose: (pinyin: string) => Promise<void>;
    imeCommit: (committed: string) => Promise<void>;
  }
}

/** How the platform reports the key that confirms a candidate. */
export type ImeConfirmKey = "Enter" | "Process";

function dispatchKey(
  target: Element,
  init: KeyboardEventInit & { type: "keydown" | "keyup"; keyCode: number },
) {
  const event = new KeyboardEvent(init.type === "keyup" ? "keyup" : "keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  // keyCode and which are read-only in the constructor dictionary; handlers still read them.
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  Object.defineProperty(event, "which", { value: init.keyCode });
  target.dispatchEvent(event);
}

/**
 * Type `pinyin` through a composition into `field`, confirm the candidate with Enter (as `confirmKey`
 * reports it), and commit `committed`: keydown during the composition, compositionend, keyup.
 *
 * `whileComposing` runs after the screen has caught up with the composition and before the
 * confirming key: a case asserts there what a person sees then (a highlighted row the Enter
 * could wrongly pick), so it cannot pass just because nothing was there to pick.
 */
export async function composeChineseWithEnter(
  field: HTMLElement,
  pinyin = "nihao",
  committed = "你好",
  confirmKey: ImeConfirmKey = "Enter",
  whileComposing?: () => Promise<void>,
): Promise<void> {
  field.focus();
  if (document.activeElement !== field && !field.contains(document.activeElement)) {
    throw new Error("IME target did not take focus");
  }
  await commands.imeCompose(pinyin);
  // A person reads the candidates before confirming; let the page render the composed text.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await whileComposing?.();
  const target = document.activeElement ?? field;
  dispatchKey(target, {
    type: "keydown",
    key: confirmKey,
    code: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  await commands.imeCommit(committed);
  dispatchKey(target, {
    type: "keyup",
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    isComposing: false,
  });
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
