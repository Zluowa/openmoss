// FILE: feedbackDeveloperDelivery.ts
// Purpose: Sends app feedback through the existing confirmed developer-report outbox.
// Layer: Web feedback delivery
// Exports: buildFeedbackDeveloperRequest, submitFeedbackToDevelopers, deliverFeedback

import type { DevsReportPreview, DevsReportSubmitInput, NativeApi } from "@moss/contracts";
import { isFeedbackDeliveryConfigured, submitFeedback, type FeedbackSubmission } from "./feedback";
import { readNativeApi } from "./nativeApi";

export function buildFeedbackDeveloperRequest(
  submission: FeedbackSubmission,
  id: string,
): DevsReportSubmitInput {
  const diagnostics = submission.diagnostics;
  return {
    id,
    // The category travels in feedbackContext, so the text the person previews is only theirs.
    text: `@devs ${submission.details}`,
    feedbackContext: {
      appVersion: diagnostics.appVersion,
      platform: diagnostics.platform,
      language: diagnostics.language,
      category: submission.category,
      provider: diagnostics.provider,
      model: diagnostics.model,
    },
  };
}

export async function submitFeedbackToDevelopers(
  input: DevsReportSubmitInput,
  api: NativeApi,
  confirm: (preview: DevsReportPreview) => Promise<boolean>,
): Promise<"cancelled" | "queued" | "delivered"> {
  if (!api.server.prepareDevsReport || !api.server.submitDevsReport) {
    throw new Error("The Moss developer service is not connected yet.");
  }
  const preview = await api.server.prepareDevsReport(input);
  if (!(await confirm(preview))) return "cancelled";
  const report = await api.server.submitDevsReport(input);
  return report.delivered ? "delivered" : "queued";
}

/**
 * Sends one piece of feedback the way this build delivers it: to the feedback endpoint when
 * one is configured (unless `requireConfirmation` is set, as for agent-authored notes that
 * always preview, enforce privacy consent, show any mainland-China transfer notice, and
 * keep a local `DevsReport` for progress tracking), otherwise through the developer outbox
 * after the person confirms the preview. `developerRequest` is called only on the outbox
 * path, so callers can keep its ID stable across retries.
 */
export async function deliverFeedback(input: {
  readonly submission: FeedbackSubmission;
  readonly developerRequest: () => DevsReportSubmitInput;
  readonly confirm: (preview: DevsReportPreview) => Promise<boolean>;
  readonly requireConfirmation?: boolean;
}): Promise<"cancelled" | "queued" | "delivered"> {
  if (!input.requireConfirmation && isFeedbackDeliveryConfigured()) {
    await submitFeedback(input.submission);
    return "delivered";
  }
  const api = readNativeApi();
  if (!api) throw new Error("The Moss developer service is not connected yet.");
  return submitFeedbackToDevelopers(input.developerRequest(), api, input.confirm);
}
