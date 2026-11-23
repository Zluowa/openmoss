// FILE: ThemeCssEditor.tsx
// Purpose: A plain code box for a theme pack's custom CSS: Tab indents, Enter keeps indentation,
//          and the caret position shows below it.
// Layer: Web settings UI
// Exports: ThemeCssEditor
// Origin: Ported from apps/web/src/components/settings/ThemeCssEditor.tsx in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8 (PR #35247). Moss changes: Moss
//   control styles, the length limit and counter, and a hint for the reset shortcut.

import { THEME_CSS_MAX_LENGTH } from "@moss/contracts";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { THEME_RESET_SHORTCUT_LABEL } from "@moss/shared/themeCss";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { SETTINGS_CONTROL_RADIUS_CLASS_NAME } from "~/settingsPanelStyles";
import { Button } from "../ui/button";

export function ThemeCssEditor({
  value,
  ariaLabel,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const hintId = useId();
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [tabIndents, setTabIndents] = useState(true);

  function updatePosition(editor: HTMLTextAreaElement) {
    const preceding = editor.value.slice(0, editor.selectionStart).split("\n");
    setPosition({ line: preceding.length, column: (preceding.at(-1)?.length ?? 0) + 1 });
  }

  function replaceSelection(editor: HTMLTextAreaElement, replacement: string) {
    // Native insertion preserves undo history for indentation as well as typing.
    if (!document.execCommand("insertText", false, replacement)) {
      editor.setRangeText(replacement, editor.selectionStart, editor.selectionEnd, "end");
    }
    onChange(editor.value);
    updatePosition(editor);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeComposingKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    const editor = event.currentTarget;
    if (event.key === "Escape") {
      // The first Escape frees Tab for focus moves; it must not close Settings.
      if (!tabIndents) return;
      event.preventDefault();
      event.stopPropagation();
      setTabIndents(false);
      return;
    }
    if (event.key === "Tab" && tabIndents) {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const lineStart = start === 0 ? 0 : editor.value.lastIndexOf("\n", start - 1) + 1;
      if (start === end && !event.shiftKey) {
        replaceSelection(editor, "  ");
      } else if (start === end) {
        const indent = editor.value.slice(lineStart).match(/^(?: {1,2}|\t)/)?.[0] ?? "";
        if (!indent) return;
        editor.setSelectionRange(lineStart, lineStart + indent.length);
        replaceSelection(editor, "");
        editor.setSelectionRange(
          Math.max(lineStart, start - indent.length),
          Math.max(lineStart, end - indent.length),
        );
      } else {
        // A selection ending at a line's start leaves that next line untouched.
        const blockEnd = end > start && editor.value[end - 1] === "\n" ? end - 1 : end;
        const selected = editor.value.slice(lineStart, blockEnd);
        const replacement = selected
          .split("\n")
          .map((line) => (event.shiftKey ? line.replace(/^(?: {1,2}|\t)/, "") : `  ${line}`))
          .join("\n");
        editor.setSelectionRange(lineStart, blockEnd);
        replaceSelection(editor, replacement);
        editor.setSelectionRange(lineStart, lineStart + replacement.length);
      }
      updatePosition(editor);
    } else if (event.key === "Enter" && editor.selectionStart === editor.selectionEnd) {
      const precedingLine = editor.value.slice(0, editor.selectionStart).split("\n").at(-1) ?? "";
      const indent = precedingLine.match(/^[\t ]*/)?.[0] ?? "";
      event.preventDefault();
      replaceSelection(editor, `\n${indent}${precedingLine.trimEnd().endsWith("{") ? "  " : ""}`);
    }
  }

  return (
    <div className="space-y-2">
      <div
        className={cn(
          SETTINGS_CONTROL_RADIUS_CLASS_NAME,
          "overflow-hidden border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] text-foreground focus-within:border-[color:var(--color-border-focus)]",
        )}
      >
        <textarea
          aria-label={ariaLabel}
          aria-describedby={hintId}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          translate="no"
          wrap="off"
          maxLength={THEME_CSS_MAX_LENGTH}
          data-theme-css-editor=""
          className="block h-52 w-full resize-y bg-transparent p-3 font-chat-code text-chat-code leading-5 outline-none"
          placeholder={"[data-chat-header] {\n  border-bottom: 1px solid var(--color-border);\n}"}
          value={value}
          onFocus={() => setTabIndents(true)}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            updatePosition(event.currentTarget);
          }}
          onSelect={(event) => updatePosition(event.currentTarget)}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center justify-between border-t border-[color:var(--color-border)] px-3 py-1 font-chat-code text-ui-sm text-muted-foreground tabular-nums">
          <span>CSS</span>
          <span>
            {position.line}:{position.column} · {value.length.toLocaleString("en-US")}/
            {THEME_CSS_MAX_LENGTH.toLocaleString("en-US")}
          </span>
        </div>
      </div>
      <div className="flex items-start justify-between gap-2">
        <div id={hintId} className="space-y-1 text-ui-sm text-muted-foreground">
          {/* Read by screen readers only: the keys are the same as any code box. */}
          <p className="sr-only">
            {tabIndents
              ? "Tab indents. Shift+Tab unindents. Press Escape, then Tab to leave."
              : "Tab moves to the next control."}
          </p>
          <p>
            <span>If custom CSS makes Moss unusable, press</span>{" "}
            <kbd className="font-chat-code">{THEME_RESET_SHORTCUT_LABEL}</kbd>{" "}
            <span>to restore the default look.</span>
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          disabled={!value}
          onClick={() => {
            onChange("");
            setPosition({ line: 1, column: 1 });
          }}
        >
          Clear CSS
        </Button>
      </div>
    </div>
  );
}
