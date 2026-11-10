// FILE: ClaudeSameSession.browser.tsx
// Purpose: Renders, in Moss, the same content a real Claude desktop demo session showed
//   (tool runs, a failed command, an edit, a chapter, a settled wrap-up, a peer message, a
//   markdown showcase, a session link, a plan) in the dark theme at Claude's column width,
//   and saves the screenshot for a side-by-side check against the captured Claude window.
import "../../index.css";

import { MessageId, ThreadId } from "@moss/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../theme/theme.logic";
import { useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import type { WorkLogEntry } from "../../workLog";
import ChatMarkdown from "../ChatMarkdown";
import { summarizeToolCallGroup } from "./toolCallGroup.logic";
import { ToolCallGroupSummaryRow } from "./ToolCallGroupSummaryRow";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChapterHeading } from "./transcript/ChapterHeading";
import { CodeRunContext } from "./transcript/codeRun";
import { TranscriptMarkdownContext } from "./transcript/externalImageHosts";
import { PeerMessageCard } from "./transcript/PeerMessageCard";
import { WrapUpSettledCard } from "./transcript/WrapUpBox";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("en", key, values),
    }),
  };
});

const motion = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};
const PARENT = ThreadId.makeUnsafe("thread-render-parent");
const at = "2026-11-04T12:11:23.000Z";

function entry(overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return { createdAt: at, label: "Tool call", tone: "tool", ...overrides };
}

function newFilePatch(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `+line ${index + 1}`).join("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
}

const TURN_1_TOOLS: WorkLogEntry[] = [
  entry({
    id: "w1",
    itemType: "file_change",
    changedFiles: ["notes.md"],
    fileChangeKinds: { "notes.md": "add" },
    toolName: "Write",
    toolDetails: { kind: "file-change", title: "Write", diff: newFilePatch("notes.md", 10) },
  }),
  entry({
    id: "w2",
    itemType: "file_change",
    changedFiles: ["parser.ts"],
    fileChangeKinds: { "parser.ts": "add" },
    toolName: "Write",
    toolDetails: { kind: "file-change", title: "Write", diff: newFilePatch("parser.ts", 6) },
  }),
  entry({
    id: "r1",
    itemType: "dynamic_tool_call",
    toolName: "Read",
    detail: `Read: ${JSON.stringify({ file_path: "notes.md" })}`,
  }),
  entry({
    id: "r2",
    itemType: "dynamic_tool_call",
    toolName: "Read",
    detail: `Read: ${JSON.stringify({ file_path: "parser.ts" })}`,
  }),
  entry({ id: "g1", itemType: "command_execution", command: 'rg -n "header" .' }),
  entry({ id: "g2", itemType: "command_execution", command: "rg --files -g *.ts" }),
  entry({ id: "c1", itemType: "command_execution", command: "node --version" }),
  entry({
    id: "c2",
    itemType: "command_execution",
    command: 'node -e "process.exit(3)"',
    toolStatus: "failed",
  }),
];

const TURN_1_REPLY =
  'I did all six steps in `D:\\ceshi\\claude-render-demo-20261104\\`: I created [notes.md](claude-render-demo-20261104/notes.md) and [parser.ts](claude-render-demo-20261104/parser.ts), read them back, searched the folder and listed the `.ts` files, then renamed `readHeader` to `readHeaderOnce` and marked the \u201cDemo tools\u201d chapter. `node --version` returned v24.19.0, and `node -e "process.exit(3)"` failed with exit code 3 as planned. I didn\u2019t retry it.';

const TURN_2_REPLY = [
  "## Parser notes",
  "",
  "The parser sync runs at 15:00 PST and again at 9:30am UTC+8, and both runs use the same header rules.",
  "",
  "- The first line is the header",
  "- Blank lines are skipped",
  "- Comments start with a hash sign",
  "",
  "1. Split the input into lines",
  "2. Read the header with `readHeaderOnce`",
  "3. Parse the remaining lines into records",
  "",
  "| Step | Result |",
  "| --- | --- |",
  "| Create files | notes.md and parser.ts written |",
  "| Run node | v24.19.0, then exit code 3 |",
  "| Rename | `readHeader` \u2192 `readHeaderOnce` |",
  "",
  "> A small, pure parser is easier to test than a clever one.",
  "",
  "```bash",
  "$ bun install",
  "$ bun run test",
  "```",
  "",
  "```typescript",
  "export function readHeaderOnce(text: string): string[] {",
  '  const firstLine = text.split(/\\r?\\n/)[0] ?? "";',
  '  return firstLine.split(",").map((field) => field.trim());',
  "}",
  "```",
  "",
  "https://github.com/Zluowa/moss-synara/pull/382",
  "",
  "![Build graph](https://raw.githubusercontent.com/github/explore/main/topics/typescript/typescript.png)",
  "",
  `Fake token (not a real one): \`ghp_${"a".repeat(36)}\``,
].join("\n");

const TURN_3_REPLY = `Of the two ways to skip a UTF-8 byte-order mark, removing a leading U+FEFF inside \`readHeaderOnce\` is safer than relying on whoever decodes the file to drop it, because it works however the text was decoded and is harmless if there is no BOM. I\u2019ve told [Claude \u684c\u9762\u7aef\u5bf9\u8bdd\u6e32\u67d3\u529f\u80fd](moss://thread/${PARENT}) that the demo has reached turn 3.`;

let previousRootStyle: string | null;
beforeEach(async () => {
  previousRootStyle = document.documentElement.getAttribute("style");
  const { variables } = buildThemeCssVariables(
    resolveThemePack(DEFAULT_THEME_STATE, "dark"),
    "dark",
  );
  for (const [name, value] of Object.entries(variables)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.documentElement.classList.add("dark");
  await page.viewport(760, 900);
  await motion.emulateReducedMotion("reduce");
  useStore.setState((state) => ({
    sidebarThreadSummaryById: {
      ...state.sidebarThreadSummaryById,
      [PARENT]: {
        id: PARENT,
        title: "Claude \u684c\u9762\u7aef\u5bf9\u8bdd\u6e32\u67d3\u529f\u80fd",
        session: null,
        latestTurn: null,
        createdAt: at,
      } as unknown as SidebarThreadSummary,
    },
  }));
});
afterEach(async () => {
  document.documentElement.classList.remove("dark");
  if (previousRootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", previousRootStyle);
  await motion.emulateReducedMotion("no-preference");
});

it("draws the Claude demo session's content the Moss way, for a side-by-side check", async () => {
  const turn1 = summarizeToolCallGroup(TURN_1_TOOLS)!;
  await render(
    <div
      style={{ width: 704, padding: "16px 16px 32px", background: "var(--background)" }}
      className="flex flex-col gap-3 text-foreground"
      data-same-session=""
    >
      <CodeRunContext.Provider value={{ runInTerminal: () => {}, shell: "powershell" }}>
        <TranscriptMarkdownContext.Provider value>
          <section data-section="turn1" className="flex flex-col gap-3">
            <ToolCallGroupSummaryRow
              summary={turn1}
              open={false}
              onToggle={() => {}}
              fontSizePx={14}
              renderChildren={() => null}
              diffEntries={TURN_1_TOOLS}
              onViewChanges={() => {}}
            />
            <ChatMarkdown
              text={"That command failed on purpose with exit code 3, so I won\u2019t retry it."}
              cwd="/repo"
              isStreaming={false}
            />
            <ChapterHeading messageId="same-session-chapter" title="Demo tools" />
            <ChatMarkdown text={TURN_1_REPLY} cwd="/repo" isStreaming={false} />
            <WrapUpSettledCard
              box={{
                recap:
                  "The demo folder now holds notes.md and parser.ts, and readHeader is renamed to readHeaderOnce. node --version worked; the exit-3 command failed on purpose. Nothing is committed.",
                ask: "Keep the demo files?",
                actions: ["Keep them", "Delete them"],
              }}
              answer={null}
            />
          </section>
          <section data-section="turn2" className="flex flex-col gap-3">
            <PeerMessageCard
              messageId={MessageId.makeUnsafe("agent:same-session:peer")}
              sourceThreadId={PARENT}
              textLength={80}
              onOpenThread={() => {}}
            >
              <p>Turn 2: reply with one markdown showcase.</p>
            </PeerMessageCard>
            <ChatMarkdown text={TURN_2_REPLY} cwd="/repo" isStreaming={false} />
          </section>
          <section data-section="turn3" className="flex flex-col gap-3">
            <ChatMarkdown
              text={TURN_3_REPLY}
              cwd="/repo"
              isStreaming={false}
              onOpenThread={() => {}}
            />
            <ProposedPlanCard
              planMarkdown={
                "# Skip the byte-order mark\n\n1. In `readHeaderOnce`, drop a leading `\\uFEFF` from `text` before splitting it into lines.\n2. Leave the line splitting and per-field `trim()` as they are.\n3. Verify with `node`: input with a BOM and input without one both give the same header."
              }
              cwd="/repo"
              workspaceRoot={undefined}
              chatTypographyStyle={{}}
            />
          </section>
        </TranscriptMarkdownContext.Provider>
      </CodeRunContext.Provider>
    </div>,
  );
  await expect.poll(() => document.body.textContent).toContain("Parser notes");
  for (const section of ["turn1", "turn2", "turn3"]) {
    const element = document.querySelector<HTMLElement>(`[data-section="${section}"]`)!;
    element.scrollIntoView({ block: "start" });
    await page.screenshot({
      element,
      path: `../../../../../.tmp/ui-parity/claude-transcript/moss-same-session-${section}.png`,
    });
  }
});
