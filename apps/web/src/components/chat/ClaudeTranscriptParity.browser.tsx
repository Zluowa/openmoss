// FILE: ClaudeTranscriptParity.browser.tsx
// Purpose: Renders the desktop-chat transcript pieces Moss now draws (peer message line,
//          live thread chip, counted tool line with a solid caret, PR chip, redacted
//          credential) in a real browser, checks their computed geometry, and saves
//          screenshots for side-by-side comparison with the Claude desktop app.
// Layer: Browser parity test

import "../../index.css";

import { MessageId, ThreadId } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { TranscriptSelectionAction } from "./TranscriptSelectionAction";
import { ChapterHeading } from "./transcript/ChapterHeading";
import { CodeRunContext } from "./transcript/codeRun";
import { TranscriptMarkdownContext } from "./transcript/externalImageHosts";
import { PeerMessageCard } from "./transcript/PeerMessageCard";
import { RewindMarker } from "./transcript/RewindMarker";
import { setTranscriptDisclosureOpen } from "./transcript/TranscriptDisclosureRow";
import { WrapUpLiveBox } from "./transcript/WrapUpBox";

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

const SENDER = ThreadId.makeUnsafe("thread-moss-lookup");
const shot = (name: string) =>
  page.screenshot({ path: `../../../../../.tmp/ui-parity/claude-transcript/moss-${name}.png` });
const motion = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};

function seedThread(id: ThreadId, title: string) {
  useStore.setState((state) => ({
    sidebarThreadSummaryById: {
      ...state.sidebarThreadSummaryById,
      [id]: {
        id,
        title,
        session: null,
        latestTurn: null,
        createdAt: "2026-11-04T00:00:00.000Z",
      } as unknown as SidebarThreadSummary,
    },
  }));
}

const sendMessage = (id: string, threadId: string): WorkLogEntry => ({
  id,
  createdAt: "2026-11-04T00:00:00.000Z",
  label: "Tool call",
  tone: "tool",
  itemType: "mcp_tool_call",
  toolName: "moss_send_message",
  detail: `moss_send_message: ${JSON.stringify({ threadId, message: "hi" })}`,
});

let previousRootStyle: string | null;
beforeEach(async () => {
  previousRootStyle = document.documentElement.getAttribute("style");
  const { variables } = buildThemeCssVariables(
    resolveThemePack(DEFAULT_THEME_STATE, "light"),
    "light",
  );
  for (const [name, value] of Object.entries(variables))
    document.documentElement.style.setProperty(name, value);
  await page.viewport(960, 720);
  await motion.emulateReducedMotion("reduce");
  seedThread(SENDER, "Moss Synara 查找");
});
afterEach(async () => {
  if (previousRootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", previousRootStyle);
  await motion.emulateReducedMotion("no-preference");
});

describe("Claude transcript parity", () => {
  it("draws a peer message as one quiet collapsible line", async () => {
    const screen = await render(
      <div style={{ width: 736, padding: 24 }} className="text-size-chat">
        <PeerMessageCard
          messageId={MessageId.makeUnsafe("agent:parity:message")}
          sourceThreadId={SENDER}
          textLength={64}
          onOpenThread={() => {}}
        >
          <p>新主管已经接手浏览器面板的工作，正在重建画布并打新的安装包。</p>
        </PeerMessageCard>
      </div>,
    );
    const line = document.querySelector("[data-transcript-disclosure]")!;
    expect(line.textContent).toContain("Received message from");
    // The sender in the line is an underlined text link; pills are for reply text.
    const sender = line.querySelector<HTMLElement>('[data-thread-link="live"]')!;
    expect(sender.textContent).toContain("Moss Synara 查找");
    expect(getComputedStyle(sender).textDecorationLine).toContain("underline");
    const caret = line.querySelector<HTMLElement>("[data-transcript-disclosure-toggle] span")!;
    // A 12px box painted at Moss's global 1.14 glyph scale matches the desktop chat's 14px caret glyph.
    expect(caret.offsetWidth).toBe(12);
    expect(document.querySelector("[data-peer-message-body]")).toBeNull();
    await shot("peer-collapsed");

    await screen.getByRole("button", { name: "Show message from Moss Synara 查找" }).click();
    await expect.poll(() => document.querySelector("[data-peer-message-body]")).not.toBeNull();
    await shot("peer-expanded");
    setTranscriptDisclosureOpen("peer:agent:parity:message", false);
  });

  it("reads a tool run in counted words with a solid caret and no glyph", async () => {
    const summary = summarizeToolCallGroup([
      sendMessage("m1", "thread-a"),
      sendMessage("m2", "thread-b"),
    ])!;
    await render(
      <div style={{ width: 736, padding: 24 }}>
        <ToolCallGroupSummaryRow
          summary={summary}
          open={false}
          onToggle={() => {}}
          fontSizePx={14}
          renderChildren={() => null}
        />
      </div>,
    );
    const row = document.querySelector("[data-tool-group-disclosure]")!;
    expect(row.textContent).toContain("Messaged 2 other chats");
    expect(row.querySelector("[data-tool-group-icon]")).toBeNull();
    expect(row.querySelector("[data-tool-group-caret]")).not.toBeNull();
    await shot("tool-group");
  });

  it("draws thread links, PR links and credentials inside a reply", async () => {
    const token = `ghp_${"a1".repeat(18)}`;
    await render(
      <div style={{ width: 736, padding: 24 }}>
        <ChatMarkdown
          text={[
            `The [lookup](moss://thread/${SENDER}) session will check the balance first.`,
            "",
            "The session that built https://github.com/Zluowa/moss-synara/pull/360 had no unfinished changes.",
            "",
            `Set \`${token}\` before you push.`,
          ].join("\n")}
          cwd="/repo"
          isStreaming={false}
          onOpenThread={() => {}}
        />
      </div>,
    );
    await expect
      .poll(() => document.querySelector('[data-thread-chip="live"]')?.textContent)
      .toContain("Moss Synara 查找");
    expect(document.querySelector('[data-forge-ref-chip="pull"]')?.textContent).toContain(
      "Zluowa/moss-synara#360",
    );
    expect(document.querySelector('[data-redacted-secret="hidden"]')?.textContent).toContain(
      "Redacted GitHub token",
    );
    expect(document.body.textContent).not.toContain(token);
    await shot("reply-chips");
  });

  it("offers Start a side chat and Reply on a selection", async () => {
    await render(
      <div style={{ width: 736, padding: 24 }}>
        <p data-testid="passage">
          The parser reads the header once and keeps the offsets stable across retries.
        </p>
        <TranscriptSelectionAction
          left={260}
          top={120}
          placement="bottom"
          onReply={() => {}}
          onAddToSide={() => {}}
        />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: "Start a side chat" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reply" })).toBeVisible();
    await shot("selection-toolbar");
  });

  it("draws the wrap-up box, a chapter heading and the rewind marker", async () => {
    await render(
      <div style={{ width: 736, padding: 24 }} className="flex flex-col gap-4">
        <ChapterHeading messageId="parity-chapter" title="Parser cleanup" onRename={() => {}} />
        <p>The parser now reads the header once.</p>
        <WrapUpLiveBox
          box={{
            recap:
              "The parser reads the header once and the tests pass. Nothing is committed yet, and the CLI path is not checked.",
            ask: "Commit the parser change?",
            actions: ["Yes, commit", "Not yet"],
          }}
          onAnswer={async () => true}
        />
        <RewindMarker />
      </div>,
    );
    await expect.element(page.getByRole("button", { name: "Yes, commit" })).toBeVisible();
    expect(document.body.textContent).toContain("Parser cleanup");
    await shot("wrap-up-chapter-rewind");
  });

  it("adds Run in terminal, a Show Image box and a local-time underline to a reply", async () => {
    const zone = -new Date().getTimezoneOffset() === 180 ? "UTC" : "UTC+3";
    await render(
      <div style={{ width: 736, padding: 24 }}>
        <CodeRunContext.Provider value={{ runInTerminal: () => {}, shell: "powershell" }}>
          <TranscriptMarkdownContext.Provider value>
            <ChatMarkdown
              text={[
                `The deploy window opens at 15:00 ${zone}.`,
                "",
                "![Build graph](https://img.example.com/build-graph.png)",
                "",
                "```powershell",
                "PS> bun install",
                "PS> bun run test",
                "```",
              ].join("\n")}
              cwd="/repo"
              isStreaming={false}
            />
          </TranscriptMarkdownContext.Provider>
        </CodeRunContext.Provider>
      </div>,
    );
    await expect.element(page.getByRole("button", { name: "Run in PowerShell" })).toBeVisible();
    expect(document.querySelector("[data-external-image]")?.textContent).toBe("Show Image");
    expect(document.querySelector("[data-zoned-time]")?.textContent).toBe(`15:00 ${zone}`);
    await shot("markdown-extras");
  });
});
