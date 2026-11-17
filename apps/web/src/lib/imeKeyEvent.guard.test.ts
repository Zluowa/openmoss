// Guard: every keydown handler that acts on Enter must first ask `isImeComposingKeyEvent`,
// so the Enter that confirms an input-method candidate never sends, submits, commits or picks.
// A site that cannot run while a text field is composing is listed below with the reason.
// A new Enter handler fails this test until it uses the helper or is listed here.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

// A site compares a key to Enter, or hands an editor command named Enter to an owner.
const ENTER_SITE =
  /\bkey\s*[!=]==?\s*["']Enter["']|\bcase\s+["']Enter["']|\[\s*["']Tab["']\s*,\s*["']Enter["']\s*\]\.includes\(/u;
// The helper counts when it is called within this many lines above the site (same handler),
// or within the next few lines (the same condition, written across lines).
const GUARD_WINDOW_LINES = 40;
const GUARD_LINES_AFTER = 3;
// The helper documents the shapes it checks.
const IGNORED_FILES = new Set(["lib/imeKeyEvent.ts"]);
const EDITOR_COMMANDS =
  "receives editor commands from ComposerPromptEditor, which drops input-method keys before any owner";

interface AllowedSite {
  /** File relative to `apps/web/src`. */
  readonly file: string;
  /** Text on the site's line, so the entry survives line moves. */
  readonly line: string;
  readonly reason: string;
}

const BUTTON = "Enter-or-Space activation on a button or row: no text field has focus";
const MODIFIER = "needs ⌘/Ctrl or Shift: a candidate is confirmed with a plain Enter";

const ALLOWED_SITES: readonly AllowedSite[] = [
  {
    file: "components/ChatMarkdown.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "components/DiffPanel.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "components/Sidebar.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "components/Sidebar.tsx",
    line: 'event.key !== "Enter" && event.key !== " "',
    reason: BUTTON,
  },
  {
    file: "components/SidebarAccountMenu.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "components/SidebarCustomSections.tsx",
    line: 'event.key !== "Enter" && event.key !== " "',
    reason: BUTTON,
  },
  {
    file: "components/SidebarThemeSkinSwitcher.tsx",
    line: 'event.key !== "Enter" && event.key !== " "',
    reason: BUTTON,
  },
  {
    file: "components/chat/CommandShellDetails.tsx",
    line: 'event.key !== "Enter" && event.key !== " "',
    reason: BUTTON,
  },
  {
    file: "components/chat/FileAttachmentChip.tsx",
    line: 'event.key !== "Enter" && event.key !== " "',
    reason: BUTTON,
  },
  {
    file: "components/chat/RealtimeVoiceStage.tsx",
    line: 'event.key !== "Enter" && event.key !== " "',
    reason: BUTTON,
  },
  {
    file: "components/pullRequest/PrStateChip.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "lib/openui/oiuStandardViews.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "routes/-automations.list.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "routes/_chat.automations.$automationId.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  { file: "routes/_chat.tsx", line: 'event.key === "Enter" || event.key === " "', reason: BUTTON },
  {
    file: "whatsNew/WhatsNewPopoutCard.tsx",
    line: 'event.key === "Enter" || event.key === " "',
    reason: BUTTON,
  },
  {
    file: "components/GitDialogChrome.tsx",
    line: '"Enter" && (event.metaKey || event.ctrlKey)',
    reason: MODIFIER,
  },
  {
    file: "components/automation/AutomationHeadingFields.tsx",
    line: '"Enter" && (event.metaKey || event.ctrlKey)',
    reason: MODIFIER,
  },
  {
    file: "components/chat/FileLineCommentBox.tsx",
    line: '"Enter" && (event.metaKey || event.ctrlKey)',
    reason: MODIFIER,
  },
  {
    file: "components/chat/MessagesTimeline.tsx",
    line: '"Enter" && (event.metaKey || event.ctrlKey)',
    reason: MODIFIER,
  },
  {
    file: "components/kanban/KanbanNewTaskDialog.tsx",
    line: '(event.metaKey || event.ctrlKey) && event.key === "Enter"',
    reason: MODIFIER,
  },
  {
    file: "components/pdf/PdfPageAnnotations.tsx",
    line: '"Enter" && (event.metaKey || event.ctrlKey)',
    reason: MODIFIER,
  },
  {
    file: "components/spaceTypes/design/DesignCanvasView.tsx",
    line: '(event.key === "Enter" && (event.metaKey || event.ctrlKey))',
    reason: MODIFIER,
  },
  {
    file: "components/spaceTypes/design/DesignInspector.tsx",
    line: '"Enter" && (event.metaKey || event.ctrlKey)',
    reason: MODIFIER,
  },
  {
    file: "routes/-automations.shared.tsx",
    line: '(event.metaKey || event.ctrlKey) && event.key === "Enter"',
    reason: MODIFIER,
  },
  {
    file: "components/tasks/TaskCard.tsx",
    line: '!(event.metaKey || event.ctrlKey) || event.key !== "Enter"',
    reason: MODIFIER,
  },
  {
    file: "components/terminal/terminalRuntime.ts",
    line: 'event.key === "Enter" &&',
    reason: "Shift+Enter only; xterm handles its own input method",
  },
  {
    file: "components/chat/ComposerCodexPowerPicker.tsx",
    line: 'event.key === "Enter"',
    reason: "on the power slider item, not a text field",
  },
  {
    file: "components/chat/ComposerModelPickerRow.tsx",
    line: 'event.key !== "Enter"',
    reason: "on a menu row, not a text field",
  },
  {
    file: "components/chat/MessageTrail.tsx",
    line: 'case "Enter":',
    reason: "roving list of trail ticks, not a text field",
  },
  {
    file: "components/preview/WorkbookPreview.tsx",
    line: 'case "Enter":',
    reason: "grid navigation; the cell input is guarded",
  },
  {
    file: "components/preview/WorkbookPreview.tsx",
    line: '["Tab", "Enter"].includes(',
    reason: "grid navigation; the cell input is guarded",
  },
  {
    file: "components/spaceTypes/slides/SlidesPresenter.tsx",
    line: 'event.key === "Enter"',
    reason: "presenter mode has no text field",
  },
  {
    file: "components/settings/ShortcutRecorderDialog.tsx",
    line: 'event.key === "Enter"',
    reason: "records keys; the dialog has no text field",
  },
  {
    file: "components/spaceTypes/design/DesignEditor.tsx",
    line: 'event.key === "Enter" && selection.',
    reason: "global handler that returns on input, textarea and contenteditable targets",
  },
  {
    file: "components/chat/ComposerPendingApprovalPanel.tsx",
    line: 'event.key === "Enter" && !(target instanceof HTMLButtonElement)',
    reason: "returns on input, textarea and contenteditable targets",
  },
  {
    file: "confirmDialogFallback.ts",
    line: 'e.key === "Enter"',
    reason: "its own modal holds focus; only buttons",
  },
  {
    file: "contextMenuFallback.ts",
    line: 'e.key === "Enter"',
    reason: "its own menu holds focus; only items",
  },
  {
    file: "components/chat/useChatComposerCommands.ts",
    line: 'key === "Enter"',
    reason: EDITOR_COMMANDS,
  },
  {
    file: "components/chat/useChatComposerCommands.ts",
    line: 'key === "Tab" || key === "Enter"',
    reason: EDITOR_COMMANDS,
  },
  {
    file: "components/kanban/useKanbanTaskComposerEditor.ts",
    line: 'key === "Enter"',
    reason: EDITOR_COMMANDS,
  },
  {
    file: "components/kanban/useKanbanTaskComposerEditor.ts",
    line: 'key === "Tab" || key === "Enter"',
    reason: EDITOR_COMMANDS,
  },
  {
    file: "components/chat/TranscriptSelectionAction.tsx",
    line: 'event.key !== "Enter") return;',
    reason: "swallows a held Enter after an action; acts on nothing",
  },
  {
    file: "components/chat/TranscriptSelectionAction.tsx",
    line: 'event instanceof KeyboardEvent && event.key !== "Enter"',
    reason: "releases the held-Enter swallow; acts on nothing",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !/\.(test|browser|visual)\./u.test(entry.name)
      ? [path]
      : [];
  });
}

interface EnterSite {
  readonly file: string;
  readonly lineNumber: number;
  readonly text: string;
}

function unguardedEnterSites(): EnterSite[] {
  const sites: EnterSite[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).replaceAll("\\", "/");
    if (IGNORED_FILES.has(file)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((text, index) => {
      if (!ENTER_SITE.test(text)) return;
      const handler = lines
        .slice(Math.max(0, index - GUARD_WINDOW_LINES), index + 1 + GUARD_LINES_AFTER)
        .join("\n");
      if (handler.includes("isImeComposingKeyEvent(")) return;
      sites.push({ file, lineNumber: index + 1, text: text.trim() });
    });
  }
  return sites;
}

describe("Enter handlers and input methods", () => {
  it("every Enter handler checks for an input-method key first, or is listed with a reason", () => {
    const unexplained = unguardedEnterSites().filter(
      (site) =>
        !ALLOWED_SITES.some(
          (allowed) => allowed.file === site.file && site.text.includes(allowed.line),
        ),
    );
    expect(
      unexplained.map((site) => `${site.file}:${site.lineNumber}  ${site.text}`),
      "Call isImeComposingKeyEvent(event) at the top of the handler (lib/imeKeyEvent.ts), or add the site to ALLOWED_SITES with the reason it cannot run while a text field is composing.",
    ).toEqual([]);
  });

  it("lists no site that is gone or now guarded", () => {
    const sites = unguardedEnterSites();
    const stale = ALLOWED_SITES.filter(
      (allowed) =>
        !sites.some((site) => site.file === allowed.file && site.text.includes(allowed.line)),
    );
    expect(stale.map((allowed) => `${allowed.file}  ${allowed.line}`)).toEqual([]);
  });
});
