// FILE: ThreadSummaryPanel.test.tsx
// Purpose: Server-rendered component contracts for the Codex-style thread summary.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThreadSummaryInlinePanel, ThreadSummaryPanelContent } from "./ThreadSummaryPanel";

describe("ThreadSummaryPanelContent", () => {
  it("publishes measured geometry, expanded section, and output-menu accessibility contracts", () => {
    const markup = renderToStaticMarkup(
      <ThreadSummaryPanelContent
        artifacts={[]}
        sources={[
          { id: "env", label: "(2).env", kind: "file" },
          {
            id: "shot",
            label: "codex-clipboard.png",
            kind: "image",
            previewUrl: "/attachments/shot",
          },
          {
            id: "repo",
            label: "github.com/Emanuele-web04/moss",
            kind: "external",
            target: "https://github.com/Emanuele-web04/moss",
          },
          { id: "hidden", label: "fourth-source.txt", kind: "file" },
        ]}
        subagents={[]}
        processes={[]}
        onCreateOutput={vi.fn()}
        onAddSources={vi.fn()}
        onConnectApps={vi.fn()}
        onOpenSource={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="thread-summary-panel"');
    expect(markup).toContain('data-pip-obstacle="thread-summary-panel"');
    expect(markup).toContain('data-panel-width="300"');
    expect(markup).toContain('data-overlay-radius="20"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="任务摘要"');
    expect(markup).toContain("bg-[var(--color-background-elevated-primary-opaque)]");
    expect(markup).toContain('data-section-key="artifacts"');
    expect(markup).toContain('data-default-open="true"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="创建文件或站点"');
    expect(markup).toContain('data-section-key="tool-sources"');
    expect(markup).toContain("来源");
    expect(markup).toContain('aria-label="附加文件或连接应用"');
    expect(markup).toContain("查看全部");
    expect(markup).toContain("github.com/Emanuele-web04/moss");
    expect(markup).not.toContain("fourth-source.txt");
    expect(markup).toContain("text-ui-lg");
  });

  it("caps the compact subagent avatar preview at four", () => {
    const subagents = Array.from({ length: 5 }, (_, index) => ({
      id: `agent-${index}`,
      label: `Agent ${index}`,
      active: true,
      statusLabel: "Working",
    }));
    const markup = renderToStaticMarkup(
      <ThreadSummaryPanelContent
        artifacts={[]}
        sources={[]}
        subagents={subagents}
        processes={[]}
        onOpenSubagent={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="打开子智能体"');
    expect(markup).toContain('data-preview-count="4"');
    expect(markup).toContain("5 个处理中");
  });
});

describe("ThreadSummaryInlinePanel", () => {
  it("uses the shared disclosure motion and removes collapsed content from tab order", () => {
    const collapsedMarkup = renderToStaticMarkup(
      <ThreadSummaryInlinePanel visible={false}>
        <button type="button">Create output</button>
      </ThreadSummaryInlinePanel>,
    );

    expect(collapsedMarkup).toContain('data-state="closed"');
    expect(collapsedMarkup).toContain('data-transition-type="disclosure"');
    expect(collapsedMarkup).toContain('data-transition-duration-ms="220"');
    expect(collapsedMarkup).toContain('aria-hidden="true"');
    expect(collapsedMarkup).toContain('inert=""');
    expect(collapsedMarkup).toContain("translate-x-full");
    expect(collapsedMarkup).toContain("scale-[0.8]");
    expect(collapsedMarkup).toContain("duration-[220ms]");

    const expandedMarkup = renderToStaticMarkup(
      <ThreadSummaryInlinePanel visible>
        <button type="button">Create output</button>
      </ThreadSummaryInlinePanel>,
    );

    expect(expandedMarkup).toContain('data-state="open"');
    expect(expandedMarkup).not.toContain("inert=");
    expect(expandedMarkup).toContain("translate-x-0");
    expect(expandedMarkup).toContain("scale-100");
  });
});
