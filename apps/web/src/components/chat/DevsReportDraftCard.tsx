// FILE: DevsReportDraftCard.tsx
// Purpose: The card an agent's `moss_draft_devs_report` call leaves in the chat: what went
//          wrong in the agent's words, and one action that opens the same review dialog as
//          `@devs`. Once sent it is one line; the report's progress shows with the chat's
//          other developer reports.
// Layer: Chat transcript UI

import type { DevsReportDraftActivityPayload, ThreadId } from "@moss/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { CheckIcon, FlagIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { isNativeApiDetached, readNativeApi } from "~/nativeApi";

import { requestDevsReportConfirmation } from "./devsReportConfirmStore";
import {
  devsReportDraftReportId,
  devsReportDraftRequest,
  sendDevsReportDraft,
} from "./DevsReportDraftCard.logic";
import {
  announceDevsReportFailure,
  announceDevsReportSent,
  DEVS_REPORT_CHANGED,
} from "./handleDevsReportSend";

/** Whether this draft's report already left, read again whenever a report is sent. */
function useDraftSent(reportId: string): boolean {
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const list = readNativeApi()?.server.listDevsReports;
      if (!list) return;
      try {
        const result = await list({ reportIds: [reportId] });
        if (!disposed && result.reports.some((report) => report.id === reportId)) setSent(true);
      } catch {
        /* Keep offering the draft while disconnected. */
      }
    };
    void refresh();
    const changed = () => void refresh();
    window.addEventListener(DEVS_REPORT_CHANGED, changed);
    return () => {
      disposed = true;
      window.removeEventListener(DEVS_REPORT_CHANGED, changed);
    };
  }, [reportId]);
  return sent;
}

export function DevsReportDraftCard(props: {
  readonly draft: DevsReportDraftActivityPayload;
  /** Absent where the transcript cannot send (no thread context): the card stays read-only. */
  readonly threadId: ThreadId | undefined;
  readonly textFontSizePx?: number | undefined;
  readonly metaFontSizePx?: number | undefined;
}) {
  const { draft, threadId } = props;
  const { t } = useTranslation();
  const sent = useDraftSent(devsReportDraftReportId(draft.draftId));
  const [sending, setSending] = useState(false);
  // A double click must not open two reviews.
  const inFlight = useRef(false);
  const metaStyle = props.metaFontSizePx ? { fontSize: `${props.metaFontSizePx}px` } : undefined;
  const textStyle = props.textFontSizePx ? { fontSize: `${props.textFontSizePx}px` } : undefined;

  // Without a Moss server behind the page (a guest's view) nothing could send it.
  if (sent || threadId === undefined || isNativeApiDetached()) {
    const Icon = sent ? CheckIcon : FlagIcon;
    return (
      <div
        className="flex min-w-0 items-center gap-2 text-[var(--color-text-foreground-secondary)]"
        style={metaStyle}
        data-devs-report-draft-state={sent ? "sent" : "read-only"}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {draft.summary} · {t(sent ? "devs.draft.sent" : "devs.draft.drafted")}
        </span>
      </div>
    );
  }

  const review = async () => {
    const server = readNativeApi()?.server;
    if (!server || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const result = await sendDevsReportDraft({
        server,
        request: devsReportDraftRequest(threadId, draft),
        confirm: (preview) => requestDevsReportConfirmation(preview),
      });
      if (result === "unsupported")
        toastManager.add({
          type: "error",
          title: t("devs.sendFailed"),
          description: t("devs.unsupported"),
        });
      if (result === "sent") announceDevsReportSent(t);
    } catch (error) {
      announceDevsReportFailure(t, error);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-card border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] p-3"
      aria-label={t("devs.draft.title")}
      data-devs-report-draft-state="pending"
    >
      <p
        className="flex min-w-0 items-center gap-1.5 text-[var(--color-text-foreground-secondary)]"
        style={metaStyle}
      >
        <FlagIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t("devs.draft.title")}</span>
      </p>
      <div className="min-w-0 space-y-0.5">
        <p
          className="whitespace-pre-wrap break-words text-chat text-[var(--color-text-foreground)]"
          style={textStyle}
        >
          {draft.summary}
        </p>
        {draft.details ? (
          <p
            className="line-clamp-4 whitespace-pre-wrap break-words text-chat text-[var(--color-text-foreground-secondary)]"
            style={textStyle}
          >
            {draft.details}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 text-[var(--color-text-foreground-secondary)]" style={metaStyle}>
          {t("devs.draft.note")}
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="shrink-0"
          disabled={sending}
          onClick={() => void review()}
        >
          {sending ? <Spinner className="size-4" aria-hidden /> : null}
          {t(sending ? "devs.draft.preparing" : "devs.draft.review")}
        </Button>
      </div>
    </section>
  );
}
