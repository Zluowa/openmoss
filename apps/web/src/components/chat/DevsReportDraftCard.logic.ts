// FILE: DevsReportDraftCard.logic.ts
// Purpose: Turns a report an agent drafted with `moss_draft_devs_report` into the same
//          confirmed `@devs` request the composer sends, and sends it only after the
//          person confirms the exact preview.
// Layer: Chat transcript UI logic
// Exports: devsReportDraftReportId, devsReportDraftRequest, sendDevsReportDraft

import type {
  DevsReportDraftActivityPayload,
  DevsReportPreview,
  DevsReportSubmitInput,
  NativeApi,
  ThreadId,
} from "@moss/contracts";

/** The draft's own 32 hex digits in report-ID form: one draft is one report, retries included. */
export function devsReportDraftReportId(
  draftId: DevsReportDraftActivityPayload["draftId"],
): string {
  const hex = draftId.slice(draftId.indexOf(":") + 1);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** The agent's words exactly as written: a summary that starts "Codex …" names no engine. */
export function devsReportDraftRequest(
  threadId: ThreadId,
  draft: DevsReportDraftActivityPayload,
): DevsReportSubmitInput {
  return {
    threadId,
    id: devsReportDraftReportId(draft.draftId),
    text: ["@devs " + draft.summary, draft.details].filter(Boolean).join("\n\n"),
    verbatim: true,
  };
}

/** Nothing is sent unless the person confirms the preview the server built for this ID. */
export async function sendDevsReportDraft(input: {
  readonly server: Pick<NativeApi["server"], "prepareDevsReport" | "submitDevsReport">;
  readonly request: DevsReportSubmitInput;
  readonly confirm: (preview: DevsReportPreview) => Promise<boolean>;
}): Promise<"unsupported" | "cancelled" | "sent"> {
  const { prepareDevsReport, submitDevsReport } = input.server;
  if (!prepareDevsReport || !submitDevsReport) return "unsupported";
  const preview = await prepareDevsReport(input.request);
  if (!(await input.confirm(preview))) return "cancelled";
  await submitDevsReport(input.request);
  return "sent";
}
