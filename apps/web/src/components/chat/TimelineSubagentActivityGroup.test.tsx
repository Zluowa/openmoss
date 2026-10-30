// FILE: TimelineSubagentActivityGroup.test.tsx
// Purpose: Lock the compact timeline subagent chip and aggregate-status contract.
// Layer: Web chat presentation tests

import { ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "../../localization";
import type { WorkLogSubagent } from "../../workLog";
import {
  resolveTimelineSubagentGroupStatus,
  resolveTimelineSubagentStatus,
  TimelineSubagentActivityGroup,
} from "./TimelineSubagentActivityGroup";

function subagent(overrides: Partial<WorkLogSubagent> = {}): WorkLogSubagent {
  return {
    threadId: "thread-default",
    ...overrides,
  };
}

function renderGroup(
  subagents: ReadonlyArray<WorkLogSubagent>,
  onOpenThread?: (threadId: ThreadId) => void,
  locale: "en" | "zh-CN" = "zh-CN",
): string {
  return renderToStaticMarkup(
    <MossLocaleScope locale={locale}>
      <TimelineSubagentActivityGroup
        groupId="group-1"
        subagents={subagents}
        {...(onOpenThread ? { onOpenThread } : {})}
      />
    </MossLocaleScope>,
  );
}

describe("TimelineSubagentActivityGroup status", () => {
  it.each([
    [
      "failed takes priority over active",
      subagent({ statusLabel: "failed", isActive: true, latestUpdate: "still running" }),
      "failed",
    ],
    ["explicit progress is progress", subagent({ rawStatus: "progress" }), "progress"],
    ["in_progress is active", subagent({ rawStatus: "in_progress" }), "active"],
    ["explicit updated is updated", subagent({ rawStatus: "updated" }), "updated"],
    ["stopped is interrupted", subagent({ rawStatus: "stopped" }), "interrupted"],
    ["explicit interrupted is interrupted", subagent({ rawStatus: "interrupted" }), "interrupted"],
    [
      "active update is updated",
      subagent({ rawStatus: "running", isActive: true, latestUpdate: "checking" }),
      "updated",
    ],
    ["active without update is started", subagent({ isActive: true }), "active"],
    ["queued is started", subagent({ rawStatus: "queued" }), "active"],
    ["connecting is started", subagent({ statusLabel: "Connecting" }), "active"],
    ["closed is finished", subagent({ statusLabel: "closed" }), "completed"],
    ["completed is finished", subagent({ rawStatus: "completed" }), "completed"],
    ["unknown uses the reference other branch", subagent({ rawStatus: "vendor_warmup" }), "active"],
  ] satisfies ReadonlyArray<[string, WorkLogSubagent, string]>)("%s", (_name, value, expected) => {
    expect(resolveTimelineSubagentStatus(value)).toBe(expected);
  });

  it("preserves failures across all rows and only completes fully settled groups", () => {
    expect(
      resolveTimelineSubagentGroupStatus([
        subagent({ rawStatus: "completed" }),
        subagent({ rawStatus: "failed" }),
        subagent({ rawStatus: "vendor_warmup" }),
        subagent({ rawStatus: "completed" }),
      ]),
    ).toBe("failed");
    expect(
      resolveTimelineSubagentGroupStatus([
        subagent({ rawStatus: "completed" }),
        subagent({ rawStatus: "vendor_warmup" }),
      ]),
    ).toBe("active");
    expect(
      resolveTimelineSubagentGroupStatus([
        subagent({ rawStatus: "completed" }),
        subagent({ rawStatus: "completed" }),
      ]),
    ).toBe("completed");
    expect(
      resolveTimelineSubagentGroupStatus([
        subagent({ rawStatus: "vendor_warmup" }),
        subagent({ isActive: true }),
      ]),
    ).toBe("active");
  });
});

describe("TimelineSubagentActivityGroup markup", () => {
  it("uses English labels in an English locale scope", () => {
    const markup = renderGroup(
      [subagent({ threadId: "provider-scout", resolvedThreadId: "scout", nickname: "Scout" })],
      () => {},
      "en",
    );

    expect(markup).toContain('aria-label="Open Scout subagent"');
    expect(markup).not.toContain("打开子智能体");
  });

  it("filters identity before applying the three-chip cap, overflow, and status", () => {
    const markup = renderGroup([
      subagent({ threadId: "provider-failed", rawStatus: "failed" }),
      subagent({ threadId: "one", nickname: "One", rawStatus: "completed" }),
      subagent({ threadId: "two", nickname: "Two", rawStatus: "completed" }),
      subagent({ threadId: "three", nickname: "Three", rawStatus: "completed" }),
      subagent({ threadId: "four", nickname: "Four", rawStatus: "completed" }),
    ]);

    expect(markup.match(/data-testid="subagent-avatar"/gu)).toHaveLength(3);
    expect(markup).toContain("One");
    expect(markup).toContain("Two");
    expect(markup).toContain("Three");
    expect(markup).not.toContain("Four");
    expect(markup).not.toContain("provider-failed");
    expect(markup).toContain("及其他 1 个子智能体");
    expect(markup).toContain("已完成");
    expect(markup).not.toContain("已中断");
  });

  it("opens only a resolved child and uses the primary-name accessible label", () => {
    const resolvedMarkup = renderGroup(
      [
        subagent({
          threadId: "provider-child",
          resolvedThreadId: "resolved-child",
          nickname: "Scout",
          role: "reviewer",
        }),
      ],
      () => {},
    );
    expect(resolvedMarkup).toContain('data-subagent-thread-id="resolved-child"');
    expect(resolvedMarkup).toContain('aria-label="打开子智能体 Scout"');
    expect(resolvedMarkup).toContain("<button");
    expect(resolvedMarkup).not.toContain("Scout [reviewer]");
    expect(resolvedMarkup).not.toContain("title=");

    const unresolvedMarkup = renderGroup(
      [subagent({ threadId: "provider-child", nickname: "Scout", role: "reviewer" })],
      () => {},
    );
    expect(unresolvedMarkup).toContain("<span");
    expect(unresolvedMarkup).not.toContain("<button");
    expect(unresolvedMarkup).not.toContain("data-subagent-thread-id");
  });

  it("does not render an identity-less row and preserves source identity for avatar/motion", () => {
    const markup = renderGroup(
      [
        subagent({
          threadId: "provider-scout",
          providerThreadId: "provider-scout",
          resolvedThreadId: "resolved-scout",
          nickname: "Scout",
          role: "explorer",
        }),
        subagent({ threadId: "raw-only", providerThreadId: "raw-only" }),
      ],
      () => {},
    );

    expect(markup.match(/data-testid="subagent-avatar"/gu)).toHaveLength(1);
    expect(markup).toContain('data-avatar-seed="provider-scout"');
    expect(markup).not.toContain('data-avatar-seed="raw-only"');
    expect(markup).not.toContain('data-animate-entrance=""');
    expect(markup).toContain('aria-label="打开子智能体 Scout"');
    expect(markup).not.toContain("Scout [explorer]");
    expect(markup).not.toContain("title=");
  });

  it("renders nothing when every row lacks a meaningful presentation identity", () => {
    expect(
      renderGroup([
        subagent({ threadId: "provider-one", rawStatus: "failed" }),
        subagent({ threadId: "provider-two", title: "provider-two" }),
      ]),
    ).toBe("");
  });

  it("keeps the provider avatar when the thread id is a hydrated Moss route", () => {
    const markup = renderGroup([
      subagent({
        threadId: "subagent:parent:provider-scout",
        providerThreadId: "provider-scout",
        resolvedThreadId: "subagent:parent:provider-scout",
        nickname: "Scout",
      }),
    ]);
    expect(markup).toContain('data-avatar-seed="provider-scout"');
    expect(markup).not.toContain('data-avatar-seed="subagent:parent:provider-scout"');
  });
});
