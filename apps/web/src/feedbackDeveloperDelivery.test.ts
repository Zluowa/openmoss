// FILE: feedbackDeveloperDelivery.test.ts
// Purpose: Covers confirmation, retry IDs and privacy for app-level feedback.

import type { DevsReportPreview, NativeApi } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFeedbackDeveloperRequest,
  deliverFeedback,
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

  it("always previews and confirms when requireConfirmation is set, even with VITE_FEEDBACK_ENDPOINT", async () => {
    vi.stubEnv("VITE_FEEDBACK_ENDPOINT", "https://feedback.example.test/submit");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { api, prepare, submit, preview } = setup();
    vi.stubGlobal("window", { nativeApi: api });
    const submission = {
      category: "bug",
      details: "Claude 无法调用工具",
      diagnostics: {
        appVersion: "1.0.8",
        platform: "Win32",
        language: "zh-CN",
        provider: "claudeAgent",
        model: null,
      },
    } as unknown as FeedbackSubmission;

    const cancelled = await deliverFeedback({
      submission,
      developerRequest: () => buildFeedbackDeveloperRequest(submission, request.id),
      confirm: vi.fn(async (shown) => {
        expect(shown).toBe(preview);
        return false;
      }),
      requireConfirmation: true,
    });
    expect(cancelled).toBe("cancelled");
    expect(prepare).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const sent = await deliverFeedback({
      submission,
      developerRequest: () => buildFeedbackDeveloperRequest(submission, request.id),
      confirm: async () => true,
      requireConfirmation: true,
    });
    expect(sent).toBe("queued");
    expect(submit).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
