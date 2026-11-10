import "../index.css";
import type { DevsReportPreview, DevsReportSubmitInput, NativeApi } from "@moss/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MossLocaleScope } from "../localization";
import { FeedbackDialog } from "./FeedbackDialog";
import { DevsReportConfirmDialog } from "./chat/DevsReportConfirmDialog";
import { settleDevsReportConfirmation } from "./chat/devsReportConfirmStore";
import type { FeedbackThreadContext } from "../feedback";

const context: FeedbackThreadContext = {
  provider: null,
  model: null,
  projectKind: null,
  environmentMode: null,
  runtimeMode: null,
  interactionMode: null,
  sessionStatus: null,
  latestTurnState: null,
  messageCount: 0,
  activityCount: 0,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasThreadError: false,
};
afterEach(() => {
  settleDevsReportConfirmation(false);
  cleanup();
  vi.unstubAllGlobals();
});

it("previews app feedback, preserves cancelled text, and queues only after confirmation", async () => {
  const prepare = vi.fn(
    async (input: DevsReportSubmitInput): Promise<DevsReportPreview> => ({
      id: input.id,
      scope: "application",
      engine: "codex",
      description: "侧栏文字折行",
      context: "App version: test\nPlatform: Win32",
      processedOutsideMainlandChina: false,
    }),
  );
  const submit = vi.fn(async () => ({ delivered: false }));
  vi.stubGlobal("nativeApi", {
    server: { prepareDevsReport: prepare, submitDevsReport: submit },
  } as unknown as NativeApi);
  await page.viewport(1100, 780);
  const close = vi.fn();
  const view = await render(
    <MossLocaleScope locale="zh-CN">
      <FeedbackDialog open context={context} onOpenChange={close} />
      <DevsReportConfirmDialog />
    </MossLocaleScope>,
  );
  const textarea = page.getByRole("textbox");
  await userEvent.fill(textarea, "侧栏文字折行");
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect
    .element(page.getByTestId("devs-report-description"))
    .toHaveTextContent("侧栏文字折行");
  expect(prepare.mock.calls[0]?.[0]).not.toHaveProperty("threadId");
  expect(submit).not.toHaveBeenCalled();
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  await page.screenshot({ path: "../../../../output/playwright/feedback-confirm.png" });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.element(textarea).toHaveValue("侧栏文字折行");
  expect(close).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await page.getByRole("button", { name: "发送报告", exact: true }).click();
  expect(submit).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0]?.[0].id).toBe(prepare.mock.calls[1]?.[0].id);
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith(false));
  await view.unmount();
});

it("keeps the typed feedback when preparation fails", async () => {
  const prepare = vi.fn(async () => {
    throw new Error("offline");
  });
  const submit = vi.fn();
  vi.stubGlobal("nativeApi", {
    server: { prepareDevsReport: prepare, submitDevsReport: submit },
  } as unknown as NativeApi);
  await page.viewport(1100, 780);
  const close = vi.fn();
  const view = await render(
    <MossLocaleScope locale="zh-CN">
      <FeedbackDialog open context={context} onOpenChange={close} />
      <DevsReportConfirmDialog />
    </MossLocaleScope>,
  );
  const textarea = page.getByRole("textbox");
  await userEvent.fill(textarea, "请保留这条反馈");
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  await expect.element(textarea).toHaveValue("请保留这条反馈");
  await expect.element(page.getByRole("button", { name: "提交", exact: true })).toBeEnabled();
  expect(submit).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await view.unmount();
});
