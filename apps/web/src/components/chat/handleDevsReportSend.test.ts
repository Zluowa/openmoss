import {
  ThreadId,
  type DevsReportPreview,
  type DevsReportSubmitInput,
  type NativeApi,
} from "@moss/contracts";
import { DEVS_CONSENT_REQUIRED_MESSAGE } from "@moss/shared/devsReport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { handleDevsReportSend } from "./handleDevsReportSend";

const threadId = ThreadId.makeUnsafe("chat");
const preview: DevsReportPreview = {
  id: "11111111-1111-4111-8111-111111111111",
  engine: "codex",
  description: "window froze",
  context: "Provider: codex",
  processedOutsideMainlandChina: false,
};

function setup(answer: boolean) {
  const prepareDevsReport = vi.fn(async (_input: DevsReportSubmitInput) => preview);
  const submitDevsReport = vi.fn(async (_input: DevsReportSubmitInput) => ({}) as never);
  const api = { server: { prepareDevsReport, submitDevsReport } } as unknown as NativeApi;
  const clear = vi.fn();
  const confirm = vi.fn(async () => answer);
  const send = (text: string) =>
    handleDevsReportSend({
      locale: "en",
      text,
      threadId,
      api,
      requestRef: { current: null },
      clear,
      confirm,
    });
  return { send, prepareDevsReport, submitDevsReport, clear, confirm };
}

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  mocks.toast.mockReset();
});

describe("sending a developer report", () => {
  it("leaves a message that only mentions @devs to the chat", async () => {
    const { send, prepareDevsReport } = setup(true);
    expect(await send("I asked @devs about this")).toBeNull();
    expect(prepareDevsReport).not.toHaveBeenCalled();
  });
  it("sends nothing and keeps the message when the user cancels the confirmation", async () => {
    const { send, prepareDevsReport, submitDevsReport, clear, confirm } = setup(false);
    expect(await send("@devs window froze")).toBe(false);
    expect(prepareDevsReport).toHaveBeenCalledTimes(1);
    // No composer attachments: the dialog gets no thumbnails and nothing skipped.
    expect(confirm).toHaveBeenCalledWith(preview, { imagePreviews: [], skipped: [] });
    expect(submitDevsReport).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
  it("sends the confirmed report with the same ID and text it previewed", async () => {
    const { send, prepareDevsReport, submitDevsReport, clear } = setup(true);
    expect(await send("@devs codex window froze")).toBe(true);
    expect(submitDevsReport).toHaveBeenCalledWith(prepareDevsReport.mock.calls[0]![0]);
    expect(submitDevsReport.mock.calls[0]![0]).toMatchObject({
      threadId,
      text: "@devs codex window froze",
      engine: "codex",
    });
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("explains the error-report setting when the server refuses for that reason", async () => {
    const { send, prepareDevsReport, submitDevsReport } = setup(true);
    prepareDevsReport.mockRejectedValueOnce(new Error(DEVS_CONSENT_REQUIRED_MESSAGE));
    expect(await send("@devs window froze")).toBe(false);
    expect(submitDevsReport).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("Send error reports") }),
    );
  });
});
