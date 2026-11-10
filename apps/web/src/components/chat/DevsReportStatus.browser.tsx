import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page } from "vitest/browser";
import {
  ThreadId,
  type NativeApi,
  type DevsReportPreview,
  type DevsReportState,
} from "@moss/contracts";
import { MossLocaleScope } from "../../localization";
import { DevsReportConfirmDialog } from "./DevsReportConfirmDialog";
import { DevsReportStatus } from "./DevsReportStatus";
import { requestDevsReportConfirmation } from "./devsReportConfirmStore";
import { DEVS_REPORT_CHANGED, handleDevsReportSend } from "./handleDevsReportSend";
import { prepareDevsReportAttachments } from "./devsReportAttachments";

const threadId = ThreadId.makeUnsafe("devs-chat");
const report: DevsReportState = {
  id: "1fe199a0-63b3-4f71-8613-99ae20098b4d",
  threadId,
  engine: "codex",
  status: "queued",
  description: "切换模型后对话卡住",
  message: "Queued",
  pullRequestUrl: null,
  createdAt: "2026-11-02T12:00:00.000Z",
  updatedAt: "2026-11-02T12:00:00.000Z",
};
const preview: DevsReportPreview = {
  id: report.id,
  engine: "codex",
  description: "切换模型后对话卡住，电话 <phone>",
  context: "Provider: codex\nModel: test-model\nSession status: error",
  processedOutsideMainlandChina: true,
};
const prepare = vi.fn(async () => preview);
const confirm = async () => true;
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});

it("submits once, keeps progress in the original chat, and displays a verified PR link", async () => {
  const reports: DevsReportState[] = [];
  const submit = vi.fn(async (_input: { threadId: ThreadId; engine?: string }) => {
    reports.push(report);
    return report;
  });
  const list = vi.fn(async () => ({ configured: true, reports: [...reports] }));
  const api = {
    server: { prepareDevsReport: prepare, submitDevsReport: submit, listDevsReports: list },
  } as unknown as NativeApi;
  vi.stubGlobal("nativeApi", api);
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <DevsReportStatus threadId={threadId} />
    </MossLocaleScope>,
  );
  const clear = vi.fn();
  const requestRef = { current: null };
  expect(
    await handleDevsReportSend({
      locale: "zh-CN",
      text: "@devs codex 切换模型后对话卡住",
      threadId,
      api,
      requestRef,
      clear,
      confirm,
    }),
  ).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ threadId, engine: "codex" });
  expect(clear).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByText("@devs · Codex · 已加入开发者队列", { exact: true }))
    .toBeVisible();
  reports[0] = { ...report, status: "running" };
  window.dispatchEvent(new Event(DEVS_REPORT_CHANGED));
  await expect.element(screen.getByText("@devs · Codex · 正在修复", { exact: true })).toBeVisible();
  reports[0] = {
    ...report,
    status: "pull-request",
    pullRequestUrl: "https://github.com/Zluowa/moss-synara/pull/99999",
  };
  window.dispatchEvent(new Event(DEVS_REPORT_CHANGED));
  const link = screen.getByRole("link", { name: "查看修复 PR" });
  await expect.element(link).toBeVisible();
  expect(link.element().getAttribute("href")).toBe(
    "https://github.com/Zluowa/moss-synara/pull/99999",
  );
  await page.screenshot({ path: "node_modules/.cache/devs-report-status.png" });
});

it("preserves a failed send and retries the same ID, while ordinary text is left for the chat provider", async () => {
  const ids: string[] = [];
  let fail = true;
  const submit = vi.fn(async (input: { id: string }) => {
    ids.push(input.id);
    if (fail) throw new Error("offline");
    return report;
  });
  const api = {
    server: { prepareDevsReport: prepare, submitDevsReport: submit },
  } as unknown as NativeApi;
  const clear = vi.fn();
  const requestRef = { current: null };
  const input = {
    locale: "en" as const,
    text: "@devs claude fix the window",
    threadId,
    api,
    requestRef,
    clear,
    confirm,
  };
  expect(await handleDevsReportSend({ ...input, text: "ordinary chat" })).toBeNull();
  expect(await handleDevsReportSend(input)).toBe(false);
  expect(clear).not.toHaveBeenCalled();
  fail = false;
  expect(await handleDevsReportSend(input)).toBe(true);
  expect(ids[0]).toBe(ids[1]);
  expect(clear).toHaveBeenCalledTimes(1);
});

it("does not let a response from a previously selected chat overwrite the active chat's receipts", async () => {
  let resolveOld:
    | ((value: { configured: boolean; reports: DevsReportState[] }) => void)
    | undefined;
  const list = vi.fn(({ threadId: requested }: { threadId: ThreadId }) =>
    requested === threadId
      ? new Promise<{ configured: boolean; reports: DevsReportState[] }>((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({ configured: true, reports: [] }),
  );
  vi.stubGlobal("nativeApi", { server: { listDevsReports: list } } as unknown as NativeApi);
  const screen = await render(<DevsReportStatus threadId={threadId} />);
  await vi.waitFor(() => expect(list).toHaveBeenCalled());
  await screen.rerender(<DevsReportStatus threadId={ThreadId.makeUnsafe("different")} />);
  resolveOld?.({ configured: true, reports: [report] });
  await expect.element(screen.getByRole("complementary")).not.toBeInTheDocument();
});

it("shows exactly what will be sent, says where it is processed, and sends only on confirmation", async () => {
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <DevsReportConfirmDialog />
    </MossLocaleScope>,
  );
  const cancelled = requestDevsReportConfirmation({
    ...preview,
    processedOutsideMainlandChina: false,
  });
  await expect.element(screen.getByTestId("devs-report-description")).toBeVisible();
  expect(screen.getByTestId("devs-report-outside-china").query()).toBeNull();
  await screen.getByRole("button", { name: "取消" }).click();
  expect(await cancelled).toBe(false);
  const confirmed = requestDevsReportConfirmation(preview);
  await expect
    .element(screen.getByTestId("devs-report-description"))
    .toHaveTextContent(preview.description);
  await expect
    .element(screen.getByTestId("devs-report-context"))
    .toHaveTextContent("Session status: error");
  await expect
    .element(screen.getByTestId("devs-report-outside-china"))
    .toHaveTextContent("中国大陆境外");
  await screen.getByRole("button", { name: "发送报告" }).click();
  expect(await confirmed).toBe(true);
});

// Copied to the round-3 feedback folder by hand; the browser may only write inside the project.
const SHOT_DIR = "node_modules/.cache/devs-report-shots";
const ownerDescription =
  "用户刚进来显示画布有问题，以及分享出去用户看不到可视化图表，以及对应的html那些点不开，应该点开和桌面端是一样的体验";

/** A screenshot-like image: flat panels, text-ish stripes and some noise, as a PNG file. */
async function screenshotFile(name: string, width: number, height: number, hue: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.fillStyle = `hsl(${hue} 30% 96%)`;
  context.fillRect(0, 0, width, height);
  context.fillStyle = `hsl(${hue} 60% 55%)`;
  context.fillRect(width * 0.05, height * 0.1, width * 0.4, height * 0.5);
  context.fillStyle = "#333";
  for (let row = 0; row < 30; row++)
    context.fillRect(
      width * 0.5,
      height * 0.1 + row * height * 0.025,
      width * (0.2 + (row % 5) * 0.05),
      4,
    );
  const noise = context.getImageData(0, height * 0.7, width, height * 0.3);
  for (let index = 0; index < noise.data.length; index += 4)
    noise.data[index] = Math.random() * 255;
  context.putImageData(noise, 0, height * 0.7);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new File([blob], name, { type: "image/png" });
}

it("re-encodes screenshots within the limit, keeps small text files and leaves other files behind", async () => {
  const large = await screenshotFile("big.png", 3840, 2160, 210);
  const prepared = await prepareDevsReportAttachments(
    [{ id: "i1", name: large.name, mimeType: large.type, sizeBytes: large.size, file: large }],
    [
      {
        id: "f1",
        name: "console.log",
        mimeType: "text/plain",
        sizeBytes: 20,
        file: new File(["TypeError: canvas\n"], "console.log", { type: "text/plain" }),
      },
      {
        id: "f2",
        name: "project.zip",
        mimeType: "application/zip",
        sizeBytes: 3,
        file: new File(["PK!"], "project.zip", { type: "application/zip" }),
      },
    ],
  );
  expect(prepared.sentIds).toEqual(["i1", "f1"]);
  expect(prepared.skipped).toEqual([{ name: "project.zip", reason: "type" }]);
  const image = prepared.attachments[0]!;
  expect(image.mimeType).toBe("image/webp");
  expect(atob(image.dataBase64).length).toBeLessThanOrEqual(400_000);
  const bitmap = await createImageBitmap(
    await (await fetch(`data:image/webp;base64,${image.dataBase64}`)).blob(),
  );
  expect(Math.max(bitmap.width, bitmap.height)).toBeLessThanOrEqual(1600);
  expect(prepared.attachments[1]).toMatchObject({ kind: "text", mimeType: "text/plain" });
});

it("shows the owner the screenshots going with the report before it is sent", async () => {
  const files = await Promise.all([
    screenshotFile("截图1.png", 1540, 885, 210),
    screenshotFile("截图2.png", 1540, 885, 30),
    screenshotFile("截图3.png", 1540, 885, 0),
  ]);
  const prepared = await prepareDevsReportAttachments(
    files.map((file, index) => ({
      id: `i${index}`,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    })),
    [],
  );
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <DevsReportConfirmDialog />
    </MossLocaleScope>,
  );
  const confirmed = requestDevsReportConfirmation(
    {
      ...preview,
      description: ownerDescription,
      context: "Provider: codex\nModel: gpt-6-luna\nSession status: ready",
      attachments: prepared.attachments.map((attachment) => ({
        name: attachment.name,
        kind: attachment.kind,
        sizeBytes: atob(attachment.dataBase64).length,
      })),
    },
    { imagePreviews: prepared.imagePreviews, skipped: [{ name: "项目.zip", reason: "type" }] },
  );
  await expect
    .element(screen.getByText("随报告发送的截图和文件（3）", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByTestId("devs-report-skipped")).toHaveTextContent("项目.zip");
  await page.screenshot({ path: `${SHOT_DIR}/round3-devs-0-confirm.png` });
  await screen.getByRole("button", { name: "发送报告" }).click();
  expect(await confirmed).toBe(true);
});

it("shows the real state as a report moves from sent to fixed or to a developer", async () => {
  const base: DevsReportState = {
    ...report,
    description: ownerDescription,
    delivered: true,
    attachments: { count: 3, delivered: 3, missed: false },
  };
  const states: [string, string, DevsReportState][] = [
    [
      "sending",
      "正在发送",
      { ...base, delivered: false, attachments: { count: 3, delivered: 0, missed: false } },
    ],
    ["received", "已收到", base],
    ["running", "正在修复", { ...base, status: "running" }],
    [
      "pull-request",
      "已提交修复",
      {
        ...base,
        status: "pull-request",
        pullRequestUrl: "https://github.com/Zluowa/moss-synara/pull/99999",
      },
    ],
    ["failed", "需要开发者人工处理", { ...base, status: "failed" }],
  ];
  let current = states[0]![2];
  vi.stubGlobal("nativeApi", {
    server: { listDevsReports: async () => ({ configured: true, reports: [current] }) },
  } as unknown as NativeApi);
  const screen = await render(
    <MossLocaleScope locale="zh-CN">
      <div style={{ width: 760, paddingTop: 12 }}>
        <DevsReportStatus threadId={threadId} />
      </div>
    </MossLocaleScope>,
  );
  for (const [index, [label, title, state]] of states.entries()) {
    current = state;
    window.dispatchEvent(new Event(DEVS_REPORT_CHANGED));
    await expect
      .element(screen.getByText(`@devs · Codex · ${title}`, { exact: true }))
      .toBeVisible();
    await screen
      .getByTestId("devs-report-card")
      .screenshot({ path: `${SHOT_DIR}/round3-devs-${index + 1}-${label}.png` });
  }
  await expect
    .element(screen.getByTestId("devs-report-attachments-status"))
    .toHaveTextContent("已附带 3 个截图或文件");
  // The stale line the owner saw after delivery is gone.
  expect(document.body.textContent).not.toContain("服务断线时会自动重试发送");
});
