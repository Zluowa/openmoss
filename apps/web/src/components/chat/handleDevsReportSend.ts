import type {
  DevsReportPreview,
  DevsReportSubmitInput,
  NativeApi,
  ThreadId,
} from "@moss/contracts";
import { DEVS_CONSENT_REQUIRED_MESSAGE, parseDevsInvocation } from "@moss/shared/devsReport";
import { APP_VERSION } from "../../branding";
import { translateMoss } from "../../localization";
import type { MossLocaleCode } from "../../uiLocale";
import type { MutableRefObject } from "react";
import { toastManager } from "../ui/toast";
import {
  requestDevsReportConfirmation,
  type DevsReportLocalAttachments,
} from "./devsReportConfirmStore";
import { prepareDevsReportAttachments, type DevsAttachmentSource } from "./devsReportAttachments";

export const DEVS_REPORT_CHANGED = "moss:devs-report-changed";
const inFlight = new Set<string>();
const localDevsReportIdsByThreadId = new Map<ThreadId, string[]>();

/** Tracks report IDs submitted from unsent draft chats so their status card renders in place. */
export function recordLocalDevsReportId(threadId: ThreadId, reportId: string): void {
  const current = localDevsReportIdsByThreadId.get(threadId) ?? [];
  if (!current.includes(reportId)) {
    localDevsReportIdsByThreadId.set(threadId, [...current, reportId]);
  }
}

export function getLocalDevsReportIds(threadId: ThreadId): readonly string[] {
  return localDevsReportIdsByThreadId.get(threadId) ?? [];
}

export function clearLocalDevsReportIdsForTests(): void {
  localDevsReportIdsByThreadId.clear();
}

type DevsReportCopy = (
  key:
    | "devs.sent"
    | "devs.sentDetail"
    | "devs.sendFailed"
    | "devs.sendFailedDetail"
    | "devs.consentRequired",
) => string;

/** A report left the confirmation: the chat's report status refreshes and a toast says so. */
export function announceDevsReportSent(t: DevsReportCopy) {
  window.dispatchEvent(new Event(DEVS_REPORT_CHANGED));
  toastManager.add({ type: "success", title: t("devs.sent"), description: t("devs.sentDetail") });
}

/** One plain sentence for a report that was not queued; consent gets its own words. */
export function announceDevsReportFailure(t: DevsReportCopy, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  toastManager.add({
    type: "error",
    title: t("devs.sendFailed"),
    description: message.includes(DEVS_CONSENT_REQUIRED_MESSAGE)
      ? t("devs.consentRequired")
      : message || t("devs.sendFailedDetail"),
  });
}

/**
 * A message that starts with `@devs` bypasses a broken/busy chat provider and never becomes a
 * provider turn. The server builds the exact report, the user confirms it, and only then is
 * it sent.
 */
export async function handleDevsReportSend(input: {
  locale: MossLocaleCode;
  text: string;
  threadId: ThreadId;
  isServerThread?: boolean;
  feedbackContext?: DevsReportSubmitInput["feedbackContext"];
  api: NativeApi | null | undefined;
  requestRef: MutableRefObject<{
    text: string;
    id: string;
    threadId: ThreadId;
    attachmentKey?: string;
  } | null>;
  /** Clears the composer; receives the composer attachment IDs that went with the report. */
  clear: (sentAttachmentIds: readonly string[]) => void;
  /** The composer's images and files; images and small text files go with the report. */
  images?: readonly DevsAttachmentSource[];
  files?: readonly DevsAttachmentSource[];
  confirm?: (preview: DevsReportPreview, local: DevsReportLocalAttachments) => Promise<boolean>;
}): Promise<boolean | null> {
  const t = (key: Parameters<typeof translateMoss>[1]) => translateMoss(input.locale, key);
  const invocation = parseDevsInvocation(input.text);
  if (!invocation) return null;
  if (inFlight.has(input.threadId)) return false;
  const attachmentKey = [...(input.images ?? []), ...(input.files ?? [])]
    .map((attachment) => attachment.id)
    .join(",");
  if (
    !input.requestRef.current ||
    input.requestRef.current.text !== input.text ||
    input.requestRef.current.threadId !== input.threadId ||
    (input.requestRef.current.attachmentKey ?? "") !== attachmentKey
  ) {
    input.requestRef.current = {
      text: input.text,
      threadId: input.threadId,
      id: crypto.randomUUID(),
      attachmentKey,
    };
  }
  inFlight.add(input.threadId);
  try {
    if (!invocation.description) throw new Error(t("devs.missingDescription"));
    const server = input.api?.server;
    if (!server?.prepareDevsReport || !server.submitDevsReport)
      throw new Error(t("devs.unsupported"));
    const isDraftChat = input.isServerThread === false;
    const reportId = input.requestRef.current.id;
    const request: DevsReportSubmitInput = isDraftChat
      ? {
          id: reportId,
          text: `@devs ${invocation.description}`,
          ...(invocation.engine ? { engine: invocation.engine } : {}),
          feedbackContext: input.feedbackContext ?? {
            appVersion: APP_VERSION,
            platform:
              typeof navigator !== "undefined" && navigator.platform
                ? navigator.platform
                : "desktop",
            language: input.locale,
            category: "bug",
            provider: null,
            model: null,
          },
        }
      : {
          threadId: input.threadId,
          id: reportId,
          text: input.text,
          ...(invocation.engine ? { engine: invocation.engine } : {}),
        };
    const prepared = await prepareDevsReportAttachments(input.images ?? [], input.files ?? []);
    const preview = await server.prepareDevsReport({
      ...request,
      ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
    });
    // An older server ignores attachments; never show thumbnails it will not send.
    const local: DevsReportLocalAttachments = preview.attachments?.length
      ? { imagePreviews: prepared.imagePreviews, skipped: prepared.skipped }
      : {
          imagePreviews: [],
          skipped: [
            ...prepared.attachments.map((attachment) => ({
              name: attachment.name,
              reason: "type" as const,
            })),
            ...prepared.skipped,
          ],
        };
    // Cancelling keeps the message and its attachments in the composer and sends nothing.
    if (!(await (input.confirm ?? requestDevsReportConfirmation)(preview, local))) return false;
    // Submit sends exactly what prepare kept for this ID; the bytes are not sent again.
    await server.submitDevsReport(request);
    if (isDraftChat) recordLocalDevsReportId(input.threadId, reportId);
    input.clear(preview.attachments?.length ? prepared.sentIds : []);
    input.requestRef.current = null;
    announceDevsReportSent(t);
    return true;
  } catch (error) {
    announceDevsReportFailure(t, error);
    return false;
  } finally {
    inFlight.delete(input.threadId);
  }
}
