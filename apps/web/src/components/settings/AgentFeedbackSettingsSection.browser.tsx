// FILE: AgentFeedbackSettingsSection.browser.tsx
// Purpose: Covers the Settings agent-feedback list: friendly zh-CN tool labels, disclosure,
//   confirmed preview even when VITE_FEEDBACK_ENDPOINT is set, progress updates, and dismiss.

import "../../index.css";
import type {
  AgentFeedbackEntry,
  DevsReportPreview,
  DevsReportState,
  DevsReportSubmitInput,
  NativeApi,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { DevsReportConfirmDialog } from "~/components/chat/DevsReportConfirmDialog";
import { settleDevsReportConfirmation } from "~/components/chat/devsReportConfirmStore";
import { MossLocaleScope } from "~/localization";

import { AgentFeedbackSettingsSection } from "./AgentFeedbackSettingsSection";

const ENTRY: AgentFeedbackEntry = {
  id: "agent-feedback:0123456789abcdef0123456789abcdef",
  severity: "friction",
  summary: "更新页面时未说明支持的标题层级",
  details: "调用页面编辑工具后返回泛化错误。",
  tool: "moss_pages_mutate",
  proposedFix: "在报错中列出支持的标题层级。",
  providers: ["codex", "claudeAgent"],
  occurrences: 2,
  firstReportedAt: "2026-11-19T00:00:00.000Z",
  lastReportedAt: "2026-11-19T01:00:00.000Z",
  threadIds: [],
};

afterEach(() => {
  settleDevsReportConfirmation(false);
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="zh-CN">
        <AgentFeedbackSettingsSection />
        <DevsReportConfirmDialog />
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}

describe("AgentFeedbackSettingsSection", () => {
  it("renders friendly Chinese tool labels, previews before send even with VITE_FEEDBACK_ENDPOINT, and tracks progress", async () => {
    vi.stubEnv("VITE_FEEDBACK_ENDPOINT", "https://feedback.example.test/submit");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let reports: DevsReportState[] = [];
    const prepareDevsReport = vi.fn(
      async (input: DevsReportSubmitInput): Promise<DevsReportPreview> => ({
        id: input.id,
        scope: "application",
        engine: "codex",
        description: "更新页面时未说明支持的标题层级",
        context: "App version: 1.0.8",
        processedOutsideMainlandChina: true,
      }),
    );
    const submitDevsReport = vi.fn(async (input: DevsReportSubmitInput) => {
      reports = [
        {
          id: input.id,
          threadId: null,
          engine: "codex",
          status: "queued",
          description: "更新页面时未说明支持的标题层级",
          message: "",
          pullRequestUrl: null,
          createdAt: "2026-11-19T02:00:00.000Z",
          updatedAt: "2026-11-19T02:00:00.000Z",
          delivered: true,
        },
      ];
      return { delivered: true };
    });
    const dismiss = vi.fn(async () => undefined);
    vi.stubGlobal("nativeApi", {
      agentFeedback: {
        list: async () => ({ entries: [ENTRY] }),
        dismiss,
      },
      server: {
        listDevsReports: async () => ({ configured: true, reports }),
        prepareDevsReport,
        submitDevsReport,
      },
    } as unknown as NativeApi);

    await page.viewport(1100, 780);
    const view = await renderSection();

    const list = page.getByRole("list", { name: "智能体反馈" });
    await expect.element(list).toBeVisible();
    const row = page.getByRole("listitem");
    await expect.element(row).toBeVisible();

    // Expand the row: shows friendly Chinese tool label, NOT raw snake_case identifier.
    await page.getByRole("button", { name: /更新页面时未说明支持的标题层级/ }).click();
    await expect.element(page.getByText("调用页面编辑工具后返回泛化错误。")).toBeVisible();
    await expect.element(page.getByText(/更新页面 · /)).toBeVisible();
    expect(document.body.textContent).not.toContain("moss_pages_mutate");

    // Clicking Send opens the confirmation dialog with mainland-China notice and never bypasses it.
    await row.getByRole("button", { name: "发送", exact: true }).click();
    await expect.element(page.getByTestId("devs-report-description")).toBeVisible();
    await expect.element(page.getByTestId("devs-report-outside-china")).toBeVisible();
    expect(submitDevsReport).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Cancelling leaves the note unsent.
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(submitDevsReport).not.toHaveBeenCalled();

    // Confirming submits via the developer outbox and shows the report progress badge.
    await row.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "发送", exact: true }).click();
    await vi.waitFor(() => expect(submitDevsReport).toHaveBeenCalledOnce());
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect.element(page.getByTestId("agent-feedback-progress")).toBeVisible();

    await view.unmount();
  });

  it("restores the row when dismissing fails on the server", async () => {
    const dismiss = vi.fn(async () => {
      throw new Error("disk error");
    });
    vi.stubGlobal("nativeApi", {
      agentFeedback: {
        list: async () => ({ entries: [ENTRY] }),
        dismiss,
      },
      server: {
        listDevsReports: async () => ({ configured: true, reports: [] }),
      },
    } as unknown as NativeApi);

    await page.viewport(1100, 780);
    const view = await renderSection();

    await page.getByRole("button", { name: /更新页面时未说明支持的标题层级/ }).click();
    await page.getByRole("button", { name: "忽略", exact: true }).click();
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith({ id: ENTRY.id }));
    // Still present after rollback.
    await expect.element(page.getByText("更新页面时未说明支持的标题层级")).toBeVisible();

    await view.unmount();
  });
});
