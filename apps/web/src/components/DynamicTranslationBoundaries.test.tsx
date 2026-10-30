// FILE: DynamicTranslationBoundaries.test.tsx
// Purpose: Guards translation-skip boundaries around user and runtime supplied values.
// Layer: Web component rendering tests

import type { ServerLocalServerProcess } from "@synara/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./chat/AttachmentSummaryChip", () => ({
  AttachmentSummaryChip: ({ label, tooltip }: { label: string; tooltip: ReactNode }) => (
    <div>
      <span>{label}</span>
      {tooltip}
    </div>
  ),
}));

import { MossLocaleScope } from "../localization";
import { LocalServerIdentity } from "./LocalServerIdentity";
import { FileCommentsSummaryChip } from "./chat/FileCommentsSummaryChip";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ToolCallDetailsContent } from "./chat/ToolCallDetailsDialog";

const localServer = {
  id: "server-1",
  pid: 1234,
  command: "vite",
  displayName: "Vite",
  pageTitle: "Settings",
  cwd: "/tmp/Archive",
  args: "",
  ports: [],
  addresses: [],
  isStoppable: true,
} satisfies ServerLocalServerProcess;

describe("dynamic translation boundaries", () => {
  it("marks rendered comment labels and bodies as user-authored content", () => {
    const markup = renderToStaticMarkup(
      <FileCommentsSummaryChip
        comments={[{ path: "Settings", startLine: 1, endLine: 1, text: "Read" }]}
      />,
    );

    expect(markup).toContain('data-translation-skip="true">Settings line 1</p>');
    expect(markup).toContain('data-translation-skip="true">Read</p>');
  });

  it("protects rendered errors, local-server identity, and tool-returned paths", () => {
    const markup = renderToStaticMarkup(
      <>
        <ThreadErrorBanner error="Max" />
        <LocalServerIdentity server={localServer} tone="menu" />
        <ToolCallDetailsContent
          details={{ kind: "file-change", title: "Read", files: ["Read"] }}
          timestampFormat="24-hour"
        />
      </>,
    );

    expect(markup).toContain('title="Max" data-translation-skip="true">Max</p>');
    expect(markup).toContain('title="Settings" data-translation-skip="true">Settings</span>');
    expect(markup).toContain('data-translation-skip="true">localhost</span>');
    expect(markup).toContain('title="/tmp/Archive" data-translation-skip="true">Archive</span>');
    expect(markup).toContain('title="Read" data-translation-skip="true">Read</span>');
  });

  it("localizes known Antigravity thread errors without exposing raw diagnostics", () => {
    const stackPath = "/Users/moss/Codex/My Project/ProviderCommandReactor.ts:42:7";
    const requestId = "private-request-id";
    const rawError =
      "Error: Provider adapter validation failed (antigravity) in turn/start: " +
      `A prompt or file attachment is required. request id: ${requestId}\n` +
      `    at ${stackPath}`;
    const safeError = "服务商暂时无法完成此请求，请稍后重试。";
    const markup = renderToStaticMarkup(
      <MossLocaleScope locale="zh-CN">
        <ThreadErrorBanner error={rawError} />
      </MossLocaleScope>,
    );

    expect(markup).toContain(`title="${safeError}" data-translation-skip="true">${safeError}</p>`);
    expect(markup).not.toContain("Provider adapter validation failed");
    expect(markup).not.toContain("A prompt or file attachment is required");
    expect(markup).not.toContain(requestId);
    expect(markup).not.toContain(stackPath);
  });
});
