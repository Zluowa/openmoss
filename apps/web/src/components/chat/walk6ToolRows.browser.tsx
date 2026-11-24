// FILE: walk6ToolRows.browser.tsx
// Purpose: WALK-6 rows H-5, H-7, H-8, H-9 and H-10. H-5, H-7 and H-10 run on the walker's own
//          records of the scripted Codex turn (WALK-7 state DB: Get-ChildItem; reasoning 「读说明」;
//          Get-Content README.md; apply_patch adding sub/mul to index.js by its absolute path;
//          Get-Content missing.txt failing inside the PowerShell -Command wrapper). Each case is
//          named after its row.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import { TurnId, type OrchestrationThreadActivity } from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "~/appSettings";
import { MossLocaleScope } from "~/localization";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";
import {
  walk7ProjectFolder,
  walk7Turn,
  walk7TurnActivities,
} from "../../test/fixtures/walk7CodexTurn.fixture";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { deriveAgentActivityTimelineState } from "./agentActivity.logic";
import { CommandShellDetails } from "./CommandShellDetails";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";
import { ToolCallGroupSummaryRow } from "./ToolCallGroupSummaryRow";
import { summarizeToolCallGroup } from "./toolCallGroup.logic";

const NOT_FOUND_ERROR =
  "Get-Content : 找不到路径“C:\\code\\missing.txt”，因为该路径不存在。\n" +
  "所在位置 行:1 字符: 1\n" +
  "+ Get-Content missing.txt\n" +
  "+ ~~~~~~~~~~~~~~~~~~~~~~~\n" +
  "    + CategoryInfo          : ObjectNotFound: (C:\\code\\missing.txt:String) [Get-Content], ItemNotFoundException\n" +
  "    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand\n";

/** The walker's WALK-7 turn, through the same derivation ChatView uses. */
const WALK7_ENTRIES: WorkLogEntry[] = deriveAgentActivityTimelineState(
  deriveWorkLogEntries(
    walk7TurnActivities as unknown as OrchestrationThreadActivity[],
    TurnId.makeUnsafe(walk7Turn.turnId),
    { latestTurnState: "completed", latestTurnCompletedAt: walk7Turn.completedAt },
  ),
).timelineWorkEntries;

function walk7Entry(what: string, test: (entry: WorkLogEntry) => boolean): WorkLogEntry {
  const entry = WALK7_ENTRIES.find(test);
  if (!entry) {
    const seen = WALK7_ENTRIES.map((item) => `${item.label} ${item.itemType ?? ""}`).join(", ");
    throw new Error(`no ${what} in the WALK-7 turn (entries: ${seen})`);
  }
  return entry;
}

const editEntry = walk7Entry("file change", (entry) => entry.itemType === "file_change");
const missingEntry = walk7Entry(
  "failed Get-Content missing.txt",
  (entry) => entry.itemType === "command_execution" && entry.toolStatus === "failed",
);
const narrationEntry = walk7Entry("reasoning 「读说明」", (entry) =>
  (entry.detail ?? "").includes("读说明"),
);
/** The turn's tool calls, as one work-log group holds them. */
const toolEntries = WALK7_ENTRIES.filter(
  (entry) => entry.itemType === "command_execution" || entry.itemType === "file_change",
);

const CASES = (["light", "dark"] as const).flatMap((theme) =>
  (["zh-CN", "en"] as const).map((locale) => ({ theme, locale })),
);

function Row(props: { entry: WorkLogEntry; locale: MossLocaleCode; projectFolder?: string }) {
  return (
    <BrowserThemeFixture>
      <MossLocaleScope locale={props.locale}>
        <div className="w-[640px] bg-background p-6 text-foreground" data-row-host="">
          <TimelineWorkEntryRow
            workEntry={props.entry}
            chatMetaFontSizePx={13}
            textFontSizePx={14}
            markdownCwd={props.projectFolder}
            onImageExpand={() => {}}
            timestampFormat="24-hour"
          />
        </div>
      </MossLocaleScope>
    </BrowserThemeFixture>
  );
}

/** sRGB colour of any computed value (rgb, color(srgb …), oklab, oklch, color-mix), read back
 *  from a 1 px canvas so the browser does the conversion. */
function parseColor(value: string): [number, number, number, number] {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, a! / 255];
}

function over(top: [number, number, number, number], under: [number, number, number]) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)) as [number, number, number];
}

function linearChannel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = linearChannel;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Text over the stacked backgrounds of its ancestors, as a person sees it. */
function contrastOf(element: HTMLElement): number {
  const layers: [number, number, number, number][] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const background = parseColor(getComputedStyle(node).backgroundColor);
    if (background[3] > 0) layers.push(background);
    if (background[3] >= 1) break;
  }
  let base: [number, number, number] = [255, 255, 255];
  for (const layer of layers.toReversed()) base = over(layer, base);
  const text = over(parseColor(getComputedStyle(element).color), base);
  const [high, low] = [luminance(text), luminance(base)].toSorted((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

describe.each(CASES)("WALK-6 tool rows ($theme, $locale)", ({ theme, locale }) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(900, 900);
  });
  afterEach(() => restoreTheme());

  it("H-5: 已编辑 index.js opens to the lines it added, not to an activity table", async () => {
    await render(<Row entry={editEntry} locale={locale} />);
    const trigger = document.querySelector<HTMLElement>("[data-file-change-row='true']")!;
    await userEvent.click(page.elementLocator(trigger));
    await expect.poll(() => document.querySelector("[data-tool-diff]")).not.toBeNull();
    const lines = [...document.querySelectorAll<HTMLElement>("[data-tool-diff] span")];
    const added = lines.filter((line) => line.textContent?.startsWith("+export const"));
    expect(added.map((line) => line.textContent)).toEqual([
      "+export const sub = (a, b) => a - b;",
      "+export const mul = (a, b) => a * b;",
    ]);
    const text = document.body.textContent ?? "";
    for (const label of [
      "开始时间",
      "最近活动",
      "已用时间",
      "Started",
      "Last activity",
      "Elapsed",
    ]) {
      expect(text).not.toContain(label);
    }
  });

  it("N11-3: the opened edit row names index.js inside the project and shows only the changed lines", async () => {
    // WALK-11 N11-3: the edit row of the finished turn, opened, showed the absolute path over
    // three lines beside an empty box, then raw `diff --git`, `---`, `+++` and `@@` lines.
    await render(<Row entry={editEntry} locale={locale} projectFolder={walk7ProjectFolder} />);
    const trigger = document.querySelector<HTMLElement>("[data-file-change-row='true']")!;
    await userEvent.click(page.elementLocator(trigger));
    await expect.poll(() => document.querySelector("[data-tool-diff]")).not.toBeNull();
    const details = document.querySelector<HTMLElement>("[data-tool-call-details]")!;
    const name = details.querySelector<HTMLElement>("[data-tool-diff] [data-tool-file-path]");
    expect(name, "the change names its file").not.toBeNull();
    expect(name!.textContent).toBe("index.js");
    // One line: the name's box is its line plus its padding.
    const style = getComputedStyle(name!);
    expect(name!.getBoundingClientRect().height).toBeLessThanOrEqual(
      Number.parseFloat(style.lineHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderBottomWidth) +
        0.5,
    );
    // No list of the same file above the change (the empty box with the absolute path).
    expect(details.querySelector("[data-tool-files]")).toBeNull();
    expect(details.textContent).not.toContain(walk7ProjectFolder);
    const lines = [...details.querySelectorAll<HTMLElement>("[data-tool-diff] pre span")].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      " export const add = (a, b) => a + b;",
      "+export const sub = (a, b) => a - b;",
      "+export const mul = (a, b) => a * b;",
    ]);
    for (const header of ["diff --git", "--- ", "+++ ", "@@"]) {
      expect(details.textContent).not.toContain(header);
    }
  });

  it("H-7: a failed read is not counted as read, and its row says the file was not found", async () => {
    // The group line as a person reads it: README.md counts as read, missing.txt does not.
    const summary = summarizeToolCallGroup(toolEntries)!;
    await render(
      <BrowserThemeFixture>
        <MossLocaleScope locale={locale}>
          <ToolCallGroupSummaryRow
            summary={summary}
            open={false}
            onToggle={() => {}}
            fontSizePx={14}
            renderChildren={() => null}
          />
        </MossLocaleScope>
      </BrowserThemeFixture>,
    );
    const groupLine = document.body.textContent ?? "";
    if (locale === "zh-CN") {
      expect(groupLine).toContain("读取了 1 个文件");
      expect(groupLine).not.toContain("读取了 2 个文件");
    } else {
      expect(groupLine).toMatch(/read a file/iu);
      expect(groupLine).not.toMatch(/read 2 files/iu);
    }

    await render(<Row entry={missingEntry} locale={locale} />);
    const row = document.querySelector<HTMLElement>("[data-work-entry-display-text='true']")!;
    const line = row.closest("p")!.textContent ?? "";
    expect(line).toBe(locale === "zh-CN" ? "没找到 missing.txt" : "Couldn't find missing.txt");
    expect(line).not.toMatch(/已读取|退出码|Read|exit/u);
  });

  it("H-8: a failed step's output opens at its top, the error sentence first, long lines wrapped", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="w-[480px] bg-background p-6">
          <CommandShellDetails
            command="Get-Content missing.txt"
            output={{ stderr: NOT_FOUND_ERROR.repeat(3), exitCode: 1 }}
            variant="embedded"
          />
        </div>
      </BrowserThemeFixture>,
    );
    const box = document.querySelector<HTMLElement>("[data-shell-output-scroll]")!;
    expect(box.getAttribute("data-shell-output-anchor")).toBe("top");
    expect(box.scrollTop).toBe(0);
    expect(box.getAttribute("data-shell-output-fade-top")).toBe("false");
    // The first visible line is the error sentence.
    const firstLine = box.innerText.split("\n")[0];
    expect(firstLine).toContain("Get-Content : ");
    // Nothing runs past the right edge: long lines wrap.
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  });

  it("H-9: shell output reads at 4.5:1 or more", async () => {
    await render(
      <BrowserThemeFixture>
        <div className="w-[480px] bg-background p-6">
          <CommandShellDetails
            command="Get-ChildItem -Name"
            output={{ stdout: "index.js\nREADME.md\n", exitCode: 0 }}
            variant="embedded"
          />
        </div>
      </BrowserThemeFixture>,
    );
    const output = document.querySelector<HTMLElement>("[data-shell-output-scroll]")!;
    expect(contrastOf(output)).toBeGreaterThanOrEqual(4.5);
    const commandLine = document.querySelector<HTMLElement>("[data-shell-command]")!;
    expect(contrastOf(commandLine)).toBeGreaterThanOrEqual(4.5);
  });

  it("WALK-7 rhythm: the edit row is as tall as a command row, so the work log steps evenly", async () => {
    const listEntry = walk7Entry(
      "Get-ChildItem",
      (entry) => entry.itemType === "command_execution" && entry.toolStatus === "completed",
    );
    await render(<Row entry={listEntry} locale={locale} />);
    await render(<Row entry={editEntry} locale={locale} />);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-row-host] > div")];
    expect(rows).toHaveLength(2);
    const [commandRow, editRow] = [rows[0]!, rows[1]!];
    const commandHeight = commandRow.getBoundingClientRect().height;
    const editHeight = editRow.getBoundingClientRect().height;
    expect(commandHeight).toBeGreaterThan(0);
    expect(editHeight).toBe(commandHeight);
  });

  it("H-10: a narration row opens to its text without repeating its title", async () => {
    await render(<Row entry={narrationEntry} locale={locale} />);
    const trigger = document.querySelector<HTMLElement>("[data-tool-detail-trigger='true']")!;
    await userEvent.click(page.elementLocator(trigger));
    await expect
      .poll(() => document.querySelector("[data-work-entry-narration-body]")?.textContent ?? "")
      .toBe("读一下 README.md。");
  });
});
