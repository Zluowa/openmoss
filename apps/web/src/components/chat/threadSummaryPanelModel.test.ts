// FILE: threadSummaryPanelModel.test.ts
// Purpose: Locks output, source, subagent, and background-process rows used by the summary card.

import { describe, expect, it } from "vitest";

import {
  collectThreadSummaryArtifacts,
  collectThreadSummarySources,
  collectThreadSummarySubagents,
  collectThreadSummaryProcesses,
  selectThreadSummarySubagentPreview,
} from "./threadSummaryPanelModel";

describe("collectThreadSummaryArtifacts", () => {
  it("deduplicates newest file changes and assistant-linked outputs", () => {
    const artifacts = collectThreadSummaryArtifacts({
      diffSummaries: [
        {
          completedAt: "2026-07-10T10:00:00.000Z",
          files: [{ path: "docs/old.md" }, { path: "output/report.pdf" }],
        },
        {
          completedAt: "2026-07-10T11:00:00.000Z",
          files: [{ path: "output/report.pdf" }, { path: "src/new.ts" }],
        },
      ],
      assistantMessages: [
        {
          createdAt: "2026-07-10T12:00:00.000Z",
          text: "Ready: [preview](http://localhost:5733) and [report](output/report.pdf).",
        },
      ],
    });

    expect(artifacts.map((artifact) => artifact.target)).toEqual([
      "http://localhost:5733",
      "output/report.pdf",
      "src/new.ts",
      "docs/old.md",
    ]);
    expect(artifacts[0]).toMatchObject({ kind: "external", label: "localhost:5733" });
    expect(artifacts[1]).toMatchObject({ kind: "file", label: "report.pdf" });
  });
});

describe("collectThreadSummarySources", () => {
  const toolEntry = (id: string, createdAt: string) => ({
    id,
    createdAt,
    label: id,
    toolName: id,
    itemType: "mcp_tool_call" as const,
  });

  it("groups newest attached files, external links, tools, and web search like Codex", () => {
    const sources = collectThreadSummarySources({
      messages: [
        {
          role: "user",
          createdAt: "2026-07-24T10:00:00.000Z",
          text: "Use https://github.com/Emanuele-web04/moss",
          attachments: [
            { id: "env", type: "file", name: "(2).env" },
            {
              id: "shot",
              type: "image",
              name: "codex-clipboard.png",
              previewUrl: "/attachments/shot",
            },
          ],
        },
        {
          role: "user",
          createdAt: "2026-07-24T11:00:00.000Z",
          text: "Review [the same repo](https://github.com/Emanuele-web04/moss).",
          mentions: [{ name: "AGENTS.md", path: "/workspace/AGENTS.md" }],
        },
      ],
      workLogEntries: [
        {
          id: "tool-1",
          createdAt: "2026-07-24T11:10:00.000Z",
          label: "GitHub",
          toolName: "github",
          itemType: "mcp_tool_call",
        },
        {
          id: "web-1",
          createdAt: "2026-07-24T11:20:00.000Z",
          label: "Search",
          itemType: "web_search",
        },
      ],
    });

    expect(sources.map((source) => source.label)).toEqual([
      "AGENTS.md",
      "(2).env",
      "codex-clipboard.png",
      "the same repo",
      "github",
      "网页搜索",
    ]);
    expect(sources[2]).toMatchObject({ kind: "image", previewUrl: "/attachments/shot" });
    expect(sources[3]).toMatchObject({
      kind: "external",
      target: "https://github.com/Emanuele-web04/moss",
    });
  });

  it("keeps chronological work-log input on the linear newest-first path", () => {
    const sources = collectThreadSummarySources({
      messages: [],
      workLogEntries: [
        toolEntry("old-tool", "2026-07-24T10:00:00.000Z"),
        toolEntry("middle-tool", "2026-07-24T11:00:00.000Z"),
        toolEntry("new-tool", "2026-07-24T12:00:00.000Z"),
      ],
    });

    expect(sources.map((source) => source.label)).toEqual(["new-tool", "middle-tool", "old-tool"]);
  });

  it("sorts reverse and mixed timestamp input without assuming its order", () => {
    const reverseSources = collectThreadSummarySources({
      messages: [],
      workLogEntries: [
        toolEntry("new-tool", "2026-07-24T12:00:00.000Z"),
        toolEntry("old-tool", "2026-07-24T10:00:00.000Z"),
      ],
    });
    const mixedSources = collectThreadSummarySources({
      messages: [],
      workLogEntries: [
        toolEntry("middle-tool", "2026-07-24T11:00:00.000Z"),
        toolEntry("old-tool", "2026-07-24T10:00:00.000Z"),
        toolEntry("new-tool", "2026-07-24T12:00:00.000Z"),
      ],
    });

    expect(reverseSources.map((source) => source.label)).toEqual(["new-tool", "old-tool"]);
    expect(mixedSources.map((source) => source.label)).toEqual([
      "new-tool",
      "middle-tool",
      "old-tool",
    ]);
  });

  it("does not mutate the supplied work-log array or entries", () => {
    const entries = [
      toolEntry("old-tool", "2026-07-24T10:00:00.000Z"),
      toolEntry("new-tool", "2026-07-24T12:00:00.000Z"),
    ];
    const originalEntries = entries.map((entry) => ({ ...entry }));

    collectThreadSummarySources({ messages: [], workLogEntries: entries });

    expect(entries).toEqual(originalEntries);
  });

  it("preserves input order within equal-timestamp work-log runs", () => {
    const sources = collectThreadSummarySources({
      messages: [],
      workLogEntries: [
        toolEntry("first-tool", "2026-07-24T10:00:00.000Z"),
        toolEntry("second-tool", "2026-07-24T10:00:00.000Z"),
        toolEntry("new-tool", "2026-07-24T11:00:00.000Z"),
      ],
    });

    expect(sources.map((source) => source.label)).toEqual([
      "new-tool",
      "first-tool",
      "second-tool",
    ]);
  });
});

describe("collectThreadSummarySubagents", () => {
  it("keeps the newest state for each logical subagent", () => {
    const subagents = collectThreadSummarySubagents([
      {
        subagents: [
          { threadId: "thread-a", nickname: "Ada", isActive: true, statusLabel: "Working" },
        ],
      },
      {
        subagents: [
          { threadId: "thread-a", nickname: "Ada", isActive: false, statusLabel: "Done" },
          { threadId: "thread-b", role: "Reviewer", isActive: true },
        ],
      },
    ]);

    expect(subagents).toEqual([
      { id: "thread-a", label: "Ada", active: false, statusLabel: "Done" },
      { id: "thread-b", label: "Reviewer", active: true, statusLabel: "Working" },
    ]);
  });

  it("previews at most four working subagents before completed subagents", () => {
    const subagents = [
      { id: "done-a", label: "Done A", active: false, statusLabel: "Done" },
      { id: "working-a", label: "Working A", active: true, statusLabel: "Working" },
      { id: "working-b", label: "Working B", active: true, statusLabel: "Working" },
      { id: "working-c", label: "Working C", active: true, statusLabel: "Working" },
      { id: "working-d", label: "Working D", active: true, statusLabel: "Working" },
      { id: "working-e", label: "Working E", active: true, statusLabel: "Working" },
      { id: "done-b", label: "Done B", active: false, statusLabel: "Done" },
    ];

    expect(selectThreadSummarySubagentPreview(subagents)).toEqual({
      preview: subagents.slice(1, 5),
      workingCount: 5,
      doneCount: 2,
    });
  });

  it("falls back to four completed previews when no subagent is working", () => {
    const subagents = Array.from({ length: 5 }, (_, index) => ({
      id: `done-${index}`,
      label: `Done ${index}`,
      active: false,
      statusLabel: "Done",
    }));

    expect(selectThreadSummarySubagentPreview(subagents)).toEqual({
      preview: subagents.slice(0, 4),
      workingCount: 0,
      doneCount: 5,
    });
  });
});

describe("collectThreadSummaryProcesses", () => {
  it("shows running terminal processes only", () => {
    expect(
      collectThreadSummaryProcesses({
        terminalIds: ["one", "two"],
        runningTerminalIds: ["two"],
        terminalLabelsById: { one: "Terminal 1", two: "bun run electron:dev" },
      }),
    ).toEqual([{ id: "two", label: "bun run electron:dev", active: true }]);
  });
});
