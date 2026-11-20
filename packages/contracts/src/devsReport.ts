import { Schema } from "effect";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const DevsEngine = Schema.Literals(["claude", "codex"]);
export type DevsEngine = typeof DevsEngine.Type;
export const DevsReportId = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i));
/**
 * A composer image or text file the person chose to send with a report. Images are
 * re-encoded in the app first (which drops their metadata); the server enforces the byte
 * limits in `@moss/shared/devsReport`.
 */
export const DevsReportAttachmentInput = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(300)),
  kind: Schema.Literals(["image", "text"]),
  mimeType: Schema.Literals(["image/jpeg", "image/webp", "image/png", "text/plain"]),
  dataBase64: Schema.String.check(Schema.isMaxLength(600_000)),
});
export type DevsReportAttachmentInput = typeof DevsReportAttachmentInput.Type;
export const DevsReportSubmitInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  /** App-level feedback uses real allowlisted facts without creating a chat. */
  feedbackContext: Schema.optional(
    Schema.Struct({
      appVersion: Schema.String.check(Schema.isMaxLength(100)),
      platform: Schema.String.check(Schema.isMaxLength(200)),
      language: Schema.String.check(Schema.isMaxLength(100)),
      category: Schema.NullOr(
        Schema.Literals(["bug", "session", "ui", "performance", "idea", "other"]),
      ),
      provider: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
      model: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
    }),
  ),
  id: DevsReportId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(5_000)),
  engine: Schema.optional(DevsEngine),
  /**
   * The text after `@devs` is the description exactly as written, with no engine word to
   * read: an agent's draft that starts "Codex …" names the problem, not the engine.
   */
  verbatim: Schema.optional(Schema.Boolean),
  /** Sent with prepare only; submit sends exactly what prepare kept for this ID. */
  attachments: Schema.optional(
    Schema.Array(DevsReportAttachmentInput).check(Schema.isMaxLength(8)),
  ),
});
export type DevsReportSubmitInput = typeof DevsReportSubmitInput.Type;
export const DevsReportAttachmentPreview = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["image", "text"]),
  sizeBytes: Schema.Number,
  /** For text files: the redacted text that will be sent. */
  text: Schema.optional(Schema.String),
});
export type DevsReportAttachmentPreview = typeof DevsReportAttachmentPreview.Type;
/** Exactly what a report will send, for the user to confirm first. */
export const DevsReportPreview = Schema.Struct({
  scope: Schema.optional(Schema.Literals(["application", "thread"])),
  id: DevsReportId,
  engine: DevsEngine,
  description: Schema.String,
  context: Schema.String,
  /** Signed in with a mainland China phone number; the report is processed outside it. */
  processedOutsideMainlandChina: Schema.Boolean,
  attachments: Schema.optional(Schema.Array(DevsReportAttachmentPreview)),
});
export type DevsReportPreview = typeof DevsReportPreview.Type;
/** One chat's reports, or reports picked by ID (app feedback and agent notes have no chat). */
export const DevsReportListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  reportIds: Schema.optional(Schema.Array(DevsReportId).check(Schema.isMaxLength(200))),
});
export type DevsReportListInput = typeof DevsReportListInput.Type;
export const DevsReportState = Schema.Struct({
  id: DevsReportId,
  threadId: Schema.NullOr(ThreadId),
  engine: DevsEngine,
  status: Schema.Literals(["queued", "running", "pull-request", "failed"]),
  description: Schema.String,
  message: Schema.String,
  pullRequestUrl: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The developer service has acknowledged the report (absent on older servers). */
  delivered: Schema.optional(Schema.Boolean),
  /** Attachments chosen for the report and how many the developer service has received. */
  attachments: Schema.optional(
    Schema.Struct({
      count: Schema.Number,
      delivered: Schema.Number,
      /** The report left the queue before every attachment arrived. */
      missed: Schema.Boolean,
    }),
  ),
});
export type DevsReportState = typeof DevsReportState.Type;
export const DevsReportListResult = Schema.Struct({
  configured: Schema.Boolean,
  reports: Schema.Array(DevsReportState),
});
export type DevsReportListResult = typeof DevsReportListResult.Type;

/**
 * `moss_draft_devs_report`: an agent drafts a report about a problem the person met. The
 * chat shows it as a card; nothing is sent until the person reviews and confirms it.
 */
export const DEVS_REPORT_DRAFT_TOOL_NAME = "moss_draft_devs_report";
export const DEVS_REPORT_DRAFT_ACTIVITY_KIND = "devs.report.drafted";
export const DEVS_REPORT_DRAFT_SUMMARY_MAX_LENGTH = 200;
export const DEVS_REPORT_DRAFT_DETAILS_MAX_LENGTH = 3_000;
export const DevsReportDraftId = Schema.String.check(Schema.isPattern(/^devs-draft:[0-9a-f]{32}$/));
export type DevsReportDraftId = typeof DevsReportDraftId.Type;
export const DevsReportDraftActivityPayload = Schema.Struct({
  draftId: DevsReportDraftId,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(DEVS_REPORT_DRAFT_SUMMARY_MAX_LENGTH)),
  details: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(DEVS_REPORT_DRAFT_DETAILS_MAX_LENGTH)),
  ),
});
export type DevsReportDraftActivityPayload = typeof DevsReportDraftActivityPayload.Type;
