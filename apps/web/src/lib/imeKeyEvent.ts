// FILE: imeKeyEvent.ts
// Purpose: Tell whether a key event belongs to an input method (pinyin, kana, hangul) rather than
//          to the page. The Enter that confirms a candidate must not send, submit, commit a
//          rename or pick a row; nor may the input method's Escape, Tab or arrows act.
// Layer: Web input helpers
// Exports: isImeComposingKeyEvent
//
// Browsers report the confirming key differently:
// - Windows (Chrome, Edge, Electron): `key: "Process"`, keyCode 229.
// - macOS and Linux Chrome: `key: "Enter"`, keyCode 229, `isComposing: true`.
// - Safari: `compositionend` first, then a keydown with keyCode 229 and `isComposing: false`.
// Checking `key === "Enter"` alone is fooled by the second shape, checking `isComposing` alone by
// the third, so all three signals count.
//
// Every keydown handler on a text field that acts on Enter (or Escape, Tab, arrows) returns early
// when this is true. `MossEnterHandlerGuard.test.ts` fails on a new handler without it.

/** The parts of a DOM or React keyboard event this check reads. */
export interface ImeKeyEventLike {
  readonly key?: string;
  readonly keyCode?: number;
  readonly which?: number;
  readonly isComposing?: boolean;
  readonly nativeEvent?: {
    readonly isComposing?: boolean;
    readonly keyCode?: number;
    readonly which?: number;
  };
}

const IME_PROCESS_KEY_CODE = 229;

/**
 * True when the key belongs to an input method's composition: the handler must do nothing and
 * must not call `preventDefault`, so the input method can commit its text.
 */
export function isImeComposingKeyEvent(event: ImeKeyEventLike): boolean {
  const native = event.nativeEvent;
  return (
    event.isComposing === true ||
    native?.isComposing === true ||
    event.key === "Process" ||
    event.keyCode === IME_PROCESS_KEY_CODE ||
    event.which === IME_PROCESS_KEY_CODE ||
    native?.keyCode === IME_PROCESS_KEY_CODE ||
    native?.which === IME_PROCESS_KEY_CODE
  );
}
