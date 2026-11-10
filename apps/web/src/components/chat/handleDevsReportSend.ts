import type { DevsReportPreview, NativeApi, ThreadId } from "@moss/contracts";
import { DEVS_CONSENT_REQUIRED_MESSAGE, parseDevsInvocation } from "@moss/shared/devsReport";
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

/**
 * A message that starts with `@devs` bypasses a broken/busy chat provider and never becomes a
 * provider turn. The server builds the exact report, the user confirms it, and only then is
 * it sent.
 */
export async function handleDevsReportSend(input: {
  locale: MossLocaleCode;
  text: string;
  threadId: ThreadId;
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
    const request = {
      threadId: input.threadId,
      id: input.requestRef.current.id,
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
    input.clear(preview.attachments?.length ? prepared.sentIds : []);
    input.requestRef.current = null;
    window.dispatchEvent(new Event(DEVS_REPORT_CHANGED));
    toastManager.add({ type: "success", title: t("devs.sent"), description: t("devs.sentDetail") });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    toastManager.add({
      type: "error",
      title: t("devs.sendFailed"),
      description: message.includes(DEVS_CONSENT_REQUIRED_MESSAGE)
        ? t("devs.consentRequired")
        : message || t("devs.sendFailedDetail"),
    });
    return false;
  } finally {
    inFlight.delete(input.threadId);
  }
}
