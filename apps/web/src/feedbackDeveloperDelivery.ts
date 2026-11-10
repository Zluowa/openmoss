// FILE: feedbackDeveloperDelivery.ts
// Purpose: Sends app feedback through the existing confirmed developer-report outbox.
// Layer: Web feedback delivery
// Exports: buildFeedbackDeveloperRequest, submitFeedbackToDevelopers

import type { DevsReportPreview, DevsReportSubmitInput, NativeApi } from "@moss/contracts";
import type { FeedbackSubmission } from "./feedback";

export function buildFeedbackDeveloperRequest(
  submission: FeedbackSubmission,
  id: string,
): DevsReportSubmitInput {
  const diagnostics = submission.diagnostics;
  return {
    id,
    text: `@devs ${submission.category ? `[${submission.category}] ` : ""}${submission.details}`,
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
