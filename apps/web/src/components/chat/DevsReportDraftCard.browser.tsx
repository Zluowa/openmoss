import "../../index.css";

import {
  ThreadId,
  type DevsReportDraftActivityPayload,
  type DevsReportPreview,
  type DevsReportState,
  type DevsReportSubmitInput,
  type NativeApi,
} from "@moss/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "../../localization";
import { DevsReportConfirmDialog } from "./DevsReportConfirmDialog";
import { DevsReportDraftCard } from "./DevsReportDraftCard";

const threadId = ThreadId.makeUnsafe("draft-chat");
const draft: DevsReportDraftActivityPayload = {
  draftId: `devs-draft:${"ab".repeat(16)}`,
  summary: "Codex 回复到一半就停了",
  details: "连续三次都在同一处停下，界面一直显示正在思考。",
};
const reportId = "abababab-abab-abab-abab-abababababab";
const preview: DevsReportPreview = {
  id: reportId,
  scope: "thread",
  engine: "codex",
  description: `${draft.summary}\n\n${draft.details}`,
  context: "Provider: codex\nSession status: error",
  processedOutsideMainlandChina: false,
};
const sentReport: DevsReportState = {
  id: reportId,
  threadId,
  engine: "codex",
  status: "queued",
  description: preview.description,
  message: "Queued",
  pullRequestUrl: null,
  createdAt: "2026-11-20T12:00:00.000Z",
  updatedAt: "2026-11-20T12:00:00.000Z",
};

function installServer(initiallySent = false) {
  let sent = initiallySent;
  const server = {
    prepareDevsReport: vi.fn(async (_input: DevsReportSubmitInput) => preview),
    submitDevsReport: vi.fn(async (_input: DevsReportSubmitInput) => {
      sent = true;
      return sentReport;
    }),
    listDevsReports: vi.fn(async () => ({
      configured: true,
      reports: sent ? [sentReport] : [],
    })),
  };
  vi.stubGlobal("nativeApi", { server } as unknown as NativeApi);
  return server;
}

afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <MossLocaleScope locale="zh-CN">
      <DevsReportDraftCard draft={draft} threadId={threadId} />
      <DevsReportConfirmDialog />
    </MossLocaleScope>,
  );

it("shows the agent's draft and sends it only after the person confirms the exact report", async () => {
  const server = installServer();
  const screen = await mount();
  await expect.element(screen.getByText(draft.summary)).toBeVisible();
  await expect.element(screen.getByText("由智能体起草，你确认后才会发送。")).toBeVisible();

  await screen.getByRole("button", { name: "查看报告" }).click();
  await expect
    .element(screen.getByTestId("devs-report-description"))
    .toHaveTextContent(draft.summary);
  await screen.getByRole("button", { name: "取消" }).click();
  expect(server.submitDevsReport).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "查看报告" })).toBeEnabled();

  await screen.getByRole("button", { name: "查看报告" }).click();
  await screen.getByRole("button", { name: "发送", exact: true }).click();
  const request = {
    threadId,
    id: reportId,
    text: `@devs ${draft.summary}\n\n${draft.details}`,
    verbatim: true,
  };
  await vi.waitFor(() => expect(server.submitDevsReport).toHaveBeenCalledWith(request));
  expect(server.prepareDevsReport).toHaveBeenLastCalledWith(request);
  await expect.element(screen.getByText("已发送给 Moss 开发者", { exact: false })).toBeVisible();
  expect(screen.getByRole("button", { name: "查看报告" }).query()).toBeNull();
});

it("stays sent after the chat is opened again", async () => {
  installServer(true);
  const screen = await mount();
  await expect.element(screen.getByText("已发送给 Moss 开发者", { exact: false })).toBeVisible();
  expect(screen.getByRole("button", { name: "查看报告" }).query()).toBeNull();
});

it("offers nothing to send where no Moss server can take it", async () => {
  installServer();
  const screen = await render(<DevsReportDraftCard draft={draft} threadId={undefined} />);
  await expect
    .element(screen.getByText("Drafted for the Moss developers", { exact: false }))
    .toBeVisible();
  expect(screen.getByRole("button").query()).toBeNull();
});
