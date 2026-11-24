// WALK-6 N6-1 (seen again in WALK-12): the FULL reply read 「读了 README.md 下载」, a download link
// beside a file the agent only read. A reply offers 下载 only for a file its turn produced: one a
// file-change tool or the checkpoint diff names, or, in a folder without git, one the turn's
// commands created or wrote while it ran (the server's file times say which).

import "../../index.css";

import {
  MessageId,
  TurnId,
  type NativeApi,
  type ProjectStatThreadOutputFilesInput,
  type ProjectStatThreadOutputFilesResult,
} from "@moss/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { TimelineEntry, WorkLogEntry } from "../../workLog";
import { MessagesTimeline } from "./MessagesTimeline";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "zh-CN" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("zh-CN", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("zh-CN", key, values),
    }),
  };
});

const CWD = "/tmp/moss-walk/code";
const TURN_ID = TurnId.makeUnsafe("walk-full-turn");
const ASSISTANT_ID = MessageId.makeUnsafe("walk-full-reply");
const at = (second: number) =>
  `2026-11-24T11:0${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}.000Z`;

function work(
  second: number,
  entry: Omit<WorkLogEntry, "createdAt" | "tone" | "turnId">,
  turnId = TURN_ID,
) {
  return {
    id: `work:${entry.id}`,
    kind: "work" as const,
    createdAt: at(second),
    entry: { createdAt: at(second), tone: "tool" as const, turnId, ...entry },
  };
}

// The server's file times: README.md was last written weeks before the turn; the files the turn
// made were written during it.
const README_WRITTEN_MS = Date.parse("2026-10-30T09:00:00.000Z");
function fileTimes(path: string) {
  if (path.endsWith("/README.md"))
    return { modifiedAtMs: README_WRITTEN_MS, createdAtMs: README_WRITTEN_MS };
  if (path.endsWith("/report.xlsx") || path.endsWith("/CHANGELOG.md"))
    return { modifiedAtMs: Date.parse(at(9)), createdAtMs: Date.parse(at(9)) };
  return null;
}
const statThreadOutputFiles = vi.fn(
  async (
    input: ProjectStatThreadOutputFilesInput,
  ): Promise<ProjectStatThreadOutputFilesResult> => ({
    files: input.paths.map(fileTimes),
  }),
);

// The walker's FULL turn on Codex: read the README, patch index.js (here the patch also writes
// CHANGELOG.md, a file kind Moss offers to download), then look for missing.txt.
const TIMELINE_ENTRIES: TimelineEntry[] = [
  {
    id: "walk-full-prompt",
    kind: "message",
    createdAt: at(0),
    message: {
      id: MessageId.makeUnsafe("walk-full-prompt"),
      role: "user",
      text: "帮我看看这个项目，读一下说明，给 index.js 加减法和乘法，再看看 missing.txt WALK:FULL",
      turnId: TURN_ID,
      createdAt: at(0),
      streaming: false,
    },
  },
  work(2, {
    id: "ls",
    label: "Ran command",
    itemType: "command_execution",
    command: "/bin/bash -lc ls",
  }),
  work(4, {
    id: "cat-readme",
    label: "Ran command",
    itemType: "command_execution",
    command: "/bin/bash -lc 'cat README.md'",
  }),
  work(8, {
    id: "patch",
    label: "Edited files",
    itemType: "file_change",
    requestKind: "file-change",
    changedFiles: [`${CWD}/index.js`, `${CWD}/CHANGELOG.md`],
    fileChangeKinds: { [`${CWD}/index.js`]: "update", [`${CWD}/CHANGELOG.md`]: "add" },
  }),
  work(10, {
    id: "cat-missing",
    label: "Ran command",
    itemType: "command_execution",
    command: "/bin/bash -lc 'cat missing.txt'",
    toolStatus: "failed",
  }),
  {
    id: "walk-full-reply",
    kind: "message",
    createdAt: at(12),
    message: {
      id: ASSISTANT_ID,
      role: "assistant",
      text: `读了 [README.md](${CWD}/README.md)，并在 [index.js](${CWD}/index.js) 里加了减法和乘法，改动记在 [CHANGELOG.md](${CWD}/CHANGELOG.md)。missing.txt 不存在。`,
      turnId: TURN_ID,
      createdAt: at(12),
      completedAt: at(13),
      streaming: false,
    },
  },
];

beforeEach(() => {
  statThreadOutputFiles.mockClear();
  vi.stubGlobal("nativeApi", { projects: { statThreadOutputFiles } } as unknown as NativeApi);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const reply = (id: string) =>
  document.querySelector<HTMLElement>(`[data-chat-find-document-id="${id}"]`);
const downloadsIn = (id: string) => [
  ...(reply(id)?.querySelectorAll<HTMLElement>("[data-thread-output-download]") ?? []),
];
const downloadLabels = (id: string) =>
  downloadsIn(id).map((link) => link.getAttribute("aria-label"));

// The chip that asks the server has its answer, so a 下载 that would come late fails too.
async function fileTimesAnswered(path: string) {
  await expect
    .poll(() => statThreadOutputFiles.mock.calls.some(([input]) => input.paths.includes(path)))
    .toBe(true);
  await Promise.all(statThreadOutputFiles.mock.results.map((result) => result.value));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

it("WALK-6 N6-1: the reply offers 下载 beside the file its turn wrote, not beside the README.md it only read", async () => {
  await page.viewport(1100, 780);
  const screen = await render(
    <div style={{ width: 760, height: 700 }} className="flex flex-col">
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={TIMELINE_ENTRIES}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              ASSISTANT_ID,
              {
                turnId: TURN_ID,
                completedAt: at(13),
                assistantMessageId: ASSISTANT_ID,
                files: [
                  { path: "index.js", kind: "modified", additions: 8, deletions: 0 },
                  { path: "CHANGELOG.md", kind: "added", additions: 3, deletions: 0 },
                ],
              },
            ],
          ])
        }
        nowIso={at(14)}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={CWD}
        threadId="walk-full-thread"
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={CWD}
      />
    </div>,
  );
  try {
    await expect.poll(() => reply(ASSISTANT_ID)?.textContent ?? "").toContain("CHANGELOG.md");
    // One download, for the file the turn wrote.
    await expect.poll(() => downloadLabels(ASSISTANT_ID)).toEqual(["下载 CHANGELOG.md"]);
    await fileTimesAnswered(`${CWD}/README.md`);
    expect(downloadLabels(ASSISTANT_ID)).toEqual(["下载 CHANGELOG.md"]);
    const [download] = downloadsIn(ASSISTANT_ID) as [HTMLElement];
    expect(download.textContent).toBe("下载");
    const box = download.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    // README.md was only read: its name stays, with no 下载 after it.
    expect(reply(ASSISTANT_ID)!.textContent).toContain("读了 README.md，");
    expect(reply(ASSISTANT_ID)!.textContent).not.toContain("README.md下载");
  } finally {
    await screen.unmount();
  }
});

// A plain chat runs in Moss's own chat folder, which is not a git repository: the turn has no
// checkpoint diff, and the agent writes the workbook with a script, not with a file-change tool.
const CHAT_DIR = "/tmp/moss-walk/chat";
const SCRIPT_TURN_ID = TurnId.makeUnsafe("walk-script-turn");
const SCRIPT_REPLY_ID = MessageId.makeUnsafe("walk-script-reply");
const SCRIPT_TIMELINE_ENTRIES: TimelineEntry[] = [
  {
    id: "walk-script-prompt",
    kind: "message",
    createdAt: at(0),
    message: {
      id: MessageId.makeUnsafe("walk-script-prompt"),
      role: "user",
      text: "看一下 README.md，把里面的数据做成一个 Excel 表",
      turnId: SCRIPT_TURN_ID,
      createdAt: at(0),
      streaming: false,
    },
  },
  work(
    4,
    {
      id: "script-cat-readme",
      label: "Ran command",
      itemType: "command_execution",
      command: "/bin/bash -lc 'cat README.md'",
    },
    SCRIPT_TURN_ID,
  ),
  work(
    8,
    {
      id: "script-make-report",
      label: "Ran command",
      itemType: "command_execution",
      command: "/bin/bash -lc 'python make_report.py'",
    },
    SCRIPT_TURN_ID,
  ),
  {
    id: "walk-script-reply",
    kind: "message",
    createdAt: at(12),
    message: {
      id: SCRIPT_REPLY_ID,
      role: "assistant",
      text: `读了 [README.md](${CHAT_DIR}/README.md)，表格做好了：[report.xlsx](${CHAT_DIR}/report.xlsx)。`,
      turnId: SCRIPT_TURN_ID,
      createdAt: at(12),
      completedAt: at(13),
      streaming: false,
    },
  },
];

it("WALK-6 N6-1: in a folder without git, the reply offers 下载 beside the report.xlsx a command made, not beside the README.md it only read", async () => {
  await page.viewport(1100, 780);
  const screen = await render(
    <div style={{ width: 760, height: 700 }} className="flex flex-col">
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={SCRIPT_TIMELINE_ENTRIES}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={at(14)}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={CHAT_DIR}
        threadId="walk-script-thread"
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={CHAT_DIR}
      />
    </div>,
  );
  try {
    await expect.poll(() => reply(SCRIPT_REPLY_ID)?.textContent ?? "").toContain("report.xlsx");
    // One download, for the workbook the script wrote during the turn.
    await expect.poll(() => downloadLabels(SCRIPT_REPLY_ID)).toEqual(["下载 report.xlsx"]);
    await fileTimesAnswered(`${CHAT_DIR}/README.md`);
    expect(downloadLabels(SCRIPT_REPLY_ID)).toEqual(["下载 report.xlsx"]);
    const [download] = downloadsIn(SCRIPT_REPLY_ID) as [HTMLElement];
    expect(download.textContent).toBe("下载");
    const box = download.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(reply(SCRIPT_REPLY_ID)!.textContent).toContain("report.xlsx下载");
    // README.md was only read (written weeks before): its name stays, with no 下载 after it.
    expect(reply(SCRIPT_REPLY_ID)!.textContent).toContain("读了 README.md，");
    expect(reply(SCRIPT_REPLY_ID)!.textContent).not.toContain("README.md下载");
    // The times came from this thread's own folder.
    expect(statThreadOutputFiles.mock.calls.map(([input]) => input.threadId)).toContain(
      "walk-script-thread",
    );
  } finally {
    await screen.unmount();
  }
});
