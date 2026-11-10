// FILE: feedbackDeveloperDelivery.test.ts
// Purpose: Covers confirmation, retry IDs and privacy for app-level feedback.

import type { DevsReportPreview, NativeApi } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  buildFeedbackDeveloperRequest,
  submitFeedbackToDevelopers,
} from "./feedbackDeveloperDelivery";
import type { FeedbackSubmission } from "./feedback";

const request = buildFeedbackDeveloperRequest(
  {
    category: "ui",
    details: "Sidebar wraps",
    diagnostics: {
      appVersion: "test",
      platform: "Win32",
      language: "zh-CN",
      provider: "codex",
      model: "test",
      userAgent: "not included",
      projectPath: "not included",
    },
  } as unknown as FeedbackSubmission,
  "00000000-0000-4000-8000-000000000001",
);

function setup() {
  const preview = {
    id: request.id,
    description: "Sidebar wraps",
    context: "App version: test",
    engine: "codex",
    processedOutsideMainlandChina: false,
  } as DevsReportPreview;
  const prepare = vi.fn(async () => preview);
  const submit = vi.fn(async () => ({ delivered: false }));
  const api = {
    server: { prepareDevsReport: prepare, submitDevsReport: submit },
  } as unknown as NativeApi;
  return { api, prepare, submit, preview };
}

describe("developer feedback delivery", () => {
  it("sends only app facts without manufacturing a thread", () => {
    expect(request).not.toHaveProperty("threadId");
    expect(request.feedbackContext).not.toHaveProperty("userAgent");
    expect(request.feedbackContext).not.toHaveProperty("projectPath");
  });

  it("cancels without submitting and reuses the same request on retry", async () => {
    const { api, submit, preview } = setup();
    const confirm = vi.fn(async () => false);
    expect(await submitFeedbackToDevelopers(request, api, confirm)).toBe("cancelled");
    expect(confirm).toHaveBeenCalledWith(preview);
    expect(submit).not.toHaveBeenCalled();
    expect(await submitFeedbackToDevelopers(request, api, async () => true)).toBe("queued");
    expect(submit).toHaveBeenCalledWith(request);
  });

  it("keeps failure distinct from a saved report", async () => {
    const { api, submit } = setup();
    submit.mockRejectedValueOnce(new Error("offline"));
    await expect(submitFeedbackToDevelopers(request, api, async () => true)).rejects.toThrow(
      "offline",
    );
  });
});
